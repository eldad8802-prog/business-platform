/**
 * Route-facing webhook handler.
 *
 * Wraps `processPaymentWebhook` so the route always answers 200 { ok: true } —
 * even on a bad/duplicate/unrecognized event or an unexpected error — to avoid
 * provider retry storms. Idempotency and status logic live in the service/DB.
 * No sensitive error detail is returned to the caller.
 *
 * ONE exception, added in CASA Wave E: a webhook addressed to a provider that
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
import { isPaymentProviderEnabled } from "./providers/provider-availability";

export interface WebhookHandlerResult {
  status: number;
  body: { ok: true } | { ok: false; error: "provider_not_supported" };
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
    // Structured, non-sensitive log only — never echo the payload back.
    console.info("[payments-webhook]", {
      provider: input.provider,
      eventId: result.eventId,
      processingStatus: result.processingStatus,
      duplicate: result.duplicate,
      paymentRequestId: result.paymentRequestId,
      reason: result.reason,
    });
  } catch (error) {
    console.warn(
      "[payments-webhook] processing failed:",
      error instanceof Error ? error.message : String(error)
    );
  }
  return { status: 200, body: { ok: true } };
}
