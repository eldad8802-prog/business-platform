/**
 * Gmail OAuth token encryption at rest (AES-256-GCM).
 *
 * Storage formats (single DB column `*TokenEncrypted`):
 *   gcm_v2:<keyId>:<b64(iv)>.<b64(tag)>.<b64(ciphertext)>   — CURRENT (L-17)
 *       AAD = "dubiz/gmail-token/v2|biz=<businessId>|conn=<connectionId>|field=<access|refresh>|kid=<keyId>"
 *       The ciphertext is bound to the row and field it was written for: a blob
 *       copied to another business's / connection's row, or swapped between the
 *       access and refresh columns, fails authentication and decrypts to null.
 *   gcm_v1:<b64(iv)>.<b64(tag)>.<b64(ciphertext)>            — read-only (no AAD)
 *       Still decrypts (with the legacy key, id "k0"), so no existing
 *       connection breaks. Re-encrypted to v2 on the next token write/refresh.
 *   enc_v0:<base64(plaintext)>                               — QUARANTINED
 *       Plaintext, not encryption. decryptToken() refuses it (returns null), so
 *       callers treat the connection as needing reconnect. The only decode path
 *       left is {@link decryptTokenForRevocation}, used to revoke the grant at
 *       Google when the owner disconnects.
 *
 * Keys and rotation:
 *   GMAIL_TOKEN_ENCRYPTION_KEY           legacy single key, id "k0" (gcm_v1 + v2)
 *   GMAIL_TOKEN_ENCRYPTION_KEYS          optional keyring "k1:<b64|hex>,k2:<…>"
 *   GMAIL_TOKEN_ENCRYPTION_ACTIVE_KEY_ID optional; id used for NEW v2 writes
 *                                        (default "k0", else the only ring key)
 *   Rotation = add a new id to the ring, point ACTIVE at it, deploy; every
 *   refresh re-encrypts that row under the new id; once no row carries the old
 *   id (encryptionKeyId column / blob prefix), remove it from the ring.
 * New encryption fails closed when the active key is missing or invalid.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm" as const;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENV_KEY_NAME = "GMAIL_TOKEN_ENCRYPTION_KEY";
const ENV_KEYRING_NAME = "GMAIL_TOKEN_ENCRYPTION_KEYS";
const ENV_ACTIVE_KEY_ID = "GMAIL_TOKEN_ENCRYPTION_ACTIVE_KEY_ID";
const LEGACY_KEY_ID = "k0";
const LEGACY_PREFIX = "enc_v0:";
const GCM_V1_PREFIX = "gcm_v1:";
const GCM_V2_PREFIX = "gcm_v2:";
const KEY_ID_RE = /^[a-z0-9_-]{1,32}$/;

export type EncryptedToken = {
  encrypted: string;
  /** Stored in OAuthToken.encryptionKeyId: "gcm_v2:<keyId>". */
  keyId: string;
};

/** Which row + column a token blob belongs to (the v2 AAD). */
export type GmailTokenContext = {
  businessId: number;
  connectionId: number;
  field: "access" | "refresh";
};

export class GmailTokenCryptoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailTokenCryptoConfigError";
  }
}

function parseKeyMaterial(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, "hex");
  } else {
    try {
      key = Buffer.from(trimmed, "base64");
    } catch {
      return null;
    }
  }
  return key.length === KEY_BYTES ? key : null;
}

/** keyId → key. Invalid ring entries are ignored (never half-parsed). */
function loadKeyring(): Map<string, Buffer> {
  const ring = new Map<string, Buffer>();
  const legacy = process.env[ENV_KEY_NAME];
  if (typeof legacy === "string") {
    const key = parseKeyMaterial(legacy);
    if (key) ring.set(LEGACY_KEY_ID, key);
  }
  const raw = process.env[ENV_KEYRING_NAME];
  if (typeof raw === "string" && raw.trim()) {
    for (const part of raw.split(",")) {
      const idx = part.indexOf(":");
      if (idx <= 0) continue;
      const id = part.slice(0, idx).trim();
      if (!KEY_ID_RE.test(id) || id === LEGACY_KEY_ID) continue;
      const key = parseKeyMaterial(part.slice(idx + 1));
      if (key) ring.set(id, key);
    }
  }
  return ring;
}

