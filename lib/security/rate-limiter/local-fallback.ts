/**
 * Local fallback ledger — what the AUTH limits run on while the shared (Redis) backend is unreachable.
 *
 * Before it, a Redis outage let every login attempt through (count 0 → never a warning, never a lock)
 * and every auth:* limit allow. Here the same rules keep running on this instance's memory instead:
 * per instance, so an attacker spread over N warm instances gets at most N× the normal budget —
 * bounded, never unlimited; and never stricter than normal, so no owner is locked out by the outage.
 *
 * The maps are capped so a spray of addresses cannot grow memory without bound: expired entries go
 * first, then the oldest windows. Locks are evicted last (only when more than MAX_LOCKS are live).
 */

import type { AttemptReservation, RuleResult } from "./types";

const MAX_WINDOWS = 5_000;
const MAX_LOCKS = 5_000;

type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();
const attempts = new Map<string, number[]>();
const locks = new Map<string, number>();

const keyOf = (prefix: string, identifier: string) => `${prefix}|${identifier}`;

function capWindows(nowMs: number): void {
  if (windows.size + attempts.size <= MAX_WINDOWS) return;
  for (const [k, w] of windows) if (w.resetAt <= nowMs) windows.delete(k);
  for (const [k, list] of attempts) if (list.length === 0) attempts.delete(k);
  // Still full: the oldest entries go (Map keeps insertion order).
  for (const k of windows.keys()) {
    if (windows.size + attempts.size <= MAX_WINDOWS) break;
    windows.delete(k);
  }
  for (const k of attempts.keys()) {
    if (windows.size + attempts.size <= MAX_WINDOWS) break;
    attempts.delete(k);
  }
}

function capLocks(nowMs: number): void {
  if (locks.size <= MAX_LOCKS) return;
  for (const [k, until] of locks) if (until <= nowMs) locks.delete(k);
  for (const k of locks.keys()) {
    if (locks.size <= MAX_LOCKS) break;
    locks.delete(k);
  }
}

export const localFallback = {
  /** Fixed window, as the legacy memory limiter counts. */
  evaluate(prefix: string, identifier: string, limit: number, windowSeconds: number, nowMs = Date.now()): RuleResult {
    const key = keyOf(prefix, identifier);
    const existing = windows.get(key);
    if (!existing || existing.resetAt <= nowMs) {
      const resetAt = nowMs + windowSeconds * 1000;
      windows.set(key, { count: 1, resetAt });
      capWindows(nowMs);
      return { success: true, limit, remaining: Math.max(0, limit - 1), resetAt };
    }
    if (existing.count >= limit) return { success: false, limit, remaining: 0, resetAt: existing.resetAt };
    existing.count += 1;
    return { success: true, limit, remaining: Math.max(0, limit - existing.count), resetAt: existing.resetAt };
  },

  /** Exact rolling window + lock, the same contract as RateLimitBackend.reserveAttempt. Synchronous, so atomic. */
  reserveAttempt(prefix: string, identifier: string, limit: number, windowMs: number, nowMs: number): AttemptReservation {
    const key = keyOf(prefix, identifier);
    const lockedUntil = locks.get(key) ?? 0;
    if (lockedUntil > nowMs) return { allowed: false, locked: true, retryAfterMs: lockedUntil - nowMs };
    const live = (attempts.get(key) ?? []).filter((t) => t > nowMs - windowMs);
    if (live.length >= limit) {
      attempts.set(key, live);
      return { allowed: false, locked: false, retryAfterMs: Math.min(...live) + windowMs - nowMs };
    }
    live.push(nowMs);
    attempts.set(key, live);
    capWindows(nowMs);
    return { allowed: true, count: live.length };
  },

  clearAttempts(prefix: string, identifier: string): void {
    attempts.delete(keyOf(prefix, identifier));
  },

  lockAttempts(prefix: string, identifier: string, lockMs: number, nowMs: number): void {
    const key = keyOf(prefix, identifier);
    locks.set(key, nowMs + lockMs);
    attempts.delete(key);
    capLocks(nowMs);
  },

  /** Milliseconds left on a lock recorded here; 0 when none. */
  lockRemainingMs(prefix: string, identifier: string, nowMs: number): number {
    const key = keyOf(prefix, identifier);
    const until = locks.get(key) ?? 0;
    if (until <= nowMs) {
      if (until) locks.delete(key);
      return 0;
    }
    return until - nowMs;
  },
};

/** Test-only helper. */
export function resetLocalFallbackForTests(): void {
  windows.clear();
  attempts.clear();
  locks.clear();
}

/** Test-only: current entry counts (to prove the caps). */
export function localFallbackSizesForTests(): { windows: number; attempts: number; locks: number } {
  return { windows: windows.size, attempts: attempts.size, locks: locks.size };
}

export const LOCAL_FALLBACK_CAPS = { MAX_WINDOWS, MAX_LOCKS } as const;
