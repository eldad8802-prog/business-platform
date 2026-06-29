/**
 * Rate limiter error types.
 *
 * - RateLimiterConfigError: the selected backend cannot be constructed because
 *   required configuration is missing (e.g. Upstash env vars in production).
 *   This is a DEPLOY-TIME mistake and must fail hard — it is never swallowed.
 * - RateLimiterBackendError: a transient runtime failure talking to the backend
 *   (network / timeout). This is handled per-bucket via the fail mode policy.
 */

export class RateLimiterConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimiterConfigError";
  }
}

export class RateLimiterBackendError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "RateLimiterBackendError";
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}
