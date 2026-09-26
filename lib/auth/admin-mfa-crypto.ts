/**
 * Platform-admin TOTP seed encryption at rest (AES-256-GCM).
 *
 * A TOTP seed is persistent authentication material: anyone holding it can mint
 * valid codes forever. It is therefore encrypted with authenticated encryption
 * under a DEDICATED key and never written, logged or returned in plaintext.
 *
 * Key separation is deliberate and is a CASA 3.3.1 evidence point:
 *   - NOT `AUTH_TOKEN_SECRET`   — that signs transient session/state envelopes;
 *                                 it is rotated to invalidate sessions (Wave A),
 *                                 and rotating it must never make an admin's
 *                                 enrolled authenticator unreadable.
 *   - NOT `GMAIL_TOKEN_ENCRYPTION_KEY` — that protects Google user data.
 *   - `ADMIN_MFA_ENCRYPTION_KEY` — this material only.
 *
 * Storage format mirrors the established `OAuthToken` pattern so operational
 * tooling and key-rotation reasoning stay uniform across the codebase:
 *   gcm_v1:<b64(iv)>.<b64(tag)>.<b64(ciphertext)>
 * with the key id persisted alongside, so a future key version can be rolled
 * forward per-row without a format change.
 *
 * Fails CLOSED: a missing or malformed key raises rather than degrading to
 * plaintext or to a weaker mode.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm" as const;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENV_KEY_NAME = "ADMIN_MFA_ENCRYPTION_KEY";
const GCM_PREFIX = "gcm_v1:";
/**
 * v2 (L-10) binds the ciphertext to its owner: the GCM additional
 * authenticated data is `admin-mfa:user:<userId>`. A v1 ciphertext carried no
 * AAD, so a row's seed could be copied onto ANOTHER admin's row (by anyone with
 * write access to the table) and would decrypt there. A v2 ciphertext fails
 * authentication on any row but its own.
 *
 * v1 is still READ (backward compatible, no data loss) and is re-encrypted as
 * v2 the next time the seed is successfully used.
 */
const GCM_V2_PREFIX = "gcm_v2:";

export const ADMIN_MFA_KEY_ID = "gcm_v2";
export const ADMIN_MFA_LEGACY_KEY_ID = "gcm_v1";

function aadFor(userId: number): Buffer {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new AdminMfaCryptoConfigError("userId must be a positive integer");
  }
  return Buffer.from(`admin-mfa:user:${userId}`, "utf8");
}

export class AdminMfaCryptoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminMfaCryptoConfigError";
  }
}

function loadKey(): Buffer | null {
  const raw = process.env[ENV_KEY_NAME];
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const trimmed = raw.trim();
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

function requireKey(): Buffer {
  const key = loadKey();
  if (!key) {
    throw new AdminMfaCryptoConfigError(
      process.env.NODE_ENV === "production"
        ? `${ENV_KEY_NAME} is not configured`
        : `${ENV_KEY_NAME} is not configured. Set a 32-byte key (hex or base64) in .env.local.`
    );
  }
  return key;
}

/** True when the key is present and usable — used to fail closed at the route. */
export function isAdminMfaCryptoConfigured(): boolean {
  return loadKey() !== null;
}

export function encryptAdminMfaSecret(
  plaintext: string,
  userId: number
): {
  encrypted: string;
  keyId: string;
} {
  if (!plaintext) {
    throw new AdminMfaCryptoConfigError("refusing to encrypt an empty secret");
  }
  const aad = aadFor(userId);
  const key = requireKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_BYTES) {
    throw new AdminMfaCryptoConfigError(`unexpected GCM tag length: ${tag.length}`);
  }
  return {
    encrypted: `${GCM_V2_PREFIX}${iv.toString("base64")}.${tag.toString(
      "base64"
    )}.${ciphertext.toString("base64")}`,
    keyId: ADMIN_MFA_KEY_ID,
  };
}

/**
 * Returns the seed, or null for anything that does not decrypt and authenticate.
 * Every failure mode collapses to the same `null` so a caller cannot distinguish
 * a wrong key from a tampered blob from a malformed envelope.
 */
export function decryptAdminMfaSecret(
  encrypted: string | null | undefined,
  userId: number
): string | null {
  return decryptAdminMfaSecretWithFormat(encrypted, userId)?.secret ?? null;
}

/**
 * As `decryptAdminMfaSecret`, also reporting whether the ciphertext is the
 * legacy unbound v1 format — the caller re-encrypts those as v2 on use.
 */
export function decryptAdminMfaSecretWithFormat(
  encrypted: string | null | undefined,
  userId: number
): { secret: string; legacy: boolean } | null {
  if (!encrypted) return null;
  let legacy: boolean;
  let body: string;
  if (encrypted.startsWith(GCM_V2_PREFIX)) {
    legacy = false;
    body = encrypted.slice(GCM_V2_PREFIX.length);
  } else if (encrypted.startsWith(GCM_PREFIX)) {
    legacy = true;
    body = encrypted.slice(GCM_PREFIX.length);
  } else {
    return null;
  }
  let aad: Buffer;
  try {
    aad = aadFor(userId);
  } catch {
    return null;
  }
  const parts = body.split(".");
  if (parts.length !== 3) return null;
  const key = loadKey();
  if (!key) return null;

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

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    if (!legacy) decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const secret = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf8"
    );
    return { secret, legacy };
  } catch {
    return null;
  }
}
