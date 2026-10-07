/**
 * Resend adapter — the REST API over `fetch`, no SDK dependency.
 *
 *   POST https://api.resend.com/emails
 *   Authorization: Bearer <RESEND_API_KEY>
 *   Idempotency-Key: te:<row id>      (Resend keeps it 24h: a repeat returns the first result)
 *
 * Nothing from the request or the response body is logged or stored except the message id and
 * the provider's machine error name (folded into a short code by the classifier).
 */

import {
  classifyHttpStatus,
  parseRetryAfter,
  type EmailProvider,
  type OutboundEmail,
  type SendResult,
} from "./provider";

export const RESEND_ENDPOINT = "https://api.resend.com/emails";
/** Well under the delivery lease, so a timed-out attempt is over before anyone may re-claim it. */
export const RESEND_TIMEOUT_MS = 15_000;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function createResendProvider(opts: {
  apiKey: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
  timeoutMs?: number;
}): EmailProvider {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = opts.now ?? (() => new Date());
  const timeoutMs = opts.timeoutMs ?? RESEND_TIMEOUT_MS;

  return {
    name: "resend",
    async send(message: OutboundEmail): Promise<SendResult> {
      const body: Record<string, unknown> = {
        from: message.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      };
      if (message.replyTo) body.reply_to = message.replyTo;

      let res: Response;
      try {
        res = await fetchImpl(RESEND_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": message.idempotencyKey,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
          cache: "no-store",
        });
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        return { outcome: "retryable", code: timedOut ? "timeout" : "network", retryAfterMs: null };
      }

      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      const errorName =
        json && typeof json === "object" && typeof (json as { name?: unknown }).name === "string"
          ? (json as { name: string }).name
          : null;

      const failure = classifyHttpStatus(res.status, errorName, parseRetryAfter(res.headers.get("retry-after"), now()));
      if (failure) return failure;

      const id =
        json && typeof json === "object" && typeof (json as { id?: unknown }).id === "string"
          ? (json as { id: string }).id.slice(0, 200)
          : null;
      return { outcome: "sent", providerMessageId: id };
    },
  };
}
