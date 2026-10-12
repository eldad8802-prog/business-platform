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
 * Single raw-key limit against the shared backend. Used by the legacy
 * `consumeRateLimit` shim so all routes (auth / pos / content / csv) share the
 * production Redis store instead of per-instance memory.
 *
 * Legacy callers fail OPEN on a transient backend blip (preserving the prior
 * "never spuriously blocked" behavior), but the degradation is logged. Config
 * errors still propagate (hard fail in production).
 */
/**
 * The attempt ledger (see RateLimitBackend.reserveAttempt). Same failure posture as
 * `consumeRawLimit`: a transient backend error ALLOWS the attempt (fail open, logged) and reports
 * count 0 ("unknown"); clear / lock errors are logged and swallowed. A config error propagates.
 */
const ATTEMPT_PREFIX = "rl:attempt";

export async function reserveRawAttempt(params: {
  key: string;
  member: string;
  limit: number;
  windowMs: number;
  nowMs: number;
}): Promise<AttemptReservation> {
  try {
    return await getBackend().reserveAttempt(ATTEMPT_PREFIX, params.key, params.member, params.limit, params.windowMs, params.nowMs);
  } catch (error) {
    if (error instanceof RateLimiterBackendError) {
      console.error(`[rate-limit] backend_unavailable attempt-reserve key=${params.key} failMode=open -> allow (degraded)`, error.message);
      return { allowed: true, count: 0 };
    }
    throw error;
  }
}

export async function clearRawAttempts(key: string): Promise<void> {
  try {
    await getBackend().clearAttempts(ATTEMPT_PREFIX, key);
  } catch (error) {
    console.error(`[rate-limit] attempt-clear failed key=${key}`, error instanceof Error ? error.name : "unknown");
  }
}

export async function lockRawAttempts(key: string, lockMs: number, nowMs: number): Promise<void> {
  try {
    await getBackend().lockAttempts(ATTEMPT_PREFIX, key, lockMs, nowMs);
  } catch (error) {
    console.error(`[rate-limit] attempt-lock failed key=${key}`, error instanceof Error ? error.name : "unknown");
  }
}

export async function consumeRawLimit(params: {
  key: string;
  limit: number;
  windowSeconds: number;
}): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const backend = getBackend();
  try {
    const result = await backend.evaluate(
      "rl:legacy",
      params.key,
      params.limit,
      params.windowSeconds
    );
    return {
      allowed: result.success,
      remaining: result.remaining,
      resetAt: result.resetAt,
    };
  } catch (error) {
    if (error instanceof RateLimiterBackendError) {
      console.error(
        `[rate-limit] backend_unavailable legacy key=${params.key} failMode=open -> allow (degraded)`,
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
