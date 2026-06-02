/**
 * Gmail OAuth token encryption at rest (AES-256-GCM).
 *
 * Storage format (single DB column `*TokenEncrypted`):
 *   Legacy: enc_v0:<base64(plaintext)>          — read-only backward compat
 *   Current: gcm_v1:<b64(iv)>.<b64(tag)>.<b64(ciphertext)>
 *
 * Key: GMAIL_TOKEN_ENCRYPTION_KEY (32 bytes, hex or base64).
 * New encryption fails closed when the key is missing or invalid.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm" as const;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENV_KEY_NAME = "GMAIL_TOKEN_ENCRYPTION_KEY";
const LEGACY_PREFIX = "enc_v0:";
const GCM_PREFIX = "gcm_v1:";
const GCM_KEY_ID = "gcm_v1";

export type EncryptedToken = {
  encrypted: string;
  keyId: string;
};

export class GmailTokenCryptoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailTokenCryptoConfigError";
  }
}

function loadEncryptionKey(): Buffer | null {
  const raw = process.env[ENV_KEY_NAME];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }

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

  if (key.length !== KEY_BYTES) {
    return null;
  }

  return key;
}

function requireEncryptionKey(): Buffer {
  const key = loadEncryptionKey();
  if (!key) {
    throw new GmailTokenCryptoConfigError(
      process.env.NODE_ENV === "production"
        ? `${ENV_KEY_NAME} is not configured`
        : `${ENV_KEY_NAME} is not configured. Set a 32-byte key (hex or base64) in .env.local.`
    );
  }
  return key;
}

function decryptLegacyEncV0(encrypted: string): string | null {
  const b64 = encrypted.slice(LEGACY_PREFIX.length);
  try {
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function decryptGcmV1(encrypted: string): string | null {
  const body = encrypted.slice(GCM_PREFIX.length);
  const parts = body.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const key = loadEncryptionKey();
  if (!key) {
    return null;
  }

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

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    return null;
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  try {
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch {
    return null;
  }
}

export function encryptToken(
  plaintext: string | null | undefined
): EncryptedToken | null {
  if (!plaintext) {
    return null;
  }

  const key = requireEncryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  if (tag.length !== TAG_BYTES) {
    throw new Error(`Unexpected GCM tag length: ${tag.length}`);
  }

  const encrypted = `${GCM_PREFIX}${iv.toString("base64")}.${tag.toString("base64")}.${ciphertext.toString("base64")}`;

  return { encrypted, keyId: GCM_KEY_ID };
}

export function decryptToken(
  encrypted: string | null | undefined
): string | null {
  if (!encrypted) {
    return null;
  }

  if (encrypted.startsWith(LEGACY_PREFIX)) {
    return decryptLegacyEncV0(encrypted);
  }

  if (encrypted.startsWith(GCM_PREFIX)) {
    return decryptGcmV1(encrypted);
  }

  return null;
}
