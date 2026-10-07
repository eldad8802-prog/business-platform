/**
 * The provider seam. Delivery knows nothing about any one provider: it hands over a rendered
 * message and an idempotency key, and gets back one of three outcomes.
 *
 *   sent        the provider accepted the message (its id is recorded).
 *   retryable   it may succeed later: network failure / timeout, 429, 5xx, a concurrent request
 *               with the same idempotency key, or a rejected credential (configuration, fixable).
 *   permanent   this message can never be accepted as it is (validation 4xx). Never retried.
 *
 * `code` is a short machine code that is safe to store and to log — never a provider message
 * body, which can quote the recipient.
 */

export type OutboundEmail = {
  /** Stable per row (`te:<id>`): every attempt of the same row carries the same key. */
  idempotencyKey: string;
  from: string;
  replyTo: string | null;
  to: string;
  subject: string;
  html: string;
  text: string;
};

export type SendResult =
  | { outcome: "sent"; providerMessageId: string | null }
  | { outcome: "retryable"; code: string; retryAfterMs: number | null }
  | { outcome: "permanent"; code: string };

export type EmailProvider = {
  /** Short provider name stored on the row (≤ 40 chars). */
  readonly name: string;
  send(message: OutboundEmail): Promise<SendResult>;
};

export function idempotencyKeyFor(rowId: number): string {
  return `te:${rowId}`;
}

/** Classifies an HTTP answer. `errorName` is the provider's own machine error name, if any. */
export function classifyHttpStatus(
  status: number,
  errorName: string | null,
  retryAfterMs: number | null
): SendResult | null {
  if (status >= 200 && status < 300) return null;
  if (status === 429) return { outcome: "retryable", code: "rate_limited", retryAfterMs };
  if (status >= 500) return { outcome: "retryable", code: `provider_${status}`, retryAfterMs };
  // Same key while the first request is still in flight: the first one decides; ask again later.
  if (status === 409 && errorName === "concurrent_idempotent_requests") {
    return { outcome: "retryable", code: "idempotency_in_flight", retryAfterMs };
  }
  // A rejected or missing credential is configuration, not this message: fixable, so retryable
  // within the row's lifetime rather than burning every pending email as FAILED.
  if (status === 401 || status === 403) {
    return { outcome: "retryable", code: `provider_auth_${status}`, retryAfterMs: null };
  }
  return { outcome: "permanent", code: `rejected_${status}` };
}

/** `Retry-After` as seconds or an HTTP date → ms, bounded to [0, 1h]. */
export function parseRetryAfter(value: string | null, now: Date): number | null {
  if (!value) return null;
  const v = value.trim();
  let ms: number | null = null;
  if (/^\d+$/.test(v)) ms = Number(v) * 1000;
  else {
    const at = Date.parse(v);
    if (!Number.isNaN(at)) ms = at - now.getTime();
  }
  if (ms === null || !Number.isFinite(ms)) return null;
  return Math.min(Math.max(ms, 0), 60 * 60 * 1000);
}
