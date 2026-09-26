/**
 * Inbound webhook processing — the SIGNAL side of inbound money.
 *
 *   1. structural / signature gate (provider-specific)
 *   2. parse the event (never authority)
 *   3. correlate to a PaymentRequest THIS system issued (routing index,
 *      + the round-tripped correlation value) — before anything is persisted
 *   4. persist the event (idempotent on provider + providerEventId)
 *   5. enter the request's tenant and ask the AUTHORITY through the one
 *      canonical path (payment-verification.service), which records the money,
 *      moves the request and settles accounting — exactly once
 *
 * M1: an event is CONSUMED (PROCESSED) only when the authority reached a
 * conclusion. A provider that has no outcome yet leaves the event RECEIVED, and
 * a failed ask leaves it FAILED — both are re-asked on redelivery, and inbound
 * reconciliation asks the provider independently of any event row, so a signal
 * that came early, failed, or never came cannot lose a payment.
 *
 * This function NEVER throws on a bad/duplicate/unrecognized webhook: it
 * records the outcome on the event row and returns a result object, so the
 * route can always answer 200 and the provider does not retry-storm.
 */

import type {
  PaymentConnectionRecord,
  PaymentProvider,
  PaymentRequestRecord,
  PaymentRequestStatus,
  PaymentStore,
  PaymentWebhookProcessingStatus,
} from "./payments.types";
import { runWithTenantContext } from "@/lib/tenant/context";
import type {
  PaymentProviderAdapter,
  VerifyWebhookResult,
} from "./providers/payment-provider.types";
import { recordPaymentAuditEvent } from "./payment-audit.service";
import { hashCallbackSecret } from "./payment-callback-secret";
import {
  resolvePaymentAuthoritatively,
  type VerifiedPaidEvent,
} from "./payment-verification.service";

export type { VerifiedPaidEvent };

export interface ProcessWebhookInput {
  provider: PaymentProvider;
  rawBody: string;
  headers?: Record<string, string | null | undefined>;
  /** Optional pre-parsed JSON body, when the route already parsed it. */
  parsedBody?: unknown;
  /**
   * The opaque per-request secret lifted from the callback URL, for a provider
   * that signs nothing and whose callback carries no session id.
   *
   * Supplied by the ROUTE from the request path, never from the body, so a
   * payload cannot nominate its own route in. When present it replaces
   * `providerRequestId` as the correlation channel; the rest of the
   * orchestration — authority, amount and currency coherence, idempotency — is
   * unchanged and still applies.
   */
  callbackSecret?: string | null;
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
  /**
   * C3 — finish the accounting for a verified incoming payment: one receipt,
   * allocated to its invoice. Called with the PaymentTransaction id after it is
   * durably recorded (with its PENDING settlement), and again when a provider
   * redelivers the same settlement. Best-effort here by design: the money is
   * already PAID and the settlement row is durable, so a failure is retried
   * from local state — it must never turn a verified payment into a failure.
   */
  settleAccounting?: (event: { businessId: number; paymentTransactionId: number }) => Promise<void>;
  now?: () => Date;
}

