/**
 * M7-B / M7-C — a short-lived, business-bound STATE for a provider round-trip that leaves Dubiz and
 * comes back WITHOUT the owner's session (WooCommerce posts the store's REST keys to our callback; the
 * owner's browser returns from Wix). The state is the ONLY thing that names the business on the way
 * back, so it is sealed: AES-256-GCM under ACQUISITION_CREDENTIAL_ENCRYPTION_KEY, its AAD binding the
 * kind, the business and the expiry. A state is useless for another kind, another business, after it
 * expires, or if one byte changes.
 *
 *   <businessId>.<base64url(json{x, c, i, t, k})>
 */
import { credentialAad, decryptCredential, encryptCredential } from "./credential-crypto";

export type SealedStateKind = "woocommerce.connect" | "wix.connect";
export const STATE_TTL_MS = 30 * 60 * 1000;

function aad(kind: SealedStateKind, businessId: number, expiresAt: number) {
  return credentialAad(businessId, kind, String(expiresAt));
}

export function sealState(kind: SealedStateKind, businessId: number, payload: Record<string, string>, now = Date.now()): string {
  const expiresAt = now + STATE_TTL_MS;
  const e = encryptCredential(JSON.stringify(payload), aad(kind, businessId, expiresAt));
  const body = Buffer.from(JSON.stringify({ x: expiresAt, c: e.ciphertext, i: e.iv, t: e.tag, k: e.keyId }), "utf8").toString("base64url");
  return `${businessId}.${body}`;
}

export function openState(
  kind: SealedStateKind,
  state: unknown,
  now = Date.now()
): { businessId: number; payload: Record<string, string> } | null {
  if (typeof state !== "string" || state.length > 4096) return null;
  const m = /^([1-9][0-9]{0,9})\.([A-Za-z0-9_-]+)$/.exec(state);
  if (!m) return null;
  const businessId = Number(m[1]);
  try {
    const h = JSON.parse(Buffer.from(m[2], "base64url").toString("utf8")) as { x?: unknown; c?: unknown; i?: unknown; t?: unknown; k?: unknown };
    if (typeof h.x !== "number" || h.x < now || h.x > now + STATE_TTL_MS) return null;
    if (typeof h.c !== "string" || typeof h.i !== "string" || typeof h.t !== "string" || typeof h.k !== "string") return null;
    const plain = decryptCredential({ ciphertext: h.c, iv: h.i, tag: h.t, keyId: h.k }, aad(kind, businessId, h.x));
    const payload = JSON.parse(plain) as Record<string, string>;
    return payload && typeof payload === "object" ? { businessId, payload } : null;
  } catch {
    return null;
  }
}
