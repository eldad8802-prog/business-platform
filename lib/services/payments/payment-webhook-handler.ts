/**
 * Route-facing webhook handler.
 *
 * Wraps `processPaymentWebhook` so the route always answers 200 { ok: true } —
 * even on a bad/duplicate/unrecognized event or an unexpected error — to avoid
 * provider retry storms. Idempotency and status logic live in the service/DB.
 * No sensitive error detail is returned to the caller.
 */

import {
  processPaymentWebhook,
  type ProcessWebhookDeps,
  type ProcessWebhookInput,
} from "./payment-webhook.service";

export interface WebhookHandlerResult {
  status: number;
  body: { ok: true };
}

export async function handleProviderWebhook(
  input: ProcessWebhookInput,
  deps: ProcessWebhookDeps
): Promise<WebhookHandlerResult> {
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
