/**
 * M6 — the Meta connect flow without storing the owner's user token anywhere.
 *
 * Step 1 (pages): the server exchanges the one-time login code for the owner's user token, lists
 * their Pages, and returns them with a HANDLE: the user token sealed with AES-256-GCM under
 * ACQUISITION_CREDENTIAL_ENCRYPTION_KEY, bound to the business, valid for 10 minutes.
 * Step 2 (connect): the browser returns the handle with the chosen Page; the server opens it, re-reads
 * the owner's Pages and connects. The browser never holds a usable Meta token; a handle is useless
 * outside Dubiz, to another business, or after 10 minutes.
 */
import { credentialAad, decryptCredential, encryptCredential } from "./credential-crypto";

export const HANDLE_TTL_MS = 10 * 60 * 1000;

function aad(businessId: number, expiresAt: number) {
  return credentialAad(businessId, "meta.connect", String(expiresAt));
}

export function sealConnectHandle(businessId: number, userToken: string, now = Date.now()): string {
  const expiresAt = now + HANDLE_TTL_MS;
  const e = encryptCredential(userToken, aad(businessId, expiresAt));
  return Buffer.from(JSON.stringify({ x: expiresAt, c: e.ciphertext, i: e.iv, t: e.tag, k: e.keyId }), "utf8").toString("base64url");
}

export function openConnectHandle(businessId: number, handle: unknown, now = Date.now()): string | null {
  if (typeof handle !== "string" || handle.length > 4096) return null;
  try {
    const h = JSON.parse(Buffer.from(handle, "base64url").toString("utf8")) as { x?: unknown; c?: unknown; i?: unknown; t?: unknown; k?: unknown };
    if (typeof h.x !== "number" || h.x < now || h.x > now + HANDLE_TTL_MS) return null;
    if (typeof h.c !== "string" || typeof h.i !== "string" || typeof h.t !== "string" || typeof h.k !== "string") return null;
    return decryptCredential({ ciphertext: h.c, iv: h.i, tag: h.t, keyId: h.k }, aad(businessId, h.x));
  } catch {
    return null;
  }
}
