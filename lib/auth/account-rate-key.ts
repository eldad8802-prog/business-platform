import { createHash } from "node:crypto";

/**
 * Rate-limit keys that are about ONE account rather than one source. The address is folded first and
 * only a digest of it reaches the limiter's store — never the address itself. The digest is computed
 * for ANY address, registered or not, so every limit below behaves identically for both: nothing about
 * it can tell whether an account exists.
 */
export function accountDigest(normalizedEmail: string): string {
  return createHash("sha256").update(`dubiz:rl:${normalizedEmail}`, "utf8").digest("hex").slice(0, 32);
}

/**
 * Failed sign-ins for one address, from ANY IP (the per-IP limit in the login route stays as well):
 *   - failures 1–2: the ordinary "wrong email or password";
 *   - failure 3:    the same, plus a warning that one attempt is left;
 *   - failure 4:    a temporary lock of 15 minutes, starting at that failure;
 *   - while locked: no password is compared at all; the answer says how long is left.
 * Counted in an exact rolling 15-minute window. A successful sign-in is not a failure, and it clears
 * the failures before it on that ledger. A browser that already signed in to the account counts on its OWN ledger
 * (lib/auth/login-device.ts), so a stranger's failures cannot lock the owner out of a known device.
 */
export const LOGIN_FAILURE_POLICY = {
  limit: 4,
  windowMs: 15 * 60_000,
  lockMs: 15 * 60_000,
  warnAtFailure: 3,
} as const;

export function loginAccountRateKey(normalizedEmail: string, deviceNonce: string | null = null): string {
  const base = `auth:login:fail:${accountDigest(normalizedEmail)}`;
  return deviceNonce ? `${base}:d:${deviceNonce}` : base;
}

/** Password-reset requests for one address, from anywhere: 3 per hour. */
export const RESET_REQUEST_ACCOUNT_LIMIT = { limit: 3, windowMs: 60 * 60_000 } as const;

export function resetRequestAccountRateKey(normalizedEmail: string): string {
  return `auth:reset:req:${accountDigest(normalizedEmail)}`;
}
