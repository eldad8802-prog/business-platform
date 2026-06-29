/**
 * HTTP response builder for denied rate-limit decisions (Hebrew, server-sourced).
 *
 * - rate_limited        -> 429 with Retry-After + RateLimit-* headers.
 * - backend_unavailable -> 503 (controlled) when a fail-closed bucket cannot
 *   reach Redis. Never a silent pass.
 */

import { NextResponse } from "next/server";
import type { RateLimitDecision } from "./types";

export function buildRateLimitResponse(
  decision: RateLimitDecision
): NextResponse {
  if (decision.outcome === "backend_unavailable") {
    return NextResponse.json(
      {
        error: "השירות עמוס כרגע. נסה שוב בעוד רגע.",
        code: "rate_limit_unavailable",
        retryAfterSeconds: decision.retryAfterSeconds,
      },
      {
        status: 503,
        headers: { "Retry-After": String(decision.retryAfterSeconds) },
      }
    );
  }

  // rate_limited
  return NextResponse.json(
    {
      error: `ביצעת יותר מדי פעולות בזמן קצר. נסה שוב בעוד כ-${decision.retryAfterSeconds} שניות.`,
      code: "rate_limited",
      scope: decision.scope,
      bucket: decision.bucket,
      retryAfterSeconds: decision.retryAfterSeconds,
      resetAt: new Date(decision.resetAt).toISOString(),
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(decision.retryAfterSeconds),
        "RateLimit-Limit": String(decision.limit),
        "RateLimit-Remaining": String(decision.remaining),
        "RateLimit-Reset": String(decision.retryAfterSeconds),
      },
    }
  );
}
