/**
 * Closed-beta signup allowlist — the one exception to a CLOSED public-signup gate.
 *
 * With `PUBLIC_SIGNUP_ENABLED` not "true", registration is closed. This lets an
 * operator name, explicitly, the exact addresses that may still open an account
 * (Production validation, a controlled rollout). It is not an invitation system:
 * no tokens, no expiry, no table — one server-side variable, read at request time.
 *
 *   SIGNUP_ALLOWED_EMAILS   exact addresses, separated by commas (or new lines).
 *                           Compared after the SAME normalisation signup applies
 *                           (signup-identity.normalizeEmail).
 *
 * FAIL CLOSED. The list is honoured only when EVERY entry is a plain, exact
 * address. One malformed entry, a wildcard (`*`), a domain-wide entry (`@x.com`,
 * `*@x.com`), or more than MAX_SIGNUP_ALLOWLIST entries, and the whole list is
 * ignored — registration stays exactly as closed as it is with no list at all.
 * A typo can never widen who may register.
 *
 * Unset or empty → no allowlist → today's behaviour, unchanged.
 * Ignored entirely while public signup is open.
 *
 * Nothing here is ever returned to a client. Diagnostics carry counts and an
 * error code, never an address.
 */

import { normalizeEmail } from "./signup-identity";

export const MAX_SIGNUP_ALLOWLIST = 20;

/** The explicit closed-beta entry to the registration form: `/register?access=beta`. Grants nothing by itself. */
export const CLOSED_BETA_ACCESS = "beta";

/** A plain address: one @, a dot in the domain, no wildcard, quoting, spaces or separators. */
const EXACT_ADDRESS = /^[^\s@*%,;<>"'()[\]\\]+@[^\s@*%,;<>"'()[\]\\]+\.[^\s@*%,;<>"'()[\]\\.]+$/;

export type SignupAllowlistError = "invalid_entry" | "too_many";

export type SignupAllowlist = {
  /** True only for a non-empty list in which every entry is a valid exact address. */
  readonly configured: boolean;
  readonly size: number;
  readonly error: SignupAllowlistError | null;
  /** Membership after signup's own normalisation. Always false when not configured. */
  has(email: string): boolean;
};

const CLOSED = (error: SignupAllowlistError | null): SignupAllowlist => ({
  configured: false,
  size: 0,
  error,
  has: () => false,
});

export function parseSignupAllowlist(raw: string | undefined): SignupAllowlist {
  const entries = (raw ?? "")
    .split(/[,\n\r]/)
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  if (entries.length === 0) return CLOSED(null);
  if (entries.length > MAX_SIGNUP_ALLOWLIST) return CLOSED("too_many");

  const set = new Set<string>();
  for (const entry of entries) {
    const email = normalizeEmail(entry);
    if (email.length > 320 || !EXACT_ADDRESS.test(email)) return CLOSED("invalid_entry");
    set.add(email);
  }
  return {
    configured: true,
    size: set.size,
    error: null,
    has: (email: string) => typeof email === "string" && set.has(normalizeEmail(email)),
  };
}

export function readSignupAllowlist(env: Record<string, string | undefined> = process.env): SignupAllowlist {
  return parseSignupAllowlist(env.SIGNUP_ALLOWED_EMAILS);
}
