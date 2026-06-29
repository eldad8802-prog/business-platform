/**
 * Upstash Redis backend — the production store.
 *
 * - Sliding-window via @upstash/ratelimit (shared across all instances/regions).
 * - REST-based (no persistent TCP socket) → serverless-safe.
 * - Lazy construction: Redis is only built on first use. Missing env vars throw
 *   RateLimiterConfigError (a deploy mistake — must fail hard, never swallowed).
 * - Each backend call is wrapped in a short timeout; on timeout/network error we
 *   throw RateLimiterBackendError, which the orchestrator maps to the bucket's
 *   fail mode (closed -> 503, open -> degraded allow).
 */

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { RateLimiterBackendError, RateLimiterConfigError } from "./errors";
import type { RateLimitBackend, RuleResult } from "./types";

/**
 * Max time we wait for a single Redis decision before applying fail mode.
 * 200ms proved too tight for cross-region Upstash REST round-trips (every call
 * tripped the timeout -> backend_unavailable -> fail-closed 503 on uploads).
 * 1000ms tolerates cross-region latency while still failing fast; on a healthy
 * same-region Upstash the call returns in a few ms, so this adds no real latency.
 * Override via RATE_LIMIT_REDIS_TIMEOUT_MS.
 */
export const REDIS_TIMEOUT_MS = (() => {
  const raw = Number(process.env.RATE_LIMIT_REDIS_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 1000;
})();

let redis: Redis | null = null;

function getRedis(): Redis {
  if (redis) return redis;

  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();

  if (!url || !token) {
    throw new RateLimiterConfigError(
      "Rate limiter backend=redis but UPSTASH_REDIS_REST_URL / " +
        "UPSTASH_REDIS_REST_TOKEN are not configured."
    );
  }

  redis = new Redis({ url, token });
  return redis;
}

const limiterCache = new Map<string, Ratelimit>();

function getLimiter(
  prefix: string,
  limit: number,
  windowSeconds: number
): Ratelimit {
  const cacheKey = `${prefix}:${limit}:${windowSeconds}`;
  const cached = limiterCache.get(cacheKey);
  if (cached) return cached;

  const created = new Ratelimit({
    redis: getRedis(),
    limiter: Ratelimit.slidingWindow(
      limit,
      `${windowSeconds} s` as `${number} s`
    ),
    prefix,
    analytics: false,
  });
  limiterCache.set(cacheKey, created);
  return created;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new RateLimiterBackendError(`Redis rate limit call timed out after ${ms}ms`)
      );
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(
          new RateLimiterBackendError("Redis rate limit call failed", {
            cause: error,
          })
        );
      }
    );
  });
}

export const redisBackend: RateLimitBackend = {
  name: "redis",
  async evaluate(
    prefix: string,
    identifier: string,
    limit: number,
    windowSeconds: number
  ): Promise<RuleResult> {
    const limiter = getLimiter(prefix, limit, windowSeconds);
    const res = await withTimeout(limiter.limit(identifier), REDIS_TIMEOUT_MS);
    return {
      success: res.success,
      limit: res.limit,
      remaining: res.remaining,
      resetAt: res.reset,
    };
  },
};

/** Test-only helper. */
export function resetRedisBackendForTests(): void {
  redis = null;
  limiterCache.clear();
}
