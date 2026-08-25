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
import { GmailReauthRequiredError } from "./gmail-errors";

export type GmailAttachmentMetadata = {
  messageId: string;
  attachmentId: string;
  filename: string | null;
  mimeType: string;
  sizeBytes: number | null;
  fromEmail: string | null;
  subject: string | null;
  sentAt: string | null; // ISO string
};

type GmailMessageListResponse = {
  messages?: Array<{ id: string; threadId?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
};

type GmailMessageResponse = {
  id: string;
  threadId?: string;
  internalDate?: string; // ms since epoch (string)
  payload?: GmailMessagePart;
};

type GmailMessagePart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { attachmentId?: string; size?: number };
  parts?: GmailMessagePart[];
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

function collectAttachments(part: GmailMessagePart | undefined, acc: GmailMessagePart[] = []): GmailMessagePart[] {
  if (!part) return acc;

  const filename = String(part.filename || "");
  const attachmentId = part.body?.attachmentId;
  const mimeType = String(part.mimeType || "");

  if (attachmentId && (filename.length > 0 || mimeType)) {
    acc.push(part);
  }

  for (const p of part.parts || []) {
    collectAttachments(p, acc);
  }

  return acc;
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

export async function discoverGmailAttachments(params: {
  businessId: number;
  connectionId?: number;
  maxMessages?: number;
  query?: string;
}): Promise<{
  scannedMessages: number;
  foundAttachments: number;
  attachments: GmailAttachmentMetadata[];
}> {
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

  const maxMessages = Math.min(Math.max(params.maxMessages ?? 30, 1), 100);
  const q = params.query || "has:attachment newer_than:30d";

  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("q", q);
  listUrl.searchParams.set("maxResults", String(maxMessages));

  const list = await gmailFetchJson<GmailMessageListResponse>(listUrl.toString(), effectiveAccessToken);
  const messageIds = (list.messages || []).map((m) => m.id).filter(Boolean);

  const attachments: GmailAttachmentMetadata[] = [];

  for (const messageId of messageIds) {
    const msgUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`);
    msgUrl.searchParams.set("format", "full");

    const msg = await gmailFetchJson<GmailMessageResponse>(msgUrl.toString(), effectiveAccessToken);

    const topHeaders = msg.payload?.headers || [];
    const fromEmail = extractEmailAddress(headerValue(topHeaders, "From"));
    const subject = headerValue(topHeaders, "Subject");
    const dateHeader = headerValue(topHeaders, "Date");
    const sentAt = parseSentAtIso({ dateHeader, internalDate: msg.internalDate });

    const parts = collectAttachments(msg.payload);

    for (const p of parts) {
      const attachmentId = p.body?.attachmentId;
      if (!attachmentId) continue;

      const mimeType = String(p.mimeType || "application/octet-stream");
      const filename = p.filename ? String(p.filename) : null;
      const sizeBytes = typeof p.body?.size === "number" ? p.body.size : null;

      // Only PDF/images in discovery results (same MVP definition).
      const isPdf = mimeType === "application/pdf";
      const isImage = mimeType.startsWith("image/");
      if (!isPdf && !isImage) continue;

      attachments.push({
        messageId,
        attachmentId,
        filename,
        mimeType,
        sizeBytes,
        fromEmail,
        subject,
        sentAt,
      });
    }
  }

  return {
    scannedMessages: messageIds.length,
    foundAttachments: attachments.length,
    attachments,
  };
}

