/**
 * Backward-compatible rate-limit shim.
 *
 * Historically this was an in-memory `Map` limiter (single-instance only). It is
 * now a thin async wrapper over the shared, production-grade limiter in
 * `./rate-limiter` (Upstash Redis in production, in-memory in dev). The public
 * surface is unchanged except that `consumeRateLimit` is now async — existing
 * callers only need to `await` it. Per-route keys, limits and windows are
 * preserved exactly.
 *
 * New code should prefer the bucket API in `./rate-limiter` (checkRateLimit)
 * instead of raw keys.
 */

import { randomUUID } from "node:crypto";

import { clearRawAttempts, consumeRawLimit, lockRawAttempts, reserveRawAttempt } from "./rate-limiter";

export function getClientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }

  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;

  const cfIp = req.headers.get("cf-connecting-ip")?.trim();
  if (cfIp) return cfIp;

  return "unknown";
}

export type AttemptTicket =
  | { allowed: true; count: number; clear: () => Promise<void>; lock: (lockMs: number) => Promise<void> }
  | { allowed: false; locked: boolean; retryAfterMs: number };

/**
 * Reserve one attempt in an exact rolling window for `key` (atomic — a parallel burst cannot exceed
 * `limit`). The ticket is then either cleared (the attempt proved legitimate: the window empties) or
 * turned into a lock. `count` includes this attempt. While the shared backend is unavailable the
 * attempt is counted on this instance's local ledger instead (never an uncounted pass), and the
 * ticket's clear / lock go to the ledger that issued it.
 */
export async function reserveAttempt(params: {
  key: string;
  limit: number;
  windowMs: number;
  nowMs?: number;
}): Promise<AttemptTicket> {
  const nowMs = params.nowMs ?? Date.now();
  const member = `${nowMs}:${randomUUID()}`;
  const r = await reserveRawAttempt({ key: params.key, member, limit: params.limit, windowMs: params.windowMs, nowMs });
  if (!r.allowed) return { allowed: false, locked: r.locked, retryAfterMs: r.retryAfterMs };
  const via = r.via;
  return {
    allowed: true,
    count: r.count,
    clear: () => clearRawAttempts(params.key, via),
    lock: (lockMs: number) => lockRawAttempts(params.key, lockMs, Date.now(), via),
  };
}

export async function consumeRateLimit(params: {
  key: string;
  limit: number;
  windowMs: number;
}): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  return consumeRawLimit({
    key: params.key,
    limit: params.limit,
    windowSeconds: Math.max(1, Math.ceil(params.windowMs / 1000)),
  });
}