function activeKey(): { id: string; key: Buffer } | null {
  const ring = loadKeyring();
  const configured = process.env[ENV_ACTIVE_KEY_ID]?.trim();
  if (configured) {
    const key = ring.get(configured);
    return key ? { id: configured, key } : null;
  }
  const legacy = ring.get(LEGACY_KEY_ID);
  if (legacy) return { id: LEGACY_KEY_ID, key: legacy };
  if (ring.size === 1) {
    const [[id, key]] = [...ring.entries()];
    return { id, key };
  }
  return null;
}

function requireActiveKey(): { id: string; key: Buffer } {
  const active = activeKey();
  if (!active) {
    throw new GmailTokenCryptoConfigError(
      process.env.NODE_ENV === "production"
        ? `${ENV_KEY_NAME} is not configured`
        : `${ENV_KEY_NAME} is not configured. Set a 32-byte key (hex or base64) in .env.local.`
    );
  }
  return active;
}

function assertContext(ctx: GmailTokenContext): void {
  if (!ctx || !Number.isInteger(ctx.businessId) || ctx.businessId <= 0) {
    throw new GmailTokenCryptoConfigError("token context: invalid businessId");
  }
  if (!Number.isInteger(ctx.connectionId) || ctx.connectionId <= 0) {
    throw new GmailTokenCryptoConfigError("token context: invalid connectionId");
  }
  if (ctx.field !== "access" && ctx.field !== "refresh") {
    throw new GmailTokenCryptoConfigError("token context: invalid field");
  }
}

export function buildGmailTokenAad(ctx: GmailTokenContext, keyId: string): Buffer {
  return Buffer.from(
    `dubiz/gmail-token/v2|biz=${ctx.businessId}|conn=${ctx.connectionId}|field=${ctx.field}|kid=${keyId}`,
    "utf8"
  );
}

type GcmParts = { iv: Buffer; tag: Buffer; ciphertext: Buffer };

function splitGcmBody(body: string): GcmParts | null {
  const parts = body.split(".");
  if (parts.length !== 3) return null;
  let iv: Buffer;
  let tag: Buffer;
  let ciphertext: Buffer;
  try {
    iv = Buffer.from(parts[0], "base64");
    tag = Buffer.from(parts[1], "base64");
    ciphertext = Buffer.from(parts[2], "base64");
  } catch {
    return null;
  }
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
  return { iv, tag, ciphertext };
}

function gcmOpen(key: Buffer, parts: GcmParts, aad: Buffer | null): string | null {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, parts.iv);
    if (aad) decipher.setAAD(aad);
    decipher.setAuthTag(parts.tag);
    return Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function decryptGcmV1(encrypted: string): string | null {
  const parts = splitGcmBody(encrypted.slice(GCM_V1_PREFIX.length));
  if (!parts) return null;
  // v1 was only ever written with the single legacy key.
  const key = loadKeyring().get(LEGACY_KEY_ID);
  if (!key) return null;
  return gcmOpen(key, parts, null);
}

function decryptGcmV2(encrypted: string, ctx: GmailTokenContext | undefined): string | null {
  if (!ctx) return null; // a v2 blob is meaningless without its row identity
  try {
    assertContext(ctx);
  } catch {
    return null;
  }
  const rest = encrypted.slice(GCM_V2_PREFIX.length);
  const idx = rest.indexOf(":");
  if (idx <= 0) return null;
  const keyId = rest.slice(0, idx);
  if (!KEY_ID_RE.test(keyId)) return null;
  const key = loadKeyring().get(keyId);
  if (!key) return null;
  const parts = splitGcmBody(rest.slice(idx + 1));
  if (!parts) return null;
  return gcmOpen(key, parts, buildGmailTokenAad(ctx, keyId));
}

