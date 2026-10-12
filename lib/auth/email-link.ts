/**
 * Single-use account links — email verification and password reset.
 *
 * A link carries `<tokenId>.<secret>`. The database (AuthEmailToken, migration
 * 20261017090000_auth_email_tokens) stores only sha256(secret); the secret itself is never stored
 * anywhere. It is DERIVED: HMAC-SHA256 over the purpose and the token id, under a key derived from the
 * server's AUTH_TOKEN_SECRET (domain-separated, so it can never collide with an access-token signature).
 * That is what lets the email outbox hold only the token id and still render the link at delivery
 * time — a read of the outbox or of the token table cannot be replayed as a link.
 *
 * The link puts the token in the URL FRAGMENT (`#t=…`): a fragment is never sent to a server, so the
 * secret does not reach access logs, proxies or a Referer header. The page reads it and POSTs it.
 *
 * Rotating AUTH_TOKEN_SECRET invalidates every outstanding link (and every access token) — by design.
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { AuthTokenConfigError } from "@/lib/auth-token";

export type EmailTokenPurpose = "EMAIL_VERIFY" | "PASSWORD_RESET";

export const EMAIL_LINK_PATHS: Record<EmailTokenPurpose, string> = {
  EMAIL_VERIFY: "/verify-email",
  PASSWORD_RESET: "/reset-password",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

function linkKey(): Buffer {
  const raw = process.env.AUTH_TOKEN_SECRET?.trim();
  if (!raw) throw new AuthTokenConfigError("AUTH_TOKEN_SECRET is not configured");
  return createHmac("sha256", raw).update("dubiz:auth-email-link:v1").digest();
}

/** The link secret for a token: 32 bytes, base64url (43 characters). */
export function deriveLinkSecret(tokenId: string, purpose: EmailTokenPurpose): string {
  return createHmac("sha256", linkKey()).update(`${purpose}:${tokenId}`).digest("base64url");
}

/** What the database stores and compares: sha256 of the secret, hex. */
export function hashLinkSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** A fresh token id and the hash to store for it. */
export function mintEmailToken(purpose: EmailTokenPurpose): { tokenId: string; tokenHash: string } {
  const tokenId = randomUUID();
  return { tokenId, tokenHash: hashLinkSecret(deriveLinkSecret(tokenId, purpose)) };
}

/** The full link for an email: APP_BASE_URL + path + fragment. */
export function buildEmailLink(appBaseUrl: string, tokenId: string, purpose: EmailTokenPurpose): string {
  return `${appBaseUrl}${EMAIL_LINK_PATHS[purpose]}#t=${tokenId}.${deriveLinkSecret(tokenId, purpose)}`;
}

/** Parses `<uuid>.<secret>` as the page posts it; null for anything else. */
export function parseLinkToken(value: unknown): { tokenId: string; secret: string } | null {
  if (typeof value !== "string" || value.length > 100) return null;
  const dot = value.indexOf(".");
  if (dot < 0) return null;
  const tokenId = value.slice(0, dot).toLowerCase();
  const secret = value.slice(dot + 1);
  if (!UUID.test(tokenId) || !SECRET.test(secret)) return null;
  return { tokenId, secret };
}

/**
 * Whether `secret` is the one this server would derive for the token — a cheap local check before the
 * database is asked. Constant-time. The database re-checks against the stored hash regardless.
 */
export function isDerivedSecret(tokenId: string, secret: string, purpose: EmailTokenPurpose): boolean {
  const expected = Buffer.from(deriveLinkSecret(tokenId, purpose));
  const given = Buffer.from(secret);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
