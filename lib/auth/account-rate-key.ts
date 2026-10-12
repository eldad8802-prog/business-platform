import { createHash } from "node:crypto";

/**
 * Rate-limit keys that are about ONE account rather than one source. The address is folded first and
 * only a digest of it reaches the limiter's store — never the address itself.
 */
function accountDigest(normalizedEmail: string): string {
  return createHash("sha256").update(`dubiz:rl:${normalizedEmail}`, "utf8").digest("hex").slice(0, 32);
}

/** Failed logins against one account, from anywhere: 10 per sliding 15 minutes. */
export const LOGIN_ACCOUNT_FAILURE_LIMIT = { limit: 10, windowMs: 15 * 60_000 } as const;

export function loginAccountRateKey(normalizedEmail: string): string {
  return `auth:login:fail:${accountDigest(normalizedEmail)}`;
}

/** Password-reset requests for one address, from anywhere: 3 per hour. */
export const RESET_REQUEST_ACCOUNT_LIMIT = { limit: 3, windowMs: 60 * 60_000 } as const;

export function resetRequestAccountRateKey(normalizedEmail: string): string {
  return `auth:reset:req:${accountDigest(normalizedEmail)}`;
}
