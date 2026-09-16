/**
 * OPAQUE CALLBACK SECRETS — the second way a provider callback can prove it is
 * genuine.
 *
 * Two authentication models exist in this domain and they are not variants of
 * one another:
 *
 *   SIGNATURE. The provider signs the callback body with a key both sides hold.
 *   CardCom has no such mechanism; PayPlus signs with the merchant's own secret
 *   key. Authenticity is a property of the MESSAGE.
 *
 *   POSSESSION. The provider is given a URL nobody else knows and calls it.
 *   Authenticity is a property of the ADDRESS. SUMIT works this way: its
 *   callback carries no signature header at all, and its own reference
 *   implementation authenticates by a secret embedded in the callback URL.
 *
 * This module exists so the second model is a first-class capability of the
 * payments domain rather than a trick inside one adapter. Nothing here mentions
 * a provider.
 *
 * THE RULES, and why each one is here.
 *
 *   - The secret is minted per REQUEST, not per connection. A per-connection
 *     secret would make every callback for that merchant interchangeable, so
 *     one leaked URL would let a caller assert events against any of the
 *     merchant's requests. Per-request, a leaked URL names exactly one request
 *     that is already known to the leaker.
 *   - Only the SHA-256 is stored. The live value exists in one place, the URL
 *     held by the provider. A database leak therefore yields nothing a caller
 *     could present.
 *   - Comparison happens on the hash, by an equality lookup on a unique index.
 *     There is no secret-to-secret comparison anywhere, so there is no timing
 *     channel to protect.
 *   - It never reaches a browser. It is given to the provider server-to-server
 *     at checkout creation and to nobody else.
 */

import { createHash, randomBytes } from "node:crypto";

/**
 * 256 bits, base64url. Long enough that guessing is not a threat model, short
 * enough to sit in a URL path without tripping any provider's length limits.
 */
const SECRET_BYTES = 32;

/**
 * A callback secret must be long enough that a truncated or malformed value
 * cannot accidentally collide with a real one. Anything below this is rejected
 * before it is hashed, so a caller probing with short strings never reaches a
 * database lookup.
 */
export const MIN_CALLBACK_SECRET_LENGTH = 32;

/** Mint a fresh secret. Callers must not derive it from anything. */
export function generateCallbackSecret(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

/**
 * Hash a callback secret for storage or lookup.
 *
 * Returns null for anything that could not be a real secret — empty, wrong
 * type, or too short. A null result must be treated as "no match" by callers;
 * it deliberately makes an obviously bogus value cheap to refuse.
 */
export function hashCallbackSecret(secret: unknown): string | null {
  if (typeof secret !== "string") return null;
  const trimmed = secret.trim();
  if (trimmed.length < MIN_CALLBACK_SECRET_LENGTH) return null;
  return createHash("sha256").update(trimmed, "utf8").digest("hex");
}

/**
 * Extract a callback secret from a request path.
 *
 * The convention is a single trailing segment: `/api/.../<secret>`. Query
 * strings are deliberately NOT supported — query values end up in access logs,
 * referrer headers and analytics far more readily than path segments do, and a
 * provider that can register a URL can register a path.
 */
export function extractCallbackSecretFromPath(pathname: string): string | null {
  if (typeof pathname !== "string" || pathname.length === 0) return null;
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const last = segments[segments.length - 1]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    decoded = last;
  }
  return decoded.length >= MIN_CALLBACK_SECRET_LENGTH ? decoded : null;
}

/**
 * Build the callback URL an adapter should register with its provider.
 *
 * The secret is the final path segment so it never appears in a query string.
 */
export function buildCallbackUrl(
  publicBaseUrl: string,
  routePath: string,
  secret: string
): string {
  const base = publicBaseUrl.replace(/\/+$/, "");
  const route = routePath.replace(/^\/+|\/+$/g, "");
  return `${base}/${route}/${encodeURIComponent(secret)}`;
}

/**
 * Redact a callback secret out of arbitrary text before it is logged.
 *
 * A URL containing the secret can end up in an error message from a provider
 * client, and that message is the kind of thing a diagnostic path prints. This
 * is the last line rather than the first: the design keeps the secret out of
 * logs by never passing it to them.
 */
export function redactCallbackSecret(text: string, secret?: string | null): string {
  let out = String(text);
  if (secret && secret.length >= MIN_CALLBACK_SECRET_LENGTH) {
    out = out.split(secret).join("<REDACTED-CALLBACK-SECRET>");
  }
  // Also mask anything URL-shaped that looks like one of our callback paths,
  // for the case where the secret itself is not to hand.
  return out.replace(
    /(\/api\/payments\/webhook\/[a-z0-9-]+\/)[A-Za-z0-9_-]{32,}/gi,
    "$1<REDACTED-CALLBACK-SECRET>"
  );
}
