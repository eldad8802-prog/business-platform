/**
 * Credential verification primitives shared by login, step-up, password change
 * and password reset.
 *
 * ONE RULE: the work done for "no such account" must be indistinguishable from
 * the work done for "wrong password". Before this module, login returned for an
 * unknown email before running bcrypt, so response time alone told an attacker
 * which addresses had accounts. `verifyPassword` always runs exactly one bcrypt
 * comparison — against the real hash, or against a fixed dummy hash of the same
 * cost — and the throttled/refused responses below carry no account-dependent
 * detail.
 */

import bcrypt from "bcrypt";
import { NextResponse } from "next/server";

import type { RateLimitDecision } from "@/lib/security/rate-limiter";
import { MAX_LOGIN_PASSWORD_BYTES } from "./password-policy";

/**
 * A valid bcrypt hash at the SAME cost factor signup uses (10), of a random
 * value nobody knows. Comparing against it costs what a real comparison costs
 * and can never succeed.
 */
export const DUMMY_BCRYPT_HASH = "$2b$10$TSXWX5AhcJWNgGIGuvHWzuUXMLfjnJ7l/Ayol/PKoX7wJi/FL2tx6";

export type PasswordComparer = (plain: string, hash: string) => Promise<boolean>;

export const bcryptCompare: PasswordComparer = (plain, hash) => bcrypt.compare(plain, hash);

/**
 * Exactly one bcrypt comparison, whatever the inputs. Returns true only when a
 * real hash was supplied AND it matched.
 */
export async function verifyPassword(
  plain: string,
  hash: string | null | undefined,
  compare: PasswordComparer = bcryptCompare
): Promise<boolean> {
  const realHash = typeof hash === "string" && hash.length > 0 ? hash : null;
  // An oversized input is compared against the dummy too: the refusal must not
  // be faster than an ordinary wrong password.
  const oversized = Buffer.byteLength(plain, "utf8") > MAX_LOGIN_PASSWORD_BYTES;
  const candidate = oversized ? plain.slice(0, 64) : plain;
  const matched = await compare(candidate, realHash && !oversized ? realHash : DUMMY_BCRYPT_HASH);
  return matched && realHash !== null && !oversized;
}

/**
 * The one response an authentication throttle gives. It names no bucket, no
 * scope and no remaining count: "which rule tripped" differs between an address
 * that has an account and one that does not only if the response says so.
 */
export function authThrottleResponse(
  decision: Pick<RateLimitDecision, "outcome" | "retryAfterSeconds">
): NextResponse {
  if (decision.outcome === "backend_unavailable" || decision.outcome === "misconfigured") {
    return NextResponse.json(
      { error: "Service temporarily unavailable. Please try again shortly.", code: "AUTH_UNAVAILABLE" },
      { status: 503, headers: { "Retry-After": "5", "cache-control": "no-store" } }
    );
  }
  return NextResponse.json(
    { error: "Too many requests. Please try again later.", code: "RATE_LIMITED" },
    {
      status: 429,
      headers: {
        "Retry-After": String(Math.max(1, decision.retryAfterSeconds)),
        "cache-control": "no-store",
      },
    }
  );
}

/** Wait until at least `floorMs` have passed since `startedAt`. */
export async function padResponseTime(startedAt: number, floorMs: number): Promise<void> {
  const remaining = floorMs - (Date.now() - startedAt);
  if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
}
