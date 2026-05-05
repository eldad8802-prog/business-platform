export type EncryptedToken = {
  encrypted: string;
  keyId: string;
};

// Placeholder only (MVP). Replace with real KMS/AES-GCM later.
export function encryptToken(plaintext: string | null | undefined): EncryptedToken | null {
  if (!plaintext) return null;
  const keyId = process.env.EMAIL_TOKEN_ENCRYPTION_KEY_ID || "placeholder-v0";
  const encrypted = `enc_v0:${Buffer.from(plaintext, "utf8").toString("base64")}`;
  return { encrypted, keyId };
}

// Placeholder only (MVP). Replace with real KMS/AES-GCM later.
export function decryptToken(encrypted: string | null | undefined): string | null {
  if (!encrypted) return null;
  if (!encrypted.startsWith("enc_v0:")) return null;
  const b64 = encrypted.slice("enc_v0:".length);
  try {
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return null;
  }
}

