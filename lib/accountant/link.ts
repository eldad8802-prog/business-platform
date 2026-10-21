/**
 * The accountant's protected download link (D3: 14 days, revocable, every download recorded).
 *
 *   https://<app>/a/<publicId>#t=<secret>
 *
 * The public id (24 random bytes, base64url) names the delivery. The secret is never stored anywhere:
 * it is DERIVED (HMAC-SHA256 over the public id, under a key derived from AUTH_TOKEN_SECRET with its own
 * domain label), and the database keeps only sha256(secret). A read of the delivery table therefore
 * cannot be replayed as a link, and the email can be rendered at send time from the public id alone.
 *
 * The secret travels in the URL FRAGMENT, which a browser never sends to a server — it does not reach
 * access logs, proxies or a Referer header. The page reads it and POSTs it.
 *
 * Rotating AUTH_TOKEN_SECRET invalidates every outstanding accountant link (as it does account links).
 */

import { createHash, createHmac, randomBytes } from "node:crypto";

import { AuthTokenConfigError } from "@/lib/auth-token";

export const ACCOUNTANT_LINK_TTL_DAYS = 14;
export const ACCOUNTANT_LINK_PATH = "/a";

const PUBLIC_ID = /^[A-Za-z0-9_-]{32}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

function linkKey(): Buffer {
  const raw = process.env.AUTH_TOKEN_SECRET?.trim();
  if (!raw) throw new AuthTokenConfigError("AUTH_TOKEN_SECRET is not configured");
  return createHmac("sha256", raw).update("dubiz:accountant-link:v1").digest();
}

export function isLinkPublicId(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_ID.test(value);
}

export function isLinkSecret(value: unknown): value is string {
  return typeof value === "string" && SECRET.test(value);
}

/** The secret of a link: 32 bytes, base64url (43 characters). */
export function deriveAccountantLinkSecret(publicId: string): string {
  if (!isLinkPublicId(publicId)) throw new Error("invalid_link_public_id");
  return createHmac("sha256", linkKey()).update(`accountant-link:${publicId}`).digest("base64url");
}

export function hashAccountantLinkSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** A fresh link identity and the hash to store for it. */
export function mintAccountantLink(): { publicId: string; tokenHash: string } {
  const publicId = randomBytes(24).toString("base64url");
  return { publicId, tokenHash: hashAccountantLinkSecret(deriveAccountantLinkSecret(publicId)) };
}

export function buildAccountantLinkUrl(appBaseUrl: string, publicId: string): string {
  return `${appBaseUrl}${ACCOUNTANT_LINK_PATH}/${publicId}#t=${deriveAccountantLinkSecret(publicId)}`;
}

export function linkExpiry(approvedAt: Date): Date {
  return new Date(approvedAt.getTime() + ACCOUNTANT_LINK_TTL_DAYS * 24 * 60 * 60 * 1000);
}
