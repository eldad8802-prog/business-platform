/**
 * M6 — the OWNER side of acquisition connections (tenant context only: every call runs inside the
 * business's tenant transaction, so FORCE RLS confines it to that business's rows).
 *
 *   createKeyedConnection  Google lead form / website form: a new endpoint + a shared key shown ONCE
 *   rotateKey              a new key (the old one stops working immediately)
 *   setPaused              stop / resume accepting (the endpoint and key stay)
 *   revokeConnection       permanent: the endpoint and key die; the provider resource is freed
 *   bindMetaPage           a Facebook Page the owner authorized → this business (token encrypted)
 *   listConnections        a projection with NO hash, NO token, NO key
 *
 * Inbound requests never use this module — they resolve through ./resolve (definer lookups).
 */
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { ValidationError } from "@/lib/errors";
import { newPublicId, newSharedKey } from "./keys";
import { credentialAad, decryptCredential, encryptCredential } from "./credential-crypto";
import type { AcquisitionSourceKey } from "./gate";

export const MAX_CONNECTIONS_PER_SOURCE = 20;
export const MAX_ALLOWED_ORIGINS = 10;

export type ConnectionView = {
  id: number;
  sourceKey: string;
  status: string;
  publicId: string;
  label: string | null;
  externalResourceId: string | null;
  keyHint: string | null;
  allowedOrigins: string[];
  lastEventAt: Date | null;
  lastErrorCode: string | null;
  createdAt: Date;
  revokedAt: Date | null;
};

const VIEW = {
  id: true, sourceKey: true, status: true, publicId: true, label: true, externalResourceId: true, keyHint: true,
  allowedOrigins: true, lastEventAt: true, lastErrorCode: true, createdAt: true, revokedAt: true,
} as const;

/** Exact browser origins: https://host[:port] (http only for localhost). Anything else is refused. */
export function normalizeOrigins(raw: unknown): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new ValidationError("allowedOrigins must be a list");
  const out = new Set<string>();
  for (const r of raw) {
    if (typeof r !== "string") throw new ValidationError("an origin must be text");
    let u: URL;
    try {
      u = new URL(r.trim());
    } catch {
      throw new ValidationError("an origin must be a URL like https://example.co.il");
    }
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new ValidationError("an origin must use https");
    if (u.pathname !== "/" || u.search || u.hash || u.username || u.password) {
      throw new ValidationError("an origin is scheme + host (+ port) only");
    }
    out.add(u.origin);
  }
  if (out.size > MAX_ALLOWED_ORIGINS) throw new ValidationError(`at most ${MAX_ALLOWED_ORIGINS} origins`);
  return [...out];
}

function label(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") throw new ValidationError("label must be text");
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return s ? s.slice(0, 120) : null;
}

export async function listConnections(sourceKey?: AcquisitionSourceKey): Promise<ConnectionView[]> {
  return withTenantTransaction((tx) =>
    tx.acquisitionConnection.findMany({
      where: sourceKey ? { sourceKey } : {},
      select: VIEW,
      orderBy: { id: "asc" },
    })
  );
}

export async function createKeyedConnection(input: {
  businessId: number;
  userId: number | null;
  sourceKey: "google.lead_form" | "web.form";
  label?: unknown;
  allowedOrigins?: unknown;
}): Promise<{ connection: ConnectionView; key: string }> {
  const origins = input.sourceKey === "web.form" ? normalizeOrigins(input.allowedOrigins) : [];
  const k = newSharedKey(input.sourceKey);
  const connection = await withTenantTransaction(async (tx) => {
    const live = await tx.acquisitionConnection.count({ where: { sourceKey: input.sourceKey, status: { not: "REVOKED" } } });
    if (live >= MAX_CONNECTIONS_PER_SOURCE) throw new ValidationError("too many connections for this source");
    return tx.acquisitionConnection.create({
      data: {
        businessId: input.businessId,
        sourceKey: input.sourceKey,
        publicId: newPublicId(),
        label: label(input.label),
        keyHash: k.hash,
        keyHint: k.hint,
        allowedOrigins: origins,
        createdByUserId: input.userId,
      },
      select: VIEW,
    });
  });
  return { connection, key: k.key };
}

export async function rotateKey(id: number): Promise<{ connection: ConnectionView; key: string } | null> {
  return withTenantTransaction(async (tx) => {
    const row = await tx.acquisitionConnection.findFirst({ where: { id, status: { not: "REVOKED" } }, select: { sourceKey: true } });
    if (!row || (row.sourceKey !== "google.lead_form" && row.sourceKey !== "web.form")) return null;
    const k = newSharedKey(row.sourceKey);
    const connection = await tx.acquisitionConnection.update({ where: { id }, data: { keyHash: k.hash, keyHint: k.hint }, select: VIEW });
    return { connection, key: k.key };
  });
}

