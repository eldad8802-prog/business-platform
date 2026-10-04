/**
 * M6 — AES-256-GCM for the one provider credential an acquisition connection holds: the Meta Page
 * access token needed to read a lead (`AcquisitionConnection.credential*`). Google and website
 * connections hold no credential — only a key HASH.
 *
 * Key: 32 bytes in ACQUISITION_CREDENTIAL_ENCRYPTION_KEY (64 hex or base64). Its own key, not
 * another integration's: a leak of one integration's key never opens another's tokens.
 * Missing / malformed → throws (fail closed: a Meta connection cannot be created or read).
 *
 * AAD binds a ciphertext to its row ("acq:v1:<businessId>:<sourceKey>:<publicId>"): a token copied
 * onto another business's or another connection's row fails verification.
 * credentialKeyId records which key version encrypted it (rotation-ready).
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm" as const;
const ENV_KEY_NAME = "ACQUISITION_CREDENTIAL_ENCRYPTION_KEY";
export const CREDENTIAL_KEY_ID = "acq-v1";

export type EncryptedCredential = { ciphertext: string; iv: string; tag: string; keyId: string };

function key(): Buffer {
  const raw = process.env[ENV_KEY_NAME]?.trim();
  if (!raw) throw new Error(`${ENV_KEY_NAME} is not configured — acquisition credentials are unavailable`);
  const k = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error(`${ENV_KEY_NAME} must decode to exactly 32 bytes`);
  return k;
}

export function credentialAad(businessId: number, sourceKey: string, publicId: string): Buffer {
  return Buffer.from(`acq:v1:${businessId}:${sourceKey}:${publicId}`, "utf8");
}

export function isCredentialKeyConfigured(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

export function encryptCredential(plaintext: string, aad: Buffer): EncryptedCredential {
  if (typeof plaintext !== "string" || plaintext.length === 0) throw new Error("empty credential");
  const iv = randomBytes(12);
  const c = createCipheriv(ALGORITHM, key(), iv);
  c.setAAD(aad);
  const ciphertext = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), keyId: CREDENTIAL_KEY_ID };
}

export function decryptCredential(enc: EncryptedCredential, aad: Buffer): string {
  if (enc.keyId !== CREDENTIAL_KEY_ID) throw new Error("unknown credential key id");
  const d = createDecipheriv(ALGORITHM, key(), Buffer.from(enc.iv, "base64"));
  d.setAAD(aad);
  d.setAuthTag(Buffer.from(enc.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(enc.ciphertext, "base64")), d.final()]).toString("utf8");
}
