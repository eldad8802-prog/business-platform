/**
 * Inbound webhook processing.
 *
 *   1. persist the raw webhook BEFORE processing (idempotent on
 *      provider + providerEventId)
 *   2. verify signature / authenticity (provider-specific, if any)
 *   3. parse the event
 *   4. locate the PaymentRequest by providerRequestId
 *   5. create a PaymentTransaction
 *   6. update the PaymentRequest to PAID / FAILED / CANCELLED
 *   7. idempotency: a duplicate webhook never creates a double charge or a
 *      wrong status
 *   8. (future) hand off to Billing/Receipt — prepared, not auto-fired here
 *
 * This function NEVER throws on a bad/duplicate/unrecognized webhook: it
 * records the outcome on the event row and returns a result object, so the
 * route can always answer 200 and the provider does not retry-storm.
 */

import {
  isTerminalRequestStatus,
  type PaymentProvider,
  type PaymentRequestStatus,
  type PaymentStore,
  type PaymentTransactionStatus,
  type PaymentWebhookProcessingStatus,
} from "./payments.types";
import type {
  ParsedPaymentOutcome,
  PaymentProviderAdapter,
} from "./providers/payment-provider.types";

export interface ProcessWebhookInput {
  provider: PaymentProvider;
  rawBody: string;
  headers?: Record<string, string | null | undefined>;
  /** Optional pre-parsed JSON body, when the route already parsed it. */
  parsedBody?: unknown;
}

export interface ProcessWebhookDeps {
  store: PaymentStore;
  resolveProvider: (provider: PaymentProvider) => PaymentProviderAdapter;
  /** Optional webhook secret resolver (per provider). */
  resolveWebhookSecret?: (provider: PaymentProvider) => string | null;
  now?: () => Date;
}

export interface ProcessWebhookResult {
  ok: boolean;
  eventId: number;
  processingStatus: PaymentWebhookProcessingStatus;
  /** True when this exact event/effect was already applied. */
  duplicate: boolean;
  paymentRequestId: number | null;
  paymentRequestStatus: PaymentRequestStatus | null;
  reason: string | null;
}

function outcomeToTransactionStatus(
  outcome: ParsedPaymentOutcome
): PaymentTransactionStatus {
  switch (outcome) {
    case "PAID":
      return "PAID";
    case "CANCELLED":
      return "CANCELLED";
    case "FAILED":
      return "FAILED";
    default:
      return "PENDING";
  }
}

function outcomeToRequestStatus(
  outcome: ParsedPaymentOutcome
): PaymentRequestStatus | null {
  switch (outcome) {
    case "PAID":
      return "PAID";
    case "FAILED":
      return "FAILED";
    case "CANCELLED":
      return "CANCELLED";
    default:
      return null; // PENDING / UNKNOWN — do not move the request
  }
}

export async function processPaymentWebhook(
  input: ProcessWebhookInput,
  deps: ProcessWebhookDeps
): Promise<ProcessWebhookResult> {
  const now = deps.now ?? (() => new Date());
  const headers = input.headers ?? {};
  const adapter = deps.resolveProvider(input.provider);

  // Parse first (never throws) so we can extract the event id for dedup.
  let parsed;
  try {
    parsed = adapter.parseWebhook({
      rawBody: input.rawBody,
      parsedBody: input.parsedBody,
    });
  } catch {
    parsed = null;
  }

  // 1. persist raw, idempotent on (provider, providerEventId).
  const { created, event } = await deps.store.insertWebhookEventIfNew({
    provider: input.provider,
    eventType: parsed?.eventType ?? null,
    providerEventId: parsed?.providerEventId ?? null,
    payload: input.parsedBody ?? input.rawBody,
  });

  // 7. duplicate event already fully processed — no-op.
  if (!created && event.processingStatus === "PROCESSED") {
    return {
      ok: true,
      eventId: event.id,
      processingStatus: event.processingStatus,
      duplicate: true,
      paymentRequestId: null,
      paymentRequestStatus: null,
      reason: "duplicate_event",
    };
  }

  const fail = async (
    status: PaymentWebhookProcessingStatus,
    reason: string,
    paymentRequestId: number | null = null,
    paymentRequestStatus: PaymentRequestStatus | null = null
  ): Promise<ProcessWebhookResult> => {
    await deps.store.updateWebhookEvent(event.id, {
      processingStatus: status,
      processedAt: now(),
      error: reason.slice(0, 500),
    });
    return {
      ok: false,
      eventId: event.id,
      processingStatus: status,
      duplicate: false,
      paymentRequestId,
      paymentRequestStatus,
      reason,
    };
  };

  // 2. verify authenticity.
  const secret = deps.resolveWebhookSecret?.(input.provider) ?? null;
  const verify = adapter.verifyWebhook({
    rawBody: input.rawBody,
    headers,
    secret,
  });
  if (!verify.ok) {
    return fail("FAILED", `signature: ${verify.reason}`);
  }

  // 3. require a usable parse.
  if (!parsed || parsed.outcome === "UNKNOWN") {
    return fail("UNMATCHED", "unparseable_or_unknown_outcome");
  }

  // 4. locate the payment request.
  if (!parsed.providerRequestId) {
    return fail("UNMATCHED", "missing_provider_request_id");
  }
  const request = await deps.store.findPaymentRequestByProviderRequestId(
    input.provider,
    parsed.providerRequestId
  );
  if (!request) {
    return fail("UNMATCHED", "no_matching_payment_request");
  }

  // 7. transaction-level idempotency: same provider transaction already
  // recorded => do not create a second one or re-move the request.
  if (parsed.providerTransactionId) {
    const existingTx =
      await deps.store.findTransactionByProviderTransactionId(
        input.provider,
        parsed.providerTransactionId
      );
    if (existingTx) {
      await deps.store.updateWebhookEvent(event.id, {
        processingStatus: "PROCESSED",
        processedAt: now(),
      });
      return {
        ok: true,
        eventId: event.id,
        processingStatus: "PROCESSED",
        duplicate: true,
        paymentRequestId: request.id,
        paymentRequestStatus: request.status,
        reason: "duplicate_transaction",
      };
    }
  }

  // 5. record the transaction.
  const txStatus = outcomeToTransactionStatus(parsed.outcome);
  await deps.store.createTransaction({
    paymentRequestId: request.id,
    provider: input.provider,
    providerTransactionId: parsed.providerTransactionId,
    amount: parsed.amount ?? request.amount,
    currency: parsed.currency ?? request.currency,
    status: txStatus,
    rawPayload: input.parsedBody ?? input.rawBody,
  });

  // 6. move the payment request — idempotently and without overwriting an
  // existing terminal state.
  const nextStatus = outcomeToRequestStatus(parsed.outcome);
  let finalStatus: PaymentRequestStatus = request.status;
  if (nextStatus && !isTerminalRequestStatus(request.status)) {
    const updated = await deps.store.updatePaymentRequest(request.id, {
      status: nextStatus,
      paidAt: nextStatus === "PAID" ? now() : null,
    });
    finalStatus = updated.status;
  }

  // 8. Billing/Receipt hand-off is intentionally NOT auto-fired in P1.
  // A successful PAID transition is the integration point; wiring it to a
  // Receipt requires the receipt engine to be ready and is a separate step.

  await deps.store.updateWebhookEvent(event.id, {
    processingStatus: "PROCESSED",
    processedAt: now(),
  });

  return {
    ok: true,
    eventId: event.id,
    processingStatus: "PROCESSED",
    duplicate: false,
    paymentRequestId: request.id,
    paymentRequestStatus: finalStatus,
    reason: null,
  };
}