export async function setPaused(id: number, paused: boolean): Promise<ConnectionView | null> {
  return withTenantTransaction(async (tx) => {
    const row = await tx.acquisitionConnection.findFirst({ where: { id, status: { not: "REVOKED" } }, select: { id: true } });
    if (!row) return null;
    return tx.acquisitionConnection.update({
      where: { id },
      data: { status: paused ? "PAUSED" : "ACTIVE", ...(paused ? {} : { lastErrorCode: null }) },
      select: VIEW,
    });
  });
}

export async function setAllowedOrigins(id: number, raw: unknown): Promise<ConnectionView | null> {
  const origins = normalizeOrigins(raw);
  return withTenantTransaction(async (tx) => {
    const row = await tx.acquisitionConnection.findFirst({ where: { id, sourceKey: "web.form", status: { not: "REVOKED" } }, select: { id: true } });
    if (!row) return null;
    return tx.acquisitionConnection.update({ where: { id }, data: { allowedOrigins: origins }, select: VIEW });
  });
}

/** Permanent. The credential is wiped; the row stays as the audit of the binding. */
export async function revokeConnection(id: number, now = new Date()): Promise<ConnectionView | null> {
  return withTenantTransaction(async (tx) => {
    const row = await tx.acquisitionConnection.findFirst({ where: { id, status: { not: "REVOKED" } }, select: { id: true, sourceKey: true } });
    if (!row) return null;
    return tx.acquisitionConnection.update({
      where: { id },
      data: {
        status: "REVOKED",
        revokedAt: now,
        credentialCiphertext: null,
        credentialIv: null,
        credentialTag: null,
        credentialKeyId: null,
        credentialExpiresAt: null,
        // A revoked key can never match again (null fails the keyed lookup's equality).
        ...(row.sourceKey === "meta.lead_ads" ? {} : { keyHash: "0".repeat(64) }),
      },
      select: VIEW,
    });
  });
}

/**
 * Bind a Facebook Page the owner authorized (Facebook Login for Business) to this business.
 * The partial unique index refuses a Page that is live on another business.
 */
export async function bindMetaPage(input: {
  businessId: number;
  userId: number | null;
  pageId: string;
  pageName?: unknown;
  pageAccessToken: string;
}): Promise<ConnectionView> {
  if (!/^[0-9]{1,32}$/.test(input.pageId)) throw new ValidationError("invalid page id");
  const publicId = newPublicId();
  const enc = encryptCredential(input.pageAccessToken, credentialAad(input.businessId, "meta.lead_ads", publicId));
  return withTenantTransaction(async (tx) => {
    // Re-connecting the same Page for this business replaces the old binding.
    await tx.acquisitionConnection.updateMany({
      where: { sourceKey: "meta.lead_ads", externalResourceId: input.pageId, status: { not: "REVOKED" } },
      data: { status: "REVOKED", revokedAt: new Date(), credentialCiphertext: null, credentialIv: null, credentialTag: null, credentialKeyId: null },
    });
    return tx.acquisitionConnection.create({
      data: {
        businessId: input.businessId,
        sourceKey: "meta.lead_ads",
        publicId,
        externalResourceId: input.pageId,
        label: label(input.pageName),
        credentialCiphertext: enc.ciphertext,
        credentialIv: enc.iv,
        credentialTag: enc.tag,
        credentialKeyId: enc.keyId,
        createdByUserId: input.userId,
      },
      select: VIEW,
    });
  });
}

/**
 * The live Page token for a Meta Page (hydrate), by the Page id the receipt carries — so a Page the
 * owner reconnected after a token failure is picked up by the next retry. Null when none is live.
 */
export async function readMetaPageToken(
  businessId: number,
  pageId: string
): Promise<{ connectionId: number; token: string } | null> {
  const row = await withTenantTransaction((tx) =>
    tx.acquisitionConnection.findFirst({
      where: { sourceKey: "meta.lead_ads", externalResourceId: pageId, status: { in: ["ACTIVE", "ERROR"] } },
      orderBy: { id: "desc" },
      select: { id: true, publicId: true, credentialCiphertext: true, credentialIv: true, credentialTag: true, credentialKeyId: true },
    })
  );
  if (!row || !row.credentialCiphertext || !row.credentialIv || !row.credentialTag || !row.credentialKeyId) return null;
  const token = decryptCredential(
    { ciphertext: row.credentialCiphertext, iv: row.credentialIv, tag: row.credentialTag, keyId: row.credentialKeyId },
    credentialAad(businessId, "meta.lead_ads", row.publicId)
  );
  return { connectionId: row.id, token };
}

/** Meta said the token is no longer valid: the owner must reconnect (status ERROR, code recorded). */
export async function markConnectionError(connectionId: number, code: string): Promise<void> {
  await withTenantTransaction((tx) =>
    tx.acquisitionConnection.updateMany({
      where: { id: connectionId, status: "ACTIVE" },
      data: { status: "ERROR", lastErrorCode: code.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 64) },
    })
  );
}

/** Bookkeeping after an accepted delivery (non-personal). */
export async function touchConnection(connectionId: number, now = new Date()): Promise<void> {
  await withTenantTransaction((tx) =>
    tx.acquisitionConnection.updateMany({ where: { id: connectionId }, data: { lastEventAt: now } })
  );
}

