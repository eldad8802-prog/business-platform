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

import { consumeRawLimit } from "./rate-limiter";

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