/**
 * Encrypt a token for ONE row + column (gcm_v2). `context` is required: a
 * token without a row identity cannot be bound, and unbound (v1) writes are no
 * longer produced.
 */
export function encryptToken(
  plaintext: string | null | undefined,
  context: GmailTokenContext
): EncryptedToken | null {
  if (!plaintext) {
    return null;
  }
  assertContext(context);

  const { id, key } = requireActiveKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(buildGmailTokenAad(context, id));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_BYTES) {
    throw new Error(`Unexpected GCM tag length: ${tag.length}`);
  }

  const encrypted = `${GCM_V2_PREFIX}${id}:${iv.toString("base64")}.${tag.toString("base64")}.${ciphertext.toString("base64")}`;
  return { encrypted, keyId: `gcm_v2:${id}` };
}

/**
 * Decrypt a stored token as a USABLE CREDENTIAL. Returns null for anything
 * that is not authentic for this row: a v2 blob under another context, an
 * unknown key id, a malformed blob, and every quarantined enc_v0 blob.
 */
export function decryptToken(
  encrypted: string | null | undefined,
  context?: GmailTokenContext
): string | null {
  if (!encrypted) {
    return null;
  }
  if (encrypted.startsWith(GCM_V2_PREFIX)) {
    return decryptGcmV2(encrypted, context);
  }
  if (encrypted.startsWith(GCM_V1_PREFIX)) {
    return decryptGcmV1(encrypted);
  }
  // enc_v0 (plaintext) and unknown formats: quarantined — reconnect required.
  return null;
}

/** True for a stored blob in the quarantined plaintext format. */
export function isQuarantinedLegacyToken(encrypted: string | null | undefined): boolean {
  return typeof encrypted === "string" && encrypted.startsWith(LEGACY_PREFIX);
}

/**
 * Explicit, single-purpose decode used ONLY to revoke the grant at Google on
 * disconnect. Revoking a plaintext-at-rest token is strictly better than
 * leaving it valid; this is never used to call Gmail.
 */
export function decryptTokenForRevocation(
  encrypted: string | null | undefined,
  context?: GmailTokenContext
): string | null {
  if (isQuarantinedLegacyToken(encrypted)) {
    try {
      const plain = Buffer.from((encrypted as string).slice(LEGACY_PREFIX.length), "base64").toString("utf8");
      return plain || null;
    } catch {
      return null;
    }
  }
  return decryptToken(encrypted, context);
}

/**
 * Best-effort, FAIL-SAFE re-encryption of a stored refresh token to the
 * current format (gcm_v2 under the active key, bound to its row), persisted
 * opportunistically alongside an already-happening refresh write.
 *
 * Returns `{}` (no upgrade) when the blob is already v2 under the active key,
 * when it is a quarantined enc_v0 blob (never re-armed as a credential), when
 * the key is missing, or when the round-trip does not verify.
 *
 * MUST NEVER throw and MUST NEVER be a condition for refresh success.
 */
export function refreshTokenUpgrade(
  storedEncrypted: string | null | undefined,
  plaintextRefreshToken: string | null | undefined,
  context: Omit<GmailTokenContext, "field">
): { refreshTokenEncrypted?: string } {
  try {
    if (!storedEncrypted || !plaintextRefreshToken) return {};
    if (isQuarantinedLegacyToken(storedEncrypted)) return {};
    const active = activeKey();
    if (!active) return {};
    if (storedEncrypted.startsWith(`${GCM_V2_PREFIX}${active.id}:`)) return {};

    const ctx: GmailTokenContext = { ...context, field: "refresh" };
    const reencrypted = encryptToken(plaintextRefreshToken, ctx);
    if (reencrypted && decryptToken(reencrypted.encrypted, ctx) === plaintextRefreshToken) {
      return { refreshTokenEncrypted: reencrypted.encrypted };
    }
    return {};
  } catch {
    return {};
  }
}

/** @deprecated kept for existing imports; see {@link refreshTokenUpgrade}. */
export const legacyRefreshTokenUpgrade = refreshTokenUpgrade;
