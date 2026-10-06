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
import { newPublicId, newSharedKey, newSigningSecret } from "./keys";
import { credentialAad, decryptCredential, encryptCredential } from "./credential-crypto";
import type { ConnectionSourceKey } from "./gate";

export const MAX_CONNECTIONS_PER_SOURCE = 20;
/** Sources that authenticate with a shared key whose sha256 is stored (keyHash). */
const KEYED_SOURCES = new Set<string>(["google.lead_form", "web.form", "telephony.voicenter"]);
/** Sources whose provider-side reference on a receipt is the provider resource, not the endpoint. */
const RESOURCE_REF_SOURCES = new Set<string>(["meta.lead_ads", "commerce.wix"]);
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
    // An owner types "my-site.co.il" or "www.my-site.co.il"; visitors arrive on either. The www /
    // bare twin of the same https site is allowed with it (never for localhost or an IP address).
    if (u.protocol === "https:" && !local && !/^[\d.]+$/.test(u.hostname) && u.hostname.includes(".")) {
      const twin = new URL(u.origin);
      twin.hostname = u.hostname.startsWith("www.") ? u.hostname.slice(4) : `www.${u.hostname}`;
      if (twin.hostname.includes(".")) out.add(twin.origin);
    }
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

export async function listConnections(sourceKey?: ConnectionSourceKey): Promise<ConnectionView[]> {
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
  sourceKey: "google.lead_form" | "web.form" | "telephony.voicenter";
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
    if (!row || (row.sourceKey !== "google.lead_form" && row.sourceKey !== "web.form" && row.sourceKey !== "telephony.voicenter")) return null;
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
        ...(KEYED_SOURCES.has(row.sourceKey) ? { keyHash: "0".repeat(64) } : {}),
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
  /** When Meta says the Page token expires; null = it does not (a long-lived Page token). */
  credentialExpiresAt?: Date | null;
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
        credentialExpiresAt: input.credentialExpiresAt ?? null,
        createdByUserId: input.userId,
      },
      select: VIEW,
    });
  });
}

// ── M7-A — commerce / telephony connections (owner side; provider routes and UI arrive in M7-B/C) ──

/** Sources that authenticate a delivery with a SIGNATURE Dubiz must verify (the secret is stored encrypted). */
export const SIGNED_SOURCES = ["commerce.woocommerce", "commerce.wix", "telephony.cloudtalk"] as const;
export type SignedSourceKey = (typeof SIGNED_SOURCES)[number];

/** The encrypted credential bundle of a signed connection. Never returned to a browser, never logged. */
export type ConnectionSecrets = { signingSecret: string } & Record<string, string>;

/**
 * Bind a signed source to this business. The signing secret is Dubiz's own (generated here) unless
 * the provider issues it (a CloudTalk / Svix endpoint secret); either way it is stored ENCRYPTED and
 * AAD-bound to the row. Wix binds by its app instance id (externalResourceId); the partial unique
 * index refuses a store / instance that is live on another business.
 */
export async function createSignedConnection(input: {
  businessId: number;
  userId: number | null;
  sourceKey: SignedSourceKey;
  label?: unknown;
  externalResourceId?: string | null;
  signingSecret?: string;
  extraSecrets?: Record<string, string>;
}): Promise<{ connection: ConnectionView; signingSecret: string }> {
  const resource = input.externalResourceId?.trim() || null;
  if (resource !== null && !/^[A-Za-z0-9_.:-]{1,64}$/.test(resource)) throw new ValidationError("invalid provider resource id");
  if (input.sourceKey === "commerce.wix" && resource === null) throw new ValidationError("a Wix connection needs its instance id");
  const signingSecret = input.signingSecret?.trim() || newSigningSecret();
  if (signingSecret.length < 16 || signingSecret.length > 256) throw new ValidationError("invalid signing secret");
  const publicId = newPublicId();
  const bundle: ConnectionSecrets = { ...(input.extraSecrets ?? {}), signingSecret };
  const enc = encryptCredential(JSON.stringify(bundle), credentialAad(input.businessId, input.sourceKey, publicId));
  const connection = await withTenantTransaction(async (tx) => {
    const live = await tx.acquisitionConnection.count({ where: { sourceKey: input.sourceKey, status: { not: "REVOKED" } } });
    if (live >= MAX_CONNECTIONS_PER_SOURCE) throw new ValidationError("too many connections for this source");
    return tx.acquisitionConnection.create({
      data: {
        businessId: input.businessId,
        sourceKey: input.sourceKey,
        publicId,
        externalResourceId: resource,
        label: label(input.label),
        credentialCiphertext: enc.ciphertext,
        credentialIv: enc.iv,
        credentialTag: enc.tag,
        credentialKeyId: enc.keyId,
        createdByUserId: input.userId,
      },
      select: VIEW,
    });
  });
  return { connection, signingSecret };
}

/**
 * The decrypted secrets of ONE live (ACTIVE) signed connection, inside the business's tenant context —
 * read only to verify a delivery's signature. The ciphertext never leaves this function; a
 * ciphertext moved to another row or business fails its AAD.
 */
