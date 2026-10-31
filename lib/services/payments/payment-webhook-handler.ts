/**
 * Route-facing webhook handler.
 *
 * Wraps `processPaymentWebhook` and decides the ONE thing a provider acts on: whether to send the callback again.
 * The decision lives in payment-webhook-failure.ts:
 *
 *   - 200 { ok: true } for every processed, duplicate, pending or refused callback, and for any error that is not
 *     an infrastructure failure — unchanged, so a bad / duplicate / unrecognized event never starts a retry storm
 *     and a refusal looks the same whether or not its identifiers exist;
 *   - 503 { ok: false, error: "temporarily_unavailable" } ONLY when the database or the provider's verification
 *     API was unavailable — the callback was not (fully) received, and a redelivery is safe (idempotent money row,
 *     one settlement per transaction, RECEIVED / FAILED events re-asked).
 *
 * No sensitive error detail is returned to the caller or logged: the log carries the error's class and machine
 * code only (never `error.message`, which for a database error can name the host).
 *
 * ONE further exception, added in CASA Wave E: a webhook addressed to a provider that
 * is not an active capability is refused HERE, before `processPaymentWebhook`
 * is entered. That ordering is the whole point — nothing is parsed, no provider
 * verification is invoked, and no `PaymentWebhookEvent`, `PaymentRequest`,
 * `PaymentTransaction` or `FinancialEvent` can be touched. Such a caller gets a
 * 404, because answering 200 { ok: true } for a capability that no longer
 * exists would claim a processing outcome that never happened.
 */

import {
  processPaymentWebhook,
  type ProcessWebhookDeps,
  type ProcessWebhookInput,
} from "./payment-webhook.service";
import { answerForError, answerForResult, webhookErrorLog } from "./payment-webhook-failure";
import { isPaymentProviderEnabled } from "./providers/provider-availability";

export interface WebhookHandlerResult {
  status: number;
  body: { ok: true } | { ok: false; error: "provider_not_supported" | "temporarily_unavailable" };
  /** Set with a 503: the Retry-After hint (seconds). Providers may follow their own schedule. */
  retryAfterSeconds?: number;
}

export async function handleProviderWebhook(
  input: ProcessWebhookInput,
  deps: ProcessWebhookDeps
): Promise<WebhookHandlerResult> {
  // Fail closed BEFORE any parsing, verification or persistence.
  if (!isPaymentProviderEnabled(input.provider)) {
    console.info("[payments-webhook] refused: provider not supported", {
      provider: input.provider,
    });
    return { status: 404, body: { ok: false, error: "provider_not_supported" } };
  }

  try {
    const result = await processPaymentWebhook(input, deps);
    const answer = answerForResult(result);
    // Structured, non-sensitive log only — never echo the payload back.
    console.info("[payments-webhook]", {
      provider: input.provider,
      eventId: result.eventId,
      processingStatus: result.processingStatus,
      duplicate: result.duplicate,
      paymentRequestId: result.paymentRequestId,
      reason: result.reason,
      answer: answer.status,
    });
    return answer;
  } catch (error) {
    const answer = answerForError(error);
    console.warn("[payments-webhook] processing failed", {
      provider: input.provider,
      ...webhookErrorLog(error),
      answer: answer.status,
    });
    return answer;
  }
}
