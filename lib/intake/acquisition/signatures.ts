/**
 * M7-A — the delivery signatures the first-wave commerce / telephony providers use, verified against
 * the RAW body, in constant time, before anything is parsed. Pure functions (no I/O, no clock unless
 * passed in), so the lab and the unit tests drive exactly the code a provider route runs.
 *
 *   hmac-sha256-base64   WooCommerce (X-WC-Webhook-Signature) and Shopify (X-Shopify-Hmac-Sha256):
 *                        base64(HMAC-SHA256(secret, raw body)).
 *   svix                 CloudTalk (svix-id / svix-timestamp / svix-signature): HMAC-SHA256 with the
 *                        base64 key after "whsec_" over "<id>.<timestamp>.<body>", header
 *                        "v1,<base64> [v1,<base64> …]", timestamp within ±5 minutes (replay window).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

function equalBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** base64(HMAC-SHA256(secret, raw)) — the WooCommerce / Shopify scheme. */
export function verifyHmacSha256Base64(raw: string, header: string | null, secret: string): boolean {
  const given = (header ?? "").trim();
  if (!secret || !/^[A-Za-z0-9+/]{43}=$/.test(given)) return false;
  const expected = createHmac("sha256", secret).update(raw, "utf8").digest();
  return equalBytes(Buffer.from(given, "base64"), expected);
}

export const SVIX_TOLERANCE_SEC = 300;

/** The Svix scheme (CloudTalk). `now` is passed in so the replay window is testable. */
export function verifySvix(
  raw: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  secret: string,
  now: Date
): boolean {
  const id = (headers.id ?? "").trim();
  const ts = (headers.timestamp ?? "").trim();
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id) || !/^[0-9]{1,12}$/.test(ts)) return false;
  if (Math.abs(Math.floor(now.getTime() / 1000) - Number(ts)) > SVIX_TOLERANCE_SEC) return false;
  const keyText = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const key = Buffer.from(keyText, "base64");
  if (key.length < 16) return false;
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${raw}`, "utf8").digest();
  for (const part of (headers.signature ?? "").split(" ").slice(0, 8)) {
    const [version, sig] = part.split(",");
    if (version === "v1" && sig && /^[A-Za-z0-9+/]+=*$/.test(sig) && equalBytes(Buffer.from(sig, "base64"), expected)) return true;
  }
  return false;
}
