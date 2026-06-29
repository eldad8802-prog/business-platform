/**
 * In-memory backend — DEV / TEST ONLY.
 *
 * This is the original MVP limiter logic (fixed window). It is intentionally
 * NOT used in production: it is per-instance, resets on restart, and diverges
 * behind a load balancer. The factory in ./index refuses to select it in
 * production unless explicitly forced via RATE_LIMIT_BACKEND=memory.
 */

import type { RateLimitBackend, RuleResult } from "./types";

type Bucket = { count: number; resetAt: number };

const store = new Map<string, Bucket>();

export const memoryBackend: RateLimitBackend = {
  name: "memory",
  async evaluate(
    prefix: string,
    identifier: string,
    limit: number,
    windowSeconds: number
  ): Promise<RuleResult> {
    const key = `${prefix}|${identifier}`;
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const existing = store.get(key);

    if (!existing || existing.resetAt <= now) {
      const resetAt = now + windowMs;
      store.set(key, { count: 1, resetAt });
      return { success: true, limit, remaining: Math.max(0, limit - 1), resetAt };
    }

    if (existing.count >= limit) {
      return { success: false, limit, remaining: 0, resetAt: existing.resetAt };
    }

    existing.count += 1;
    return {
      success: true,
      limit,
      remaining: Math.max(0, limit - existing.count),
      resetAt: existing.resetAt,
    };
  },
};

/** Test-only helper to reset state between cases. */
export function resetMemoryBackendForTests(): void {
  store.clear();
}
