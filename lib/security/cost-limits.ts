/**
 * SEC-F / L-7 — per-business and per-user cost limits for expensive endpoints.
 *
 * One call right after authentication:
 *
 *   const limited = await enforceCostLimit("COST_LLM_GENERATION", user, req);
 *   if (limited) return limited;
 *
 * Denials are specific and machine-readable:
 *   429 { code: "cost_limit_exceeded", bucket, scope, retryAfterSeconds }
 *   503 { code: "cost_limit_unavailable", bucket }   — a FAIL-CLOSED bucket whose
 *                                                      backend is unreachable
 * Every denial is also a durable `COST_LIMIT_DENIED` security event.
 *
 * Fail modes live with the bucket definitions (rate-limiter/buckets.ts): LLM and
 * OCR buckets fail CLOSED; the ones that fail open say why, in place.
 */
import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import type { BucketName } from "@/lib/security/rate-limiter";
import { recordSecurityEvent } from "@/lib/security/security-events";

export type CostBucket = Extract<BucketName, `COST_${string}`>;

export const COST_LIMIT_EXCEEDED = "cost_limit_exceeded";
export const COST_LIMIT_UNAVAILABLE = "cost_limit_unavailable";

type Caller = { id: number; businessId: number } | null | undefined;

/** Returns a denial response, or null when the call may proceed. */
export async function enforceCostLimit(
  bucket: CostBucket,
  user: Caller,
  req?: Request | null
): Promise<NextResponse | null> {
  // Unauthenticated callers are the route's own 401 to give; never counted here.
  if (!user) return null;
  const decision = await checkRateLimit({ bucket, user: user.id, business: user.businessId });
  if (decision.allowed) return null;

  await recordSecurityEvent({
    type: "COST_LIMIT_DENIED",
    outcome: "DENIED",
    reason: decision.outcome === "backend_unavailable" ? "limiter_unavailable" : "limit_exceeded",
    businessId: user.businessId,
    userId: user.id,
    req,
    metadata: { bucket, scope: decision.scope ?? "none" },
  });

  const retry = String(decision.retryAfterSeconds);
  if (decision.outcome === "backend_unavailable") {
    return NextResponse.json(
      { error: "השירות עמוס כרגע. נסה שוב בעוד רגע.", code: COST_LIMIT_UNAVAILABLE, bucket, retryAfterSeconds: decision.retryAfterSeconds },
      { status: 503, headers: { "Retry-After": retry, "cache-control": "no-store" } }
    );
  }
  return NextResponse.json(
    {
      error: `הגעת למכסת השימוש לפעולה זו. נסה שוב בעוד כ-${decision.retryAfterSeconds} שניות.`,
      code: COST_LIMIT_EXCEEDED,
      bucket,
      scope: decision.scope,
      retryAfterSeconds: decision.retryAfterSeconds,
    },
    {
      status: 429,
      headers: {
        "Retry-After": retry,
        "RateLimit-Limit": String(decision.limit),
        "RateLimit-Remaining": "0",
        "RateLimit-Reset": retry,
        "cache-control": "no-store",
      },
    }
  );
}