export async function readConnectionSecrets(
  businessId: number,
  connectionId: number,
  opts: { anyLiveStatus?: boolean } = {}
): Promise<ConnectionSecrets | null> {
  const row = await withTenantTransaction((tx) =>
    tx.acquisitionConnection.findFirst({
      where: { id: connectionId, status: opts.anyLiveStatus ? { in: ["ACTIVE", "ERROR", "PAUSED"] } : "ACTIVE" },
      select: { sourceKey: true, publicId: true, credentialCiphertext: true, credentialIv: true, credentialTag: true, credentialKeyId: true },
    })
  );
  if (!row || !row.credentialCiphertext || !row.credentialIv || !row.credentialTag || !row.credentialKeyId) return null;
  const plain = decryptCredential(
    { ciphertext: row.credentialCiphertext, iv: row.credentialIv, tag: row.credentialTag, keyId: row.credentialKeyId },
    credentialAad(businessId, row.sourceKey, row.publicId)
  );
  const parsed = JSON.parse(plain) as ConnectionSecrets;
  return typeof parsed?.signingSecret === "string" ? parsed : null;
}

/**
 * Whether a receipt may still be acted on, by the provider reference it was accepted for (the
 * endpoint publicId; the Page id for Meta). "revoked" when no connection for that reference is
 * left un-revoked in THIS business — the owner revoked it, the Page moved to another business, or
 * the account is being erased. Paused is not revoked: what was accepted before a pause is processed.
 */
export async function connectionStateForRef(
  sourceKey: ConnectionSourceKey,
  accountRef: string | null
): Promise<"live" | "revoked"> {
  if (!accountRef) return "revoked";
  const where = RESOURCE_REF_SOURCES.has(sourceKey)
    ? { sourceKey, externalResourceId: accountRef, status: { not: "REVOKED" } }
    : { sourceKey, publicId: accountRef, status: { not: "REVOKED" } };
  const live = await withTenantTransaction((tx) => tx.acquisitionConnection.count({ where }));
  return live > 0 ? "live" : "revoked";
}

/**
 * The Page token for a Meta Page, by the Page id the receipt carries — so a Page the owner reconnected
 * after a token failure is picked up by the next retry. Any un-revoked connection answers: ACTIVE,
 * ERROR (a retry may succeed once Meta recovers), and PAUSED — what was accepted before a pause is
 * still processed, and disconnecting a paused Page must still unsubscribe it at Meta. Null when none.
 */
export async function readMetaPageToken(
  businessId: number,
  pageId: string
): Promise<{ connectionId: number; token: string } | null> {
  const row = await withTenantTransaction((tx) =>
    tx.acquisitionConnection.findFirst({
      where: { sourceKey: "meta.lead_ads", externalResourceId: pageId, status: { in: ["ACTIVE", "ERROR", "PAUSED"] } },
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

/**
 * M7-B / M7-C — the secrets of the un-revoked connection a receipt was accepted through (its endpoint publicId),
 * for a processing step that must call the provider (CloudTalk outcome lookup). Tenant context only.
 */
export async function readSecretsByPublicId(businessId: number, sourceKey: SignedSourceKey, publicId: string): Promise<ConnectionSecrets | null> {
  const row = await withTenantTransaction((tx) =>
    tx.acquisitionConnection.findFirst({ where: { sourceKey, publicId, status: { not: "REVOKED" } }, select: { id: true } })
  );
  return row ? readConnectionSecrets(businessId, row.id, { anyLiveStatus: true }) : null;
}

/** Replace a signed connection's secret bundle (owner action, or the provider state a poller keeps). */
export async function updateConnectionSecrets(businessId: number, connectionId: number, patch: Partial<ConnectionSecrets>): Promise<boolean> {
  const current = await readConnectionSecrets(businessId, connectionId, { anyLiveStatus: true });
  if (!current) return false;
  const next = { ...current, ...patch } as ConnectionSecrets;
  return withTenantTransaction(async (tx) => {
    const row = await tx.acquisitionConnection.findFirst({ where: { id: connectionId, status: { not: "REVOKED" } }, select: { sourceKey: true, publicId: true } });
    if (!row) return false;
    const enc = encryptCredential(JSON.stringify(next), credentialAad(businessId, row.sourceKey, row.publicId));
    const r = await tx.acquisitionConnection.updateMany({
      where: { id: connectionId, status: { not: "REVOKED" } },
      data: { credentialCiphertext: enc.ciphertext, credentialIv: enc.iv, credentialTag: enc.tag, credentialKeyId: enc.keyId },
    });
    return r.count === 1;
  });
}

/** A provider-side health problem the owner must see (status ERROR + a bounded code), or its recovery. */
export async function setConnectionHealth(connectionId: number, code: string | null): Promise<void> {
  await withTenantTransaction((tx) =>
    code
      ? tx.acquisitionConnection.updateMany({
          where: { id: connectionId, status: { in: ["ACTIVE", "ERROR"] } },
          data: { status: "ERROR", lastErrorCode: code.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 64) },
        })
      : tx.acquisitionConnection.updateMany({ where: { id: connectionId, status: "ERROR" }, data: { status: "ACTIVE", lastErrorCode: null } })
  );
}

/** The provider resource a signed connection belongs to, bound on its first verified delivery (CloudTalk company). */
export async function bindExternalResource(connectionId: number, resourceId: string): Promise<"bound" | "same" | "mismatch"> {
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(resourceId)) return "mismatch";
  return withTenantTransaction(async (tx) => {
    const row = await tx.acquisitionConnection.findFirst({ where: { id: connectionId, status: { not: "REVOKED" } }, select: { externalResourceId: true } });
    if (!row) return "mismatch";
    if (row.externalResourceId === resourceId) return "same";
    if (row.externalResourceId !== null) return "mismatch";
    await tx.acquisitionConnection.updateMany({ where: { id: connectionId, externalResourceId: null }, data: { externalResourceId: resourceId } });
    return "bound";
  });
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

