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
  type PaymentConnectionRecord,
  type PaymentProvider,
  type PaymentRequestStatus,
  type PaymentStore,
  type PaymentTransactionStatus,
  type PaymentWebhookProcessingStatus,
} from "./payments.types";
import { runWithTenantContext } from "@/lib/tenant/context";
import type {
  ParsedPaymentOutcome,
  PaymentProviderAdapter,
  ProviderPaymentStatus,
} from "./providers/payment-provider.types";
import { recordPaymentAuditEvent } from "./payment-audit.service";

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
  /**
   * Decrypts a connection's provider credential for verification calls.
   * Required for verification-capable providers; the credential is used
   * in-memory only and never persisted.
   */
  decryptConnectionCredential?: (
    connection: PaymentConnectionRecord
  ) => string | null;
  /**
   * Best-effort downstream hook fired ONLY on a verified PAID settlement, AFTER
   * the PaymentTransaction exists (so it carries the transaction id). Used to
   * project the money-in fact into Financial Control (FinancialEvent PAYMENT).
   * Its failure must never break the payment flow — the request is already PAID.
   */
  onVerifiedPaid?: (event: VerifiedPaidEvent) => Promise<void>;
  now?: () => Date;
}

export interface VerifiedPaidEvent {
  businessId: number;
  paymentRequestId: number;
  /** The verified settlement record id — the money-in fact's stable key. */
  transactionId: number;
  amount: string;
  currency: string;
  occurredAt: Date;
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
  /**
   * Authority boundary marker:
   *   true  — outcome established by provider verification (authority)
   *   false — legacy unverified path (provider has no verification yet)
   *   null  — no authority decision reached (failure / duplicate / non-terminal)
   */
  verified: boolean | null;
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

/** The audit event for a verified terminal outcome (PROVIDER-sourced). */
function verifiedOutcomeAuditType(
  outcome: ParsedPaymentOutcome
):
  | "PAYMENT_VERIFIED_PAID"
  | "PAYMENT_VERIFIED_FAILED"
  | "PAYMENT_VERIFIED_CANCELLED"
  | null {
  switch (outcome) {
    case "PAID":
      return "PAYMENT_VERIFIED_PAID";
    case "FAILED":
      return "PAYMENT_VERIFIED_FAILED";
    case "CANCELLED":
      return "PAYMENT_VERIFIED_CANCELLED";
    default:
      return null;
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
      verified: null,
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
      verified: null,
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
  // Hoisted: the null-check above does not narrow inside the tenant closure.
  const providerRequestId = parsed.providerRequestId;
  const request = await deps.store.findPaymentRequestByProviderRequestId(
    input.provider,
    parsed.providerRequestId
  );
  if (!request) {
    return fail("UNMATCHED", "no_matching_payment_request");
  }

  // D2/P7-W4E — TENANT BOUNDARY. Everything above is pre-context provider
  // bookkeeping on non-RLS surfaces (the webhook-event ledger and the routing
  // index). The tenant has now been derived from the STORED PaymentRequest —
  // never from the payload — so the entire remainder runs inside that
  // business's context, which is what lets the FORCE-RLS'd payment tables be
  // read and written at all. The provider verification call below stays OUTSIDE
  // any transaction: a context is ALS, not a tx, and each DB step opens its own
  // short transaction.
  return runWithTenantContext({ businessId: request.businessId }, async () => {

  // 5. AUTHORITY. The webhook is only a signal. A PaymentRequest may move to
  // PAID (and a PaymentTransaction may be recorded) ONLY from an outcome the
  // provider's own verification establishes. There is no unverified settlement
  // path — this enforces the Authority Principle uniformly across providers
  // (see docs/payments-authority-principle-v1.md):
  //
  //   - Verification-capable provider (adapter.getPaymentStatus present) =>
  //     verification IS the authority; the webhook's claimed outcome is ignored.
  //   - Provider with no verification path yet (e.g. TRANZILA today) => the
  //     webhook is recorded as a signal only and nothing settles. The request
  //     stays PENDING until the provider gains a real verification path. A
  //     webhook alone can NEVER produce PAID.
  if (typeof adapter.getPaymentStatus !== "function") {
    await deps.store.updateWebhookEvent(event.id, {
      processingStatus: "PROCESSED",
      processedAt: now(),
    });
    await recordPaymentAuditEvent(deps.store, {
      businessId: request.businessId,
      paymentRequestId: request.id,
      eventType: "PAYMENT_SIGNAL_ONLY_NO_VERIFICATION",
      source: "SYSTEM",
      summary: `Webhook signal received for ${input.provider} request ${request.id}; provider has no verification path — not settled`,
      metadata: {
        provider: input.provider,
        providerEventId: parsed.providerEventId,
        claimedOutcome: parsed.outcome,
      },
      occurredAt: now(),
    });
    return {
      ok: true,
      eventId: event.id,
      processingStatus: "PROCESSED",
      duplicate: false,
      paymentRequestId: request.id,
      paymentRequestStatus: request.status,
      reason: "signal_only_no_verification",
      verified: false,
    };
  }

  const connection = await deps.store.findActiveConnection(
    request.businessId,
    input.provider
  );
  if (!connection) {
    // Cannot establish authority without a connection => never PAID.
    await recordPaymentAuditEvent(deps.store, {
      businessId: request.businessId,
      paymentRequestId: request.id,
      eventType: "PAYMENT_VERIFICATION_UNAVAILABLE",
      source: "SYSTEM",
      summary: `Verification unavailable for ${input.provider} request ${request.id}: no active connection`,
      metadata: { provider: input.provider },
      occurredAt: now(),
    });
    return fail(
      "FAILED",
      "verification_unavailable_no_active_connection",
      request.id,
      request.status
    );
  }
  const credential = deps.decryptConnectionCredential?.(connection) ?? null;

  let status: ProviderPaymentStatus;
  try {
    status = await adapter.getPaymentStatus({
      providerRequestId,
      merchantId: connection.merchantId,
      credential,
    });
  } catch {
    // Fail safe: a failed/erroring verification can never produce PAID.
    await recordPaymentAuditEvent(deps.store, {
      businessId: request.businessId,
      paymentRequestId: request.id,
      eventType: "PAYMENT_VERIFICATION_ERROR",
      source: "SYSTEM",
      summary: `Verification call failed for ${input.provider} request ${request.id}`,
      metadata: { provider: input.provider },
      occurredAt: now(),
    });
    return fail("FAILED", "verification_error", request.id, request.status);
  }

  const authoritativeOutcome = status.outcome;
  const authoritativeTransactionId =
    status.providerTransactionId ?? parsed.providerTransactionId;
  const verified = true;

  // 6/7/8. Only a terminal authoritative outcome (PAID/FAILED/CANCELLED) may
  // create a transaction or move the request. Non-terminal outcomes
  // (PENDING/UNKNOWN) never settle anything.
  const nextStatus = outcomeToRequestStatus(authoritativeOutcome);
  let finalStatus: PaymentRequestStatus = request.status;

  if (nextStatus) {
    // transaction-level idempotency on the authoritative transaction id.
    if (authoritativeTransactionId) {
      const existingTx =
        await deps.store.findTransactionByProviderTransactionId(
          input.provider,
          authoritativeTransactionId
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
          verified,
        };
      }
    }

    // Record the verified transaction. The read-then-write duplicate check
    // above narrows the common case, but it is a RACE: two concurrent
    // callbacks for one settlement both read "no transaction" and both create
    // one. W4E-A moved the real guarantee into the database — a unique
    // (provider, providerTransactionId) — so the loser of the race lands here
    // as a constraint violation and is treated as exactly what it is: a
    // duplicate, with no second transaction and no second financial effect.
    let transaction;
    try {
      transaction = await deps.store.createTransaction({
        paymentRequestId: request.id,
        provider: input.provider,
        providerTransactionId: authoritativeTransactionId,
        amount: parsed.amount ?? request.amount,
        currency: parsed.currency ?? request.currency,
        status: outcomeToTransactionStatus(authoritativeOutcome),
        rawPayload: input.parsedBody ?? input.rawBody,
      });
    } catch (error) {
      const isDuplicate =
        typeof error === "object" && error !== null &&
        (error as { code?: string }).code === "P2002";
      if (!isDuplicate) throw error;
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
        verified,
      };
    }

    // move the request — idempotently, without overwriting a terminal state.
    if (!isTerminalRequestStatus(request.status)) {
      const updated = await deps.store.updatePaymentRequest(request.id, {
        status: nextStatus,
        paidAt: nextStatus === "PAID" ? now() : null,
      });
      finalStatus = updated.status;
    }

    // audit the verified, provider-established settlement outcome.
    const verifiedType = verifiedOutcomeAuditType(authoritativeOutcome);
    if (verifiedType) {
      await recordPaymentAuditEvent(deps.store, {
        businessId: request.businessId,
        paymentRequestId: request.id,
        eventType: verifiedType,
        source: "PROVIDER",
        summary: `Provider verification established ${authoritativeOutcome} for ${input.provider} request ${request.id}`,
        metadata: {
          provider: input.provider,
          providerTransactionId: authoritativeTransactionId,
          outcome: authoritativeOutcome,
        },
        occurredAt: now(),
      });
    }

    // Financial Control projection: a verified PAID settlement is money actually
    // received. Fire the hook ONLY for PAID, AFTER the transaction exists, keyed
    // on the transaction id. Best-effort — a downstream failure never breaks the
    // payment, which is already PAID.
    if (authoritativeOutcome === "PAID") {
      try {
        await deps.onVerifiedPaid?.({
          businessId: request.businessId,
          paymentRequestId: request.id,
          transactionId: transaction.id,
          amount: transaction.amount,
          currency: transaction.currency,
          occurredAt: now(),
        });
      } catch (err) {
        console.error("onVerifiedPaid hook error:", err);
      }
    }
  }

  // Billing/Receipt hand-off is intentionally NOT auto-fired here. A verified
  // PAID transition is the integration point; wiring it to a Receipt requires
  // the receipt engine and is a separate step.

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
    verified,
  };
});
}
