/**
 * AES-256-GCM encryption for Billing Authority secrets at rest.
 *
 * Storage format (matches Prisma schema — three base64 columns):
 *   encrypted = base64(ciphertext)
 *   iv        = base64(12-byte random nonce)
 *   tag       = base64(16-byte GCM auth tag)
 *
 * Key: BILLING_AUTHORITY_ENCRYPTION_KEY (32 bytes, hex or base64).
 * Fail-closed on encrypt when the key is missing or malformed.
 *
 * AAD binding:
 *   BillingAuthorityApp client secret     → environment only (e.g. "SANDBOX")
 *   BillingAuthorityConnection tokens     → "businessId:environment" (e.g. "42:SANDBOX")
 */

import { BillingAuthorityEnvironment } from "@prisma/client";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm" as const;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENV_KEY_NAME = "BILLING_AUTHORITY_ENCRYPTION_KEY";

export type EncryptedAuthorityMaterial = {
  encrypted: string;
  iv: string;
  tag: string;
};

export class BillingAuthorityTokenCryptoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingAuthorityTokenCryptoConfigError";
  }
}

function loadEncryptionKey(): Buffer {
  const raw = process.env[ENV_KEY_NAME];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new BillingAuthorityTokenCryptoConfigError(
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
      throw new BillingAuthorityTokenCryptoConfigError(
        `${ENV_KEY_NAME} is not valid base64`
      );
    }
  }

  if (key.length !== KEY_BYTES) {
    throw new BillingAuthorityTokenCryptoConfigError(
      `${ENV_KEY_NAME} must decode to exactly ${KEY_BYTES} bytes (got ${key.length})`
    );
  }

  return key;
}

function assertNonEmptyPlaintext(plaintext: string, operation: string): void {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error(`${operation}: plaintext must be a non-empty string`);
  }
}

function assertPositiveBusinessId(businessId: number, operation: string): void {
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new Error(`${operation}: businessId must be a positive integer`);
  }
}

function connectionAad(businessId: number, environment: BillingAuthorityEnvironment): Buffer {
  return Buffer.from(`${businessId}:${environment}`, "utf8");
}

function encryptWithAad(plaintext: string, aad: Buffer): EncryptedAuthorityMaterial {
  const key = loadEncryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  if (tag.length !== TAG_BYTES) {
    throw new Error(`Unexpected GCM tag length: ${tag.length}`);
  }

  return {
    encrypted: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function decryptWithAad(
  stored: { encrypted: string; iv: string; tag: string },
  aad: Buffer
): string | null {
  if (
    !stored ||
    typeof stored.encrypted !== "string" ||
    typeof stored.iv !== "string" ||
    typeof stored.tag !== "string"
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
  decipher.setAAD(aad);
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

export function encryptAuthorityAppSecret(
  plaintext: string,
  environment: BillingAuthorityEnvironment
): EncryptedAuthorityMaterial {
  assertNonEmptyPlaintext(plaintext, "encryptAuthorityAppSecret");
  return encryptWithAad(plaintext, Buffer.from(environment, "utf8"));
}

/**
 * Returns null on authentication failure, tampering, wrong key, or wrong AAD.
 * Callers must treat null as a hard failure.
 */
export function decryptAuthorityAppSecret(
  stored: { encrypted: string; iv: string; tag: string },
  environment: BillingAuthorityEnvironment
): string | null {
  return decryptWithAad(stored, Buffer.from(environment, "utf8"));
}

export function encryptAuthorityConnectionToken(
  plaintext: string,
  businessId: number,
  environment: BillingAuthorityEnvironment
): EncryptedAuthorityMaterial {
  assertNonEmptyPlaintext(plaintext, "encryptAuthorityConnectionToken");
  assertPositiveBusinessId(businessId, "encryptAuthorityConnectionToken");
  return encryptWithAad(plaintext, connectionAad(businessId, environment));
}

/**
 * Returns null on authentication failure, tampering, wrong key, or wrong AAD.
 * Callers must treat null as a hard failure.
 */
export function decryptAuthorityConnectionToken(
  stored: { encrypted: string; iv: string; tag: string },
  businessId: number,
  environment: BillingAuthorityEnvironment
): string | null {
  if (!Number.isInteger(businessId) || businessId <= 0) {
    return null;
  }
  return decryptWithAad(stored, connectionAad(businessId, environment));
}
