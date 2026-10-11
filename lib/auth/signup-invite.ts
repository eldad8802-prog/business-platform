/**
 * Closed-beta invitation codes — the proof that an allowlisted address is being registered by the
 * person it was sent to.
 *
 * WHY: the closed-beta allowlist (./signup-allowlist.ts) names WHO may open an account, but nothing
 * proved the visitor typing a listed address is its owner — Dubiz has no email verification yet. Anyone
 * who knew (or guessed) a tester's address and the `/register?access=beta` entry could open the
 * account first and receive that tester's beta business. A code that only the address's owner holds
 * closes that.
 *
 * HOW: a code is HMAC-SHA256(SIGNUP_INVITE_SECRET, "dubiz/closed-beta-invite/v1\n" + normalizedEmail),
 * base64url, first 22 characters (132 bits). It is bound to one address — a code for one tester is
 * useless for any other — stateless (no table, no token store), and revocable for everyone at once by
 * rotating the secret. The operator generates each tester's personal link with
 * `scripts/beta/invite-links.ts` and sends it to that tester only.
 *
 * FAIL CLOSED: with no secret, or a secret shorter than 32 characters, no code verifies — the closed
 * beta admits no one, exactly as with no allowlist. Codes are compared in constant time. Nothing here is
 * ever returned to a client or logged.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { normalizeEmail } from "./signup-identity";

export const SIGNUP_INVITE_SECRET_ENV = "SIGNUP_INVITE_SECRET";
export const MIN_INVITE_SECRET_LENGTH = 32;
export const INVITE_CODE_LENGTH = 22;
const DOMAIN = "dubiz/closed-beta-invite/v1\n";

export type SignupInvite = {
  /** True only with a secret of at least MIN_INVITE_SECRET_LENGTH characters. */
  readonly configured: boolean;
  /** Does `code` belong to `email`? Always false when not configured or the code is malformed. */
  verify(email: string, code: unknown): boolean;
};

export function inviteCodeFor(email: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(DOMAIN + normalizeEmail(email))
    .digest("base64url")
    .slice(0, INVITE_CODE_LENGTH);
}

export function parseSignupInvite(secret: string | undefined): SignupInvite {
  const s = (secret ?? "").trim();
  if (s.length < MIN_INVITE_SECRET_LENGTH) {
    return { configured: false, verify: () => false };
  }
  return {
    configured: true,
    verify(email: string, code: unknown): boolean {
      if (typeof email !== "string" || typeof code !== "string") return false;
      const given = code.trim();
      if (given.length !== INVITE_CODE_LENGTH || !/^[A-Za-z0-9_-]+$/.test(given)) return false;
      const expected = inviteCodeFor(email, s);
      return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    },
  };
}

export function readSignupInvite(env: Record<string, string | undefined> = process.env): SignupInvite {
  return parseSignupInvite(env[SIGNUP_INVITE_SECRET_ENV]);
}
