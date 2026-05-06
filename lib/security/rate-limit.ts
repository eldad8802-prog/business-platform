/**
 * In-memory rate limiter for early MVP / single-instance only.
 *
 * Limitations:
 * - Not shared across instances/regions (will not work correctly behind a load balancer).
 * - Resets on process restart.
 * - Memory grows with unique keys (should be bounded/cleaned up if expanded).
 *
 * For production: use a shared store (Redis/Upstash/DB-backed) + observability.
 */

type RateLimitParams = {
  key: string;
  limit: number;
  windowMs: number;
};

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();

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

export function consumeRateLimit(params: RateLimitParams): {
  allowed: boolean;
  remaining: number;
  resetAt: number;
} {
  const now = Date.now();
  const existing = buckets.get(params.key);

  if (!existing || existing.resetAt <= now) {
    const resetAt = now + params.windowMs;
    buckets.set(params.key, { count: 1, resetAt });
    return {
      allowed: true,
      remaining: Math.max(0, params.limit - 1),
      resetAt,
    };
  }

  if (existing.count >= params.limit) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: existing.resetAt,
    };
  }

  existing.count += 1;
  buckets.set(params.key, existing);

  return {
    allowed: true,
    remaining: Math.max(0, params.limit - existing.count),
    resetAt: existing.resetAt,
  };
}

