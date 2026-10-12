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
import type { AttemptReservation, RateLimitBackend, RuleResult } from "./types";

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

/** [window sorted set, lock key] for one identifier. Same hash tag, so a cluster keeps them together. */
function attemptKeys(prefix: string, identifier: string): [string, string] {
  return [`${prefix}:{${identifier}}:attempts`, `${prefix}:{${identifier}}:lock`];
}

/**
 * Atomic reserve. KEYS = [window zset, lock]; ARGV = [nowMs, windowMs, limit, member].
 * Returns {1, count, 0} when reserved; {0, 1, lockTtlMs} while locked; {0, 0, waitMs} while the
 * window is full (reservations in flight count, so a parallel burst cannot exceed `limit`).
 */
const RESERVE_ATTEMPT_LUA = [
  "local ttl = redis.call('PTTL', KEYS[2])",
  "if ttl > 0 then return {0, 1, ttl} end",
  "local now = tonumber(ARGV[1])",
  "local win = tonumber(ARGV[2])",
  "local limit = tonumber(ARGV[3])",
  "redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - win)",
  "local count = redis.call('ZCARD', KEYS[1])",
  "if count >= limit then",
  "  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')",
  "  local wait = win",
  "  if oldest[2] then wait = tonumber(oldest[2]) + win - now end",
  "  return {0, 0, wait}",
  "end",
  "redis.call('ZADD', KEYS[1], now, ARGV[4])",
  "redis.call('PEXPIRE', KEYS[1], win)",
  "return {1, count + 1, 0}",
].join("\n");

/** Atomic lock: set the lock for lockMs and clear the window. KEYS = [window zset, lock]; ARGV = [lockMs]. */
const LOCK_ATTEMPTS_LUA = [
  "redis.call('SET', KEYS[2], '1', 'PX', tonumber(ARGV[1]))",
  "redis.call('DEL', KEYS[1])",
  "return 1",
].join("\n");

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
  async reserveAttempt(prefix, identifier, member, limit, windowMs, nowMs): Promise<AttemptReservation> {
    const res = (await withTimeout(
      getRedis().eval(RESERVE_ATTEMPT_LUA, attemptKeys(prefix, identifier), [String(nowMs), String(windowMs), String(limit), member]),
      REDIS_TIMEOUT_MS
    )) as [number, number, number];
    const [ok, n, wait] = res.map(Number);
    return ok === 1 ? { allowed: true, count: n } : { allowed: false, locked: n === 1, retryAfterMs: Math.max(0, wait) };
  },
  async clearAttempts(prefix, identifier) {
    await withTimeout(getRedis().del(attemptKeys(prefix, identifier)[0]), REDIS_TIMEOUT_MS);
  },
  async lockAttempts(prefix, identifier, lockMs) {
    await withTimeout(getRedis().eval(LOCK_ATTEMPTS_LUA, attemptKeys(prefix, identifier), [String(lockMs)]), REDIS_TIMEOUT_MS);
  },
};

/** Test-only helper. */
export function resetRedisBackendForTests(): void {
  redis = null;
  limiterCache.clear();
}
