/**
 * Rate limiter orchestrator.
 *
 * Selects a backend (Redis in production, in-memory in dev), evaluates all
 * window rules for a bucket, and returns a single decision. Backend
 * unavailability is handled per-bucket via fail mode; configuration errors
 * (missing Upstash env in prod) are NOT caught here — they propagate so a
 * misconfigured deploy fails hard instead of silently running unprotected.
 */

import { BUCKETS } from "./buckets";
import { RateLimiterBackendError } from "./errors";
import { localFallback } from "./local-fallback";
import { memoryBackend } from "./memory-backend";
import { redisBackend } from "./redis-backend";
import type {
  AttemptReservation,
  BucketName,
  RateLimitBackend,
  RateLimitDecision,
  RateLimitScope,
  WindowRule,
} from "./types";

export { RateLimiterConfigError, RateLimiterBackendError } from "./errors";
export type {
  BucketName,
  RateLimitDecision,
  RateLimitScope,
} from "./types";

export type RateLimitIdentifiers = {
  user?: number | string | null;
  business?: number | string | null;
  ip?: string | null;
};

function resolveBackendName(): "redis" | "memory" {
  const explicit = process.env.RATE_LIMIT_BACKEND?.trim().toLowerCase();
  if (explicit === "redis" || explicit === "memory") return explicit;
  return process.env.NODE_ENV === "production" ? "redis" : "memory";
}

function getBackend(): RateLimitBackend {
  return resolveBackendName() === "redis" ? redisBackend : memoryBackend;
}

function identifierForScope(
  scope: RateLimitScope,
  ids: RateLimitIdentifiers
): string | null {
  switch (scope) {
    case "user":
      return ids.user != null ? `u:${ids.user}` : null;
    case "business":
      return ids.business != null ? `b:${ids.business}` : null;
    case "ip":
      return ids.ip ? `ip:${ids.ip}` : null;
    case "global":
      return "global";
    default:
      return null;
  }
}

function prefixForRule(bucket: BucketName, rule: WindowRule): string {
  return `rl:${bucket}:${rule.scope}:${rule.windowSeconds}s`;
}

function retryAfterSeconds(resetAt: number): number {
  return Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
}

/**
 * Evaluate a bucket. Rules are checked in order; the first denial short-circuits.
 */
export async function checkRateLimit(
  input: { bucket: BucketName } & RateLimitIdentifiers
): Promise<RateLimitDecision> {
  const bucket = input.bucket;
  const config = BUCKETS[bucket];
  const backend = getBackend();

  let degraded = false;
  let tightestRemaining = Number.POSITIVE_INFINITY;
  let tightestResetAt = Date.now();

  for (const rule of config.rules) {
    const identifier = identifierForScope(rule.scope, input);
    if (identifier === null) {
      // Missing identifier for this scope (e.g. business rule but no businessId).
      // Skip rather than crash, but make it visible — this is a wiring bug.
      console.warn(
        `[rate-limit] skipped rule: bucket=${bucket} scope=${rule.scope} has no identifier`
      );
      continue;
    }

    let result;
    try {
      result = await backend.evaluate(
        prefixForRule(bucket, rule),
        identifier,
        rule.limit,
        rule.windowSeconds
      );
    } catch (error) {
      if (error instanceof RateLimiterBackendError) {
        // Transient backend failure -> apply fail mode for THIS bucket.
        degraded = true;
        if (config.failMode === "closed") {
          console.error(
            `[rate-limit] backend_unavailable bucket=${bucket} scope=${rule.scope} failMode=closed -> deny`,
            error.message
          );
          return {
            allowed: false,
            outcome: "backend_unavailable",
            bucket,
            scope: rule.scope,
            limit: rule.limit,
            remaining: 0,
            resetAt: Date.now() + 5000,
            retryAfterSeconds: 5,
            degraded: true,
          };
        }
        // failMode === "open": log and allow this rule through (degraded).
        console.error(
          `[rate-limit] backend_unavailable bucket=${bucket} scope=${rule.scope} failMode=open -> allow (degraded)`,
          error.message
        );
        continue;
      }
      // Config errors and anything unexpected propagate (fail hard).
      throw error;
    }

    if (!result.success) {
      return {
        allowed: false,
        outcome: "rate_limited",
        bucket,
        scope: rule.scope,
        limit: result.limit,
        remaining: 0,
        resetAt: result.resetAt,
        retryAfterSeconds: retryAfterSeconds(result.resetAt),
        degraded,
      };
    }

    if (result.remaining < tightestRemaining) {
      tightestRemaining = result.remaining;
      tightestResetAt = result.resetAt;
    }
  }

  return {
    allowed: true,
    outcome: "allowed",
    bucket,
    scope: null,
    limit: 0,
    remaining: Number.isFinite(tightestRemaining) ? tightestRemaining : 0,
    resetAt: tightestResetAt,
    retryAfterSeconds: 0,
    degraded,
  };
}

/**
 * The AUTH fallback (sign-in, signup, reset, verification links, refresh, platform-admin MFA).
 *
 * These limits guard guessing and abuse, so they must never run unbounded: when the shared backend is
 * unreachable they continue on this instance's local ledger (./local-fallback) instead of allowing
 * everything. Every other raw key keeps its previous posture (fail open, logged).
 *
 * After a failed call the shared backend is rested for SHARED_BACKEND_RETRY_MS on this instance, so an
 * outage costs one timeout per instance per interval instead of one per request; then it is tried again,
 * and as soon as it answers it is authoritative again. A lock recorded locally during the outage keeps
 * holding after the shared backend returns, until it expires.
 */
const AUTH_KEY_PREFIXES = ["auth:", "admin:mfa:"] as const;
export const SHARED_BACKEND_RETRY_MS = 10_000;