export interface ProcessWebhookResult {
  ok: boolean;
  /**
   * The persisted PaymentWebhookEvent id, or null when the callback was
   * rejected BEFORE persistence because it could not be correlated to a
   * payment flow this system created. Uncorrelated callbacks deliberately
   * leave no database row — see `processPaymentWebhook`.
   */
  eventId: number | null;
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

export async function processPaymentWebhook(
  input: ProcessWebhookInput,
  deps: ProcessWebhookDeps
): Promise<ProcessWebhookResult> {
  const now = deps.now ?? (() => new Date());
  const headers = input.headers ?? {};
  const adapter = deps.resolveProvider(input.provider);

  /**
   * Pre-persistence rejection. The callback never became a stored event, so
   * there is nothing to update — it is refused and dropped.
   *
   * Wave D ordering change: correlation now happens BEFORE persistence. The
   * endpoint is public and (for CardCom) cannot be authenticated at the
   * transport layer, so persisting every inbound body handed any anonymous
   * caller an unbounded write into `PaymentWebhookEvent` and an unbounded
   * outbound provider lookup. A caller who cannot reproduce identifiers this
   * system generated now leaves no trace beyond a log line.
   */
  const reject = (
    reason: string,
    status: PaymentWebhookProcessingStatus = "UNMATCHED"
  ): ProcessWebhookResult => {
    console.warn("[payments-webhook] rejected before persistence", {
      provider: input.provider,
      reason,
    });
    return {
      ok: false,
      eventId: null,
      processingStatus: status,
      duplicate: false,
      paymentRequestId: null,
      paymentRequestStatus: null,
      reason,
      verified: null,
    };
  };

  // A. AUTHENTICATION GATE. Fail closed: an adapter that cannot vouch for the
  // shape — or, where the provider signs, the signature — of this body stops
  // the request here. No provider may accept by default.
  //
  // AWAITED. The adapter contract is asynchronous so that a provider which
  // authenticates its callback through its own API can be expressed at all.
  // Two consequences are load-bearing, and both are pinned by tests:
  //   - nothing below this point runs until verification has RESOLVED, so a
  //     slow verification cannot let processing race ahead of it;
  //   - a REJECTED promise is a FAILURE, never a pass. An adapter that throws
  //     is a broken adapter, and a broken adapter must not be able to
  //     authenticate anything — so the catch refuses instead of falling through.
  const secret = deps.resolveWebhookSecret?.(input.provider) ?? null;
  let verify: VerifyWebhookResult;
  try {
    verify = await adapter.verifyWebhook({
      rawBody: input.rawBody,
      headers,
      secret,
    });
  } catch {
    return reject("verify: verification_error", "FAILED");
  }
  if (!verify.ok) {
    return reject(`verify: ${verify.reason}`, "FAILED");
  }

  // B. parse (never throws).
  let parsed;
  try {
    parsed = adapter.parseWebhook({
      rawBody: input.rawBody,
      parsedBody: input.parsedBody,
    });
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.outcome === "UNKNOWN") {
    return reject("unparseable_or_unknown_outcome");
  }
  // C. CORRELATION (read-only). The callback must resolve to a PaymentRequest
  // THIS system created. Both routes in go through PaymentProviderRouting and
  // its consistency gate, which also fixes the tenant; something we never
  // issued resolves to nothing and the callback is refused here, before any
  // write.
  //
  // TWO ROUTES, because providers correlate in two different ways.
  //
  //   - the provider's own session id, echoed on the callback;
  //   - the opaque secret in the callback URL, for a provider that issues no
  //     session id and signs nothing. The secret comes from the ROUTE's path,
  //     never from the body, so a payload cannot choose how it is correlated.
  //
  // The URL secret is preferred when present: it is the stronger claim of the
  // two, since it is unguessable and was handed only to the provider.
  const callbackSecretHash = input.callbackSecret
    ? hashCallbackSecret(input.callbackSecret)
    : null;

  let request: PaymentRequestRecord | null = null;

  if (callbackSecretHash) {
    request = await deps.store.findPaymentRequestByCallbackSecretHash(
      input.provider,
      callbackSecretHash
    );
    if (!request) {
      return reject("no_matching_payment_request");
    }
  } else {
    if (!parsed.providerRequestId) {
      return reject("missing_provider_request_id");
    }
    request = await deps.store.findPaymentRequestByProviderRequestId(
      input.provider,
      parsed.providerRequestId
    );
    if (!request) {
      return reject("no_matching_payment_request");
    }
  }

  // D. SECOND CORRELATION CHANNEL. When the provider echoes a Dubiz-issued
  // value through the round-trip (CardCom: `ReturnValue`, set to the
  // PaymentRequest id at LowProfile/Create), it must agree with the request the
  // identifier resolved to. A caller must therefore reproduce TWO values this
  // system generated, and a real identifier lifted from one flow cannot be
  // pointed at another.
  if (
    parsed.correlationValue != null &&
    String(parsed.correlationValue) !== String(request.id)
  ) {
    return reject("correlation_value_mismatch");
  }

  // E. DECLARED-AMOUNT GATE. The payload is never authoritative for money, and
  // the settlement below takes its amount from the stored request. But a body
  // that *claims* a different amount or currency than the request it points at
  // is incoherent, so it is refused rather than silently normalised.
  if (parsed.amount != null && String(parsed.amount) !== String(request.amount)) {
    return reject("amount_mismatch");
  }
  if (
    parsed.currency != null &&
    String(parsed.currency).toUpperCase() !== String(request.currency).toUpperCase()
  ) {
    return reject("currency_mismatch");
  }

  // F. Only a correlated callback is persisted. Idempotent on
  // (provider, providerEventId).
  const { created, event } = await deps.store.insertWebhookEventIfNew({
    provider: input.provider,
    eventType: parsed.eventType,
    providerEventId: parsed.providerEventId,
    payload: input.parsedBody ?? input.rawBody,
  });

  // G. duplicate event already fully processed — no-op.
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

  // D2/P7-W4E — TENANT BOUNDARY. Everything above is pre-context provider
  // bookkeeping on non-RLS surfaces (the webhook-event ledger and the routing
  // index). The tenant has now been derived from the STORED PaymentRequest —
  // never from the payload — so the entire remainder runs inside that
  // business's context, which is what lets the FORCE-RLS'd payment tables be
  // read and written at all. The provider verification call below stays OUTSIDE
  // any transaction: a context is ALS, not a tx, and each DB step opens its own
  // short transaction.
  // D2/AD-2A — ACCOUNT-DELETION GATE, placed exactly at the tenant boundary.
  // Bootstrap resolution above is deliberately still allowed: the webhook ledger and
  // the routing index are how we identify the event at all, and refusing to record a
  // received event would only make the provider retry it forever. What must not happen
  // is the next line — entering the tenant and creating operational state for a
  // business that is being erased. The event is recorded as terminally not-processed,
  // and the handler answers HTTP 200 regardless, so the provider stops retrying
  // without any tenant row being resurrected.
  const lifecycle = await deps.store.getBusinessLifecycle(request.businessId);
  if (lifecycle !== "ACTIVE") {
    return fail(
      "FAILED",
      `business_quarantined:${lifecycle ?? "UNKNOWN"}`,
      request.id,
      request.status
    );
  }

  // The tenant is the STORED request's — never the payload's (CI-W4E-1).
  // `routed` keeps the narrowed type inside the async closure.
  const routed: PaymentRequestRecord = request;
  return runWithTenantContext({ businessId: request.businessId }, async () => {
    // AUTHORITY. The webhook is only a signal; the one canonical path asks the
    // provider and alone may record money, move the request and settle
    // accounting (docs/payments-authority-principle-v1.md). The callback body
    // is kept only as the recorded row's raw evidence — never as authority.
    const resolution = await resolvePaymentAuthoritatively(
      {
        request: routed,
        adapter,
        source: "WEBHOOK",
        rawPayload: input.parsedBody ?? input.rawBody,
      },
      deps
    );

    const consume = async (): Promise<void> => {
      await deps.store.updateWebhookEvent(event.id, {
        processingStatus: "PROCESSED",
        processedAt: now(),
        error: null,
      });
    };

    switch (resolution.kind) {
      case "SIGNAL_ONLY": {
        // A provider with no verification path yet (e.g. TRANZILA): the signal
        // is recorded and nothing settles. A webhook alone can NEVER produce PAID.
        await consume();
        await recordPaymentAuditEvent(deps.store, {
          businessId: routed.businessId,
          paymentRequestId: routed.id,
          eventType: "PAYMENT_SIGNAL_ONLY_NO_VERIFICATION",
          source: "SYSTEM",
          summary: `Webhook signal received for ${input.provider} request ${routed.id}; provider has no verification path — not settled`,
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
          paymentRequestId: routed.id,
          paymentRequestStatus: routed.status,
          reason: "signal_only_no_verification",
          verified: false,
        };
      }

      case "UNRESOLVED": {
        if (resolution.reason === "PROVIDER_OUTCOME_PENDING") {
          // M1 — an early signal. The provider has no outcome yet, so the
          // event is NOT consumed: a redelivery asks again, and reconciliation
          // asks regardless of this row.
          await deps.store.updateWebhookEvent(event.id, {
            processingStatus: "RECEIVED",
            processedAt: null,
            error: "awaiting_provider_outcome",
          });
          return {
            ok: true,
            eventId: event.id,
            processingStatus: "RECEIVED",
            duplicate: false,
            paymentRequestId: routed.id,
            paymentRequestStatus: routed.status,
            reason: "provider_outcome_pending",
            verified: null,
          };
        }
        const reason =
          resolution.reason === "NO_ACTIVE_CONNECTION"
            ? "verification_unavailable_no_active_connection"
            : resolution.reason === "VERIFICATION_ERROR"
              ? "verification_error"
              : resolution.reason.toLowerCase();
        return fail("FAILED", reason, routed.id, routed.status);
      }

      case "ALREADY_RECORDED": {
        await consume();
        return {
          ok: true,
          eventId: event.id,
          processingStatus: "PROCESSED",
          duplicate: true,
          paymentRequestId: routed.id,
          paymentRequestStatus: resolution.requestStatus,
          reason: "duplicate_transaction",
          verified: true,
        };
      }

      case "NO_CHANGE": {
        await consume();
        return {
          ok: true,
          eventId: event.id,
          processingStatus: "PROCESSED",
          duplicate: false,
          paymentRequestId: routed.id,
          paymentRequestStatus: resolution.requestStatus,
          reason: "request_not_open",
          verified: true,
        };
      }

      case "RECORDED": {
        await consume();
        return {
          ok: true,
          eventId: event.id,
          processingStatus: "PROCESSED",
          duplicate: false,
          paymentRequestId: routed.id,
          paymentRequestStatus: resolution.requestStatus,
          reason: null,
          verified: true,
        };
      }
    }
  });
}
