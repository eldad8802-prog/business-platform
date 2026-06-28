/**
 * AES-256-GCM encryption for payment provider credentials at rest.
 *
 * This protects the MERCHANT credential (provider API secret / terminal key) —
 * never card data, which Dubiz does not store. Mirrors the proven Billing
 * Authority token-crypto design.
 *
 * Storage format (three base64 columns on BusinessPaymentConnection):
 *   credentialEncrypted = base64(ciphertext)
 *   credentialIv        = base64(12-byte random nonce)
 *   credentialTag       = base64(16-byte GCM auth tag)
 *
 * Key: PAYMENTS_ENCRYPTION_KEY (32 bytes, hex or base64). Fail-closed on
 * encrypt when the key is missing or malformed. AAD binds the ciphertext to
 * "businessId:provider" so material cannot be replayed across businesses or
 * providers.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { PaymentProvider } from "./payments.types";

const ALGORITHM = "aes-256-gcm" as const;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENV_KEY_NAME = "PAYMENTS_ENCRYPTION_KEY";

/** Key version label persisted as `encryptionKeyId` for future rotation. */
export const PAYMENTS_ENCRYPTION_KEY_ID = "payments-v1";

export type EncryptedCredentialMaterial = {
  credentialEncrypted: string;
  credentialIv: string;
  credentialTag: string;
  encryptionKeyId: string;
};

export class PaymentCryptoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentCryptoConfigError";
  }
}

function loadEncryptionKey(): Buffer {
  const raw = process.env[ENV_KEY_NAME];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new PaymentCryptoConfigError(
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
      throw new PaymentCryptoConfigError(`${ENV_KEY_NAME} is not valid base64`);
    }
  }

  if (key.length !== KEY_BYTES) {
    throw new PaymentCryptoConfigError(
      `${ENV_KEY_NAME} must decode to exactly ${KEY_BYTES} bytes (got ${key.length})`
    );
  }

  return key;
}

function credentialAad(businessId: number, provider: PaymentProvider): Buffer {
  return Buffer.from(`${businessId}:${provider}`, "utf8");
}

/**
 * Encrypt a provider credential for a business. Throws on missing/malformed
 * key or empty input — callers must treat that as a hard failure.
 */
export function encryptPaymentCredential(
  plaintext: string,
  businessId: number,
  provider: PaymentProvider
): EncryptedCredentialMaterial {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("encryptPaymentCredential: plaintext must be non-empty");
  }
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new Error("encryptPaymentCredential: businessId must be positive");
  }

  const key = loadEncryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(credentialAad(businessId, provider));

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_BYTES) {
    throw new Error(`Unexpected GCM tag length: ${tag.length}`);
  }

  return {
    credentialEncrypted: ciphertext.toString("base64"),
    credentialIv: iv.toString("base64"),
    credentialTag: tag.toString("base64"),
    encryptionKeyId: PAYMENTS_ENCRYPTION_KEY_ID,
  };
}

/**
 * Decrypt a provider credential. Returns null on authentication failure,
 * tampering, wrong key, wrong AAD, or missing material. Callers MUST treat
 * null as a hard failure (do not fall back to plaintext or skip the credential).
 */
export function decryptPaymentCredential(
  stored: {
    credentialEncrypted: string | null;
    credentialIv: string | null;
    credentialTag: string | null;
  },
  businessId: number,
  provider: PaymentProvider
): string | null {
  if (
    !stored ||
    typeof stored.credentialEncrypted !== "string" ||
    typeof stored.credentialIv !== "string" ||
    typeof stored.credentialTag !== "string" ||
    !Number.isInteger(businessId) ||
    businessId <= 0
  ) {
    return null;
  }

  let key: Buffer;
  try {
    key = loadEncryptionKey();
  } catch {
    return null;
  }

  let iv: Buffer;
  let tag: Buffer;
  let ciphertext: Buffer;
  try {
    iv = Buffer.from(stored.credentialIv, "base64");
    tag = Buffer.from(stored.credentialTag, "base64");
    ciphertext = Buffer.from(stored.credentialEncrypted, "base64");
  } catch {
    return null;
  }

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    return null;
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(credentialAad(businessId, provider));
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
