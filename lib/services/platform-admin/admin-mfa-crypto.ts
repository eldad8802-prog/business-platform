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

export const ADMIN_MFA_KEY_ID = "gcm_v1";

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

export function encryptAdminMfaSecret(plaintext: string): {
  encrypted: string;
  keyId: string;
} {
  if (!plaintext) {
    throw new AdminMfaCryptoConfigError("refusing to encrypt an empty secret");
  }
  const key = requireKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_BYTES) {
    throw new AdminMfaCryptoConfigError(`unexpected GCM tag length: ${tag.length}`);
  }
  return {
    encrypted: `${GCM_PREFIX}${iv.toString("base64")}.${tag.toString(
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
export function decryptAdminMfaSecret(encrypted: string | null | undefined): string | null {
  if (!encrypted || !encrypted.startsWith(GCM_PREFIX)) return null;
  const parts = encrypted.slice(GCM_PREFIX.length).split(".");
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
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf8"
    );
  } catch {
    return null;
  }
}