let sharedRetryMs = SHARED_BACKEND_RETRY_MS;
let sharedRestingUntil = 0;
let backendOverride: RateLimitBackend | null = null;

function rawBackend(): RateLimitBackend {
  return backendOverride ?? getBackend();
}

function isAuthKey(key: string): boolean {
  return AUTH_KEY_PREFIXES.some((p) => key.startsWith(p));
}

/** "auth:login:fail:<digest>" -> "auth:login": enough to tell which limit degraded, without the address digest or IP. */
function keyClass(key: string): string {
  return key.split(":").slice(0, 2).join(":");
}

function sharedResting(): boolean {
  return Date.now() < sharedRestingUntil;
}

function noteSharedDown(op: string, key: string, error: RateLimiterBackendError): void {
  sharedRestingUntil = Date.now() + sharedRetryMs;
  console.error(`[rate-limit] backend_unavailable ${op} key=${keyClass(key)} -> local fallback for ${sharedRetryMs}ms`, error.message);
}

/**
 * Single raw-key limit against the shared backend. Used by the legacy
 * `consumeRateLimit` shim so all routes (auth / pos / content / csv) share the
 * production Redis store instead of per-instance memory.
 *
 * On a transient backend failure an auth key continues on the local ledger (above); any other key
 * fails OPEN (preserving the prior "never spuriously blocked" behavior), logged. Config errors still
 * propagate (hard fail in production).
 */
export async function consumeRawLimit(params: {
  key: string;
  limit: number;
  windowSeconds: number;
}): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const auth = isAuthKey(params.key);
  const local = () => {
    const r = localFallback.evaluate("rl:legacy", params.key, params.limit, params.windowSeconds);
    return { allowed: r.success, remaining: r.remaining, resetAt: r.resetAt };
  };
  if (auth && sharedResting()) return local();
  try {
    const result = await rawBackend().evaluate("rl:legacy", params.key, params.limit, params.windowSeconds);
    return {
      allowed: result.success,
      remaining: result.remaining,
      resetAt: result.resetAt,
    };
  } catch (error) {
    if (error instanceof RateLimiterBackendError) {
      if (auth) {
        noteSharedDown("legacy", params.key, error);
        return local();
      }
      console.error(
        `[rate-limit] backend_unavailable legacy key=${keyClass(params.key)} failMode=open -> allow (degraded)`,
        error.message
      );
      return {
        allowed: true,
        remaining: params.limit,
        resetAt: Date.now() + params.windowSeconds * 1000,
      };
    }
    throw error;
  }
}

/**
 * The attempt ledger (see RateLimitBackend.reserveAttempt) — the sign-in failure lock. A transient
 * backend error continues on the local ledger (never "allow with count 0", which could never lock);
 * `via` says which ledger holds this reservation, so its clear / lock go to the same one. A config
 * error propagates.
 */
const ATTEMPT_PREFIX = "rl:attempt";

export type LedgerVia = "shared" | "local";

export async function reserveRawAttempt(params: {
  key: string;
  member: string;
  limit: number;
  windowMs: number;
  nowMs: number;
}): Promise<AttemptReservation & { via: LedgerVia }> {
  // A lock recorded here while the shared backend was down still holds after it returns.
  const localLock = localFallback.lockRemainingMs(ATTEMPT_PREFIX, params.key, params.nowMs);
  if (localLock > 0) return { allowed: false, locked: true, retryAfterMs: localLock, via: "local" };
  if (!sharedResting()) {
    try {
      const r = await rawBackend().reserveAttempt(ATTEMPT_PREFIX, params.key, params.member, params.limit, params.windowMs, params.nowMs);
      return { ...r, via: "shared" };
    } catch (error) {
      if (!(error instanceof RateLimiterBackendError)) throw error;
      noteSharedDown("attempt-reserve", params.key, error);
    }
  }
  const r = localFallback.reserveAttempt(ATTEMPT_PREFIX, params.key, params.limit, params.windowMs, params.nowMs);
  return { ...r, via: "local" };
}

export async function clearRawAttempts(key: string, via: LedgerVia = "shared"): Promise<void> {
  localFallback.clearAttempts(ATTEMPT_PREFIX, key);
  if (via === "local") return;
  try {
    await rawBackend().clearAttempts(ATTEMPT_PREFIX, key);
  } catch (error) {
    console.error(`[rate-limit] attempt-clear failed key=${keyClass(key)}`, error instanceof Error ? error.name : "unknown");
  }
}

export async function lockRawAttempts(key: string, lockMs: number, nowMs: number, via: LedgerVia = "shared"): Promise<void> {
  if (via === "local") {
    localFallback.lockAttempts(ATTEMPT_PREFIX, key, lockMs, nowMs);
    return;
  }
  try {
    await rawBackend().lockAttempts(ATTEMPT_PREFIX, key, lockMs, nowMs);
  } catch (error) {
    // The lock must not be lost: it is kept here instead.
    localFallback.lockAttempts(ATTEMPT_PREFIX, key, lockMs, nowMs);
    if (error instanceof RateLimiterBackendError) noteSharedDown("attempt-lock", key, error);
    else console.error(`[rate-limit] attempt-lock failed key=${keyClass(key)}`, error instanceof Error ? error.name : "unknown");
  }
}

/** Test-only: substitute the shared backend (e.g. one that fails like an unreachable Redis) and the rest interval. */
export function configureRateLimiterForTests(opts: { backend?: RateLimitBackend | null; retryMs?: number }): void {
  if (opts.backend !== undefined) backendOverride = opts.backend;
  if (opts.retryMs !== undefined) sharedRetryMs = opts.retryMs;
  sharedRestingUntil = 0;
}
