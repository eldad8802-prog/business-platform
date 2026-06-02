/**
 * AES-256-GCM encryption for `WhatsAppConnection.accessToken*` columns.
 *
 * # Why real crypto here
 *
 * The Gmail integration uses a base64 placeholder (`token-crypto.placeholder`)
 * acknowledged in its own comments as MVP-only. WhatsApp tokens are
 * long-lived system-user tokens that grant unmediated send-as-business
 * access. Storing them in any reversible non-encrypted form would be a
 * direct sensitive-data leak in the event of DB exfiltration.
 *
 * # Key material
 *
 * 32-byte key supplied via `WHATSAPP_TOKEN_ENCRYPTION_KEY`. Accepted formats:
 *   - 64 lowercase hex chars
 *   - 44-char base64 (with or without trailing `=`)
 *
 * The function `getEncryptionKey()` throws on startup if the key is missing
 * or malformed — better to fail fast than silently use a wrong key.
 *
 * # Storage format
 *
 *   `accessTokenEncrypted` = base64(ciphertext)
 *   `accessTokenIv`        = base64(12-byte random nonce)
 *   `accessTokenTag`       = base64(16-byte GCM auth tag)
 *
 * All three are required to decrypt — losing any column makes the token
 * unrecoverable. This is intentional: an attacker who exfiltrates one
 * column without the key still cannot recover the plaintext.
 *
 * # Authenticated additional data (AAD)
 *
 * `businessId` (UTF-8 of the decimal string) is bound into the GCM tag as
 * AAD. This means a ciphertext encrypted for business A cannot be silently
 * pasted onto business B's row without GCM verification failing.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm" as const;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENV_KEY_NAME = "WHATSAPP_TOKEN_ENCRYPTION_KEY";

export type EncryptedToken = {
  /** base64(ciphertext) — goes into `accessTokenEncrypted` */
  encrypted: string;
  /** base64(12-byte random nonce) — goes into `accessTokenIv` */
  iv: string;
  /** base64(16-byte GCM auth tag) — goes into `accessTokenTag` */
  tag: string;
};

/**
 * Loads the 32-byte symmetric key from the env. Throws synchronously on
 * misconfiguration — call sites never see a wrong key silently.
 */
function getEncryptionKey(): Buffer {
  const raw = process.env[ENV_KEY_NAME];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(
      `Missing ${ENV_KEY_NAME}. Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
    );
  }
  const trimmed = raw.trim();
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, "hex");
  } else {
    try {
      key = Buffer.from(trimmed, "base64");
    } catch {
      throw new Error(`${ENV_KEY_NAME} is not valid base64`);
    }
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${ENV_KEY_NAME} must decode to exactly ${KEY_BYTES} bytes (got ${key.length})`
    );
  }
  return key;
}

/**
 * Encrypts a plaintext WhatsApp access token for a specific business.
 * The businessId is bound into the GCM tag as AAD — see file docstring.
 */
export function encryptAccessToken(
  plaintext: string,
  businessId: number
): EncryptedToken {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("encryptAccessToken: plaintext must be a non-empty string");
  }
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new Error("encryptAccessToken: businessId must be a positive integer");
  }

  const key = getEncryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(String(businessId), "utf8"));

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  if (tag.length !== TAG_BYTES) {
    // Should be impossible for aes-256-gcm but defensive.
    throw new Error(`Unexpected GCM tag length: ${tag.length}`);
  }

  return {
    encrypted: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

/**
 * Decrypts a stored token. Returns `null` if the ciphertext is malformed or
 * fails GCM authentication (likely tampering, wrong key, or wrong business).
 *
 * Caller MUST treat `null` as a hard failure and refuse to proceed — never
 * fall back to plaintext or to the stored ciphertext.
 */
export function decryptAccessToken(
  stored: { encrypted: string; iv: string; tag: string },
  businessId: number
): string | null {
  if (
    !stored ||
    typeof stored.encrypted !== "string" ||
    typeof stored.iv !== "string" ||
    typeof stored.tag !== "string"
  ) {
    return null;
  }
  if (!Number.isInteger(businessId) || businessId <= 0) {
    return null;
  }

  let key: Buffer;
  try {
    key = getEncryptionKey();
  } catch {
    return null;
  }

  let iv: Buffer;
  let tag: Buffer;
  let ciphertext: Buffer;
  try {
    iv = Buffer.from(stored.iv, "base64");
    tag = Buffer.from(stored.tag, "base64");
    ciphertext = Buffer.from(stored.encrypted, "base64");
  } catch {
    return null;
  }

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    return null;
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(Buffer.from(String(businessId), "utf8"));
  decipher.setAuthTag(tag);

  try {
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch {
    // GCM auth tag mismatch — wrong key, wrong businessId AAD, or tampered.
    return null;
  }
}

/**
 * Constant-time string comparison helper for any future callers that need
 * to compare two stored ciphertexts without timing-leak risk. Re-exported
 * here so all crypto primitives live in one module.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
