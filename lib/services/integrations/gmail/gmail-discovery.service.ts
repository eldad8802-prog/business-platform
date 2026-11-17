import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { getTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

// D2/P7-W4C: run a single DB step on a short tenant transaction when a tenant
// context is established (all Gmail routes set one); outside a context the
// step runs directly (pure unit tests). Under an established context there is
// NO fallback to the global client. External Google calls NEVER run inside.
async function dbStep<T>(
  fn: (db: Prisma.TransactionClient | typeof prisma) => Promise<T>
): Promise<T> {
  if (getTenantContext() !== undefined) {
    return withTenantTransaction((tx) => fn(tx));
  }
  return fn(prisma);
}
import {
  decryptToken,
  encryptToken,
  legacyRefreshTokenUpgrade,
} from "./token-crypto.placeholder";
import { refreshGoogleAccessToken } from "./oauth-refresh.service";
import { isAllowedDocumentMime } from "@/lib/services/documents/document-ingestion.service";
import {
  emptyRejectedTypeCounts,
  rejectedTypeGroup,
  REJECTED_TYPE_GROUPS,
  type RejectedTypeCounts,
} from "@/lib/services/email-import/rejected-types";
import { GMAIL_ROOT_PART_ID } from "@/lib/services/email-import/attachment-key";
import { GmailReauthRequiredError, GmailScanConnectionMismatchError } from "./gmail-errors";
import { scheduleConnectionDisconnected } from "@/lib/notifications/producers/connection-notifications";
import {
  collectAttachmentParts,
  type GmailMessagePart,
  type GmailMessageResponse,
} from "./gmail-message-parts";

export type GmailAttachmentMetadata = {
  messageId: string;
  attachmentId: string;
  filename: string | null;
  mimeType: string;
  sizeBytes: number | null;
  fromEmail: string | null;
  /** The sender's display name from the From header ("Vercel Inc."), when it has one. Display only. */
  fromName: string | null;
  subject: string | null;
  sentAt: string | null; // ISO string
  /** The part's position in the message tree; lets import re-find it. */
  partId: string | null;
};

type GmailMessageListResponse = {
  messages?: Array<{ id: string; threadId?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function headerValue(
  headers: Array<{ name: string; value: string }> | undefined,
  name: string
): string | null {
  const h = headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}

/**
 * The display-name part of a From header, or null: `"Vercel Inc." <billing@vercel.com>` → `Vercel Inc.`.
 * Null for a bare address, a name that is only the address again, or an encoded word Gmail left
 * undecoded (`=?utf-8?…`) — the screen then shows the address alone. Display text only; never
 * stored, logged or used to decide anything (B3-b, 2026-11-09).
 */
export function extractDisplayName(fromHeader: string | null): string | null {
  if (!fromHeader) return null;
  const lt = fromHeader.indexOf("<");
  if (lt <= 0) return null;
  let name = fromHeader.slice(0, lt).trim();
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
  name = name.replace(/\\(.)/g, "$1").replace(/\s+/g, " ").trim();
  if (!name || name.includes("=?") || name.includes("@")) return null;
  return name.length > 80 ? `${name.slice(0, 79)}…` : name;
}

function extractEmailAddress(fromHeader: string | null): string | null {
  if (!fromHeader) return null;
  const m = fromHeader.match(/<([^>]+)>/);
  if (m?.[1]) return m[1].trim();
  const raw = fromHeader.trim();
  return raw.includes("@") ? raw : null;
}

function parseSentAtIso(input: { dateHeader: string | null; internalDate: string | undefined }): string | null {
  if (input.dateHeader) {
    const ms = Date.parse(input.dateHeader);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  if (input.internalDate) {
    const ms = Number(input.internalDate);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
}

async function gmailFetchJson<T>(url: string, accessToken: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gmail API failed (${res.status}): ${text || res.statusText}`);
  }

  return (await res.json()) as T;
}

/**
 * One message's attachment parts → the attachments discovery offers, plus
 * counts of what it saw. Pure: the keep/drop decision is exactly the one the
 * scan always made; the counters only measure it (diagnostics, 2026-11-08).
 *
 * attachmentParts = parts carrying an attachment id;
 * unsupportedType = of those, refused by the Documents type allowlist;
 * attachments.length === attachmentParts - unsupportedType;
 * rejectedByType = the unsupported ones by declared-type group (sums to
 * unsupportedType; counting only, 2026-11-08 B1).
 *
 * `root` is the message's top-level payload. When that payload is itself the
 * attachment its partId is "" — no path — so it is reported as
 * GMAIL_ROOT_PART_ID instead of null, which import can resolve (B3-a).
 */
export function classifyAttachmentParts(
  parts: GmailMessagePart[],
  meta: {
    messageId: string;
    fromEmail: string | null;
    fromName?: string | null;
    subject: string | null;
    sentAt: string | null;
  },
  root?: GmailMessagePart
): {
  attachments: GmailAttachmentMetadata[];
  attachmentParts: number;
  unsupportedType: number;
  rejectedByType: RejectedTypeCounts;
} {
  const attachments: GmailAttachmentMetadata[] = [];
  let attachmentParts = 0;
  let unsupportedType = 0;
  const rejectedByType = emptyRejectedTypeCounts();

  for (const p of parts) {
    const attachmentId = p.body?.attachmentId;
    if (!attachmentId) continue;
    attachmentParts += 1;

    const mimeType = String(p.mimeType || "application/octet-stream");
    const filename = p.filename ? String(p.filename) : null;
    const sizeBytes = typeof p.body?.size === "number" ? p.body.size : null;

    // The canonical Documents allowlist, so discovery never advertises a
    // file the import endpoint would refuse. It used to be "PDF or any
    // image", which is wider than what Dubiz accepts.
    if (!isAllowedDocumentMime(mimeType)) {
      unsupportedType += 1;
      rejectedByType[rejectedTypeGroup(p.mimeType, filename)] += 1;
      continue;
    }

    attachments.push({
      messageId: meta.messageId,
      attachmentId,
      filename,
      mimeType,
      sizeBytes,
      fromEmail: meta.fromEmail,
      fromName: meta.fromName ?? null,
      subject: meta.subject,
      sentAt: meta.sentAt,
      partId: root !== undefined && p === root ? GMAIL_ROOT_PART_ID : p.partId ? String(p.partId) : null,
    });
  }

  return { attachments, attachmentParts, unsupportedType, rejectedByType };
}

/** One fetched message → its classified attachments (headers read once, root passed). */
export function classifyGmailMessage(messageId: string, msg: GmailMessageResponse) {
  const topHeaders = msg.payload?.headers || [];
  const fromHeader = headerValue(topHeaders, "From");
  const fromEmail = extractEmailAddress(fromHeader);
  const fromName = extractDisplayName(fromHeader);
  const subject = headerValue(topHeaders, "Subject");
  const dateHeader = headerValue(topHeaders, "Date");
  const sentAt = parseSentAtIso({ dateHeader, internalDate: msg.internalDate });

  const parts = collectAttachmentParts(msg.payload);
  return classifyAttachmentParts(parts, { messageId, fromEmail, fromName, subject, sentAt }, msg.payload);
}

/**
 * The tenant's connected Gmail account and a usable access token for it,
 * refreshing (and persisting) the token when it is about to expire. The DB
 * steps run on the tenant transaction; the Google call never runs inside one.
 */
export async function loadGmailAccess(params: {
  businessId: number;
  connectionId?: number;
  /** A scan cursor's account: any other resolved account is refused before Google is called. */
  expectConnectionId?: number;
}): Promise<{ connectionId: number; accessToken: string }> {
  const connection = await dbStep((db) => db.emailConnection.findFirst({
    where: {
      businessId: params.businessId,
      provider: "gmail",
      status: "connected",
      ...(params.connectionId ? { id: params.connectionId } : {}),
    },
    include: { token: true },
  }));

  if (!connection || !connection.token) {
    throw new GmailReauthRequiredError("no_connection");
  }
  if (params.expectConnectionId !== undefined && connection.id !== params.expectConnectionId) {
    throw new GmailScanConnectionMismatchError();
  }
  const tokenRow = connection.token;

  const accessToken = decryptToken(tokenRow.accessTokenEncrypted);
  const refreshToken = decryptToken(tokenRow.refreshTokenEncrypted);
  if (!accessToken) {
    throw new GmailReauthRequiredError(
      "token_undecryptable",
      "Missing/decrypt failed: access token"
    );
  }
  if (!refreshToken) {
    throw new GmailReauthRequiredError(
      "token_undecryptable",
      "Missing/decrypt failed: refresh token"
    );
  }

  const now = Date.now();
  const expiresMs = new Date(tokenRow.expiresAt).getTime();
  const needsRefresh = !Number.isFinite(expiresMs) || expiresMs <= now + 60_000;

  let effectiveAccessToken = accessToken;
  if (needsRefresh) {
    const refreshed = await refreshGoogleAccessToken({
      clientId: requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
      clientSecret: requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
      refreshToken,
      // Notifications side effect only (after the response, engine-gated); the refresh outcome is unchanged.
      onRevoked: () =>
        scheduleConnectionDisconnected({ businessId: params.businessId, provider: "gmail", connectionId: connection.id }),
    });

    const enc = encryptToken(refreshed.access_token);
    if (!enc) throw new Error("Failed to encrypt refreshed access token");

    const newExpiresAt = new Date(Date.now() + Math.max(0, refreshed.expires_in) * 1000);

    await dbStep((db) => db.oAuthToken.update({
      where: { connectionId: connection.id },
      data: {
        accessTokenEncrypted: enc.encrypted,
        expiresAt: newExpiresAt,
        tokenType: refreshed.token_type ?? tokenRow.tokenType,
        encryptionKeyId: enc.keyId,
        // Best-effort, fail-safe: upgrade a legacy plaintext (enc_v0) refresh
        // token to gcm_v1 in-place. Absent field => no upgrade; never blocks refresh.
        ...legacyRefreshTokenUpgrade(
          tokenRow.refreshTokenEncrypted,
          refreshToken
        ),
      },
    }));

    effectiveAccessToken = refreshed.access_token;
  }

  return { connectionId: connection.id, accessToken: effectiveAccessToken };
}

export async function discoverGmailAttachments(params: {
  businessId: number;
  connectionId?: number;
  maxMessages?: number;
  query?: string;
}): Promise<{
  scannedMessages: number;
  foundAttachments: number;
  attachmentParts: number;
  unsupportedType: number;
  rejectedByType: RejectedTypeCounts;
  attachments: GmailAttachmentMetadata[];
}> {
  const { accessToken: effectiveAccessToken } = await loadGmailAccess({
    businessId: params.businessId,
    connectionId: params.connectionId,
  });

  const maxMessages = Math.min(Math.max(params.maxMessages ?? 30, 1), 100);
  const q = params.query || "has:attachment newer_than:30d";

  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("q", q);
  listUrl.searchParams.set("maxResults", String(maxMessages));

  const list = await gmailFetchJson<GmailMessageListResponse>(listUrl.toString(), effectiveAccessToken);
  const messageIds = (list.messages || []).map((m) => m.id).filter(Boolean);

  const attachments: GmailAttachmentMetadata[] = [];
  let attachmentParts = 0;
  let unsupportedType = 0;
  const rejectedByType = emptyRejectedTypeCounts();

  for (const messageId of messageIds) {
    const msgUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`);
    msgUrl.searchParams.set("format", "full");

    const msg = await gmailFetchJson<GmailMessageResponse>(msgUrl.toString(), effectiveAccessToken);

    const classified = classifyGmailMessage(messageId, msg);
    attachments.push(...classified.attachments);
    attachmentParts += classified.attachmentParts;
    unsupportedType += classified.unsupportedType;
    for (const group of REJECTED_TYPE_GROUPS) {
      rejectedByType[group] += classified.rejectedByType[group];
    }
  }

  return {
    scannedMessages: messageIds.length,
    foundAttachments: attachments.length,
    attachmentParts,
    unsupportedType,
    rejectedByType,
    attachments,
  };
}

