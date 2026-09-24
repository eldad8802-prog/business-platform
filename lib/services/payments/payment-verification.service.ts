/**
 * M1 — THE authoritative path for inbound money.
 *
 * "If the provider took money, Dubiz eventually knows about it exactly once."
 *
 * A webhook is a SIGNAL that something may have happened. The provider's own
 * verification is the AUTHORITY on what did. Two callers ask the authority:
 *
 *   - the webhook, promptly, when the provider signals;
 *   - inbound reconciliation, on a schedule, for every request that is not yet
 *     known to be paid — which is how a payment whose webhook was lost, came
 *     too early, or failed to verify is still discovered.
 *
 * Both call THIS function, and it is the only code that turns a provider's
 * answer into a PaymentTransaction, a request status and a settlement. There is
 * no second recording path and no second settlement: a recorded payment goes to
 * the one canonical C3 settlement (`settleAccounting`).
 *
 * RULES
 *
 *   PAID is recorded only with the provider's OWN transaction id and its OWN
 *   verified amount and currency. Missing either, nothing is recorded and the
 *   request stays open for the next ask: an answer that cannot be keyed or
 *   priced is not settled by inference.
 *
 *   Exactly once is the database's job: UNIQUE (provider, providerTransactionId)
 *   on the money row, and the settlement opened in the same transaction. Two
 *   concurrent callers (webhook + reconciliation, or two runs) both reach the
 *   insert; one wins and the other re-reads the winner.
 *
 *   A provider transaction id already recorded against a DIFFERENT request is a
 *   conflict — never merged, never recorded twice.
 *
 *   Money truth wins over the ask. A verified payment on a request the owner
 *   cancelled, or that lapsed or failed, is still recorded and settled, and the
 *   request follows the money to PAID (the prior state stays in the audit
 *   trail). Cancellation stays what it is — Dubiz stopped asking; it is never
 *   reinterpreted as a provider-side void.
 *
 *   A verified amount or currency that differs from the request is recorded AS
 *   THE PROVIDER STATES IT — that is what moved — and the settlement pauses on
 *   an explicit attention reason with the evidence in the audit trail. It is
 *   never normalised to the requested figure.
 *
 *   PENDING / UNKNOWN, a verification error, a missing connection: nothing is
 *   recorded and nothing is inferred. The request stays open.
 *
 * Must run inside the request's own tenant context.
 */

import { getTenantContext } from "@/lib/tenant/context";
import { recordPaymentAuditEvent, type PaymentAuditEventType } from "./payment-audit.service";
import type {
  PaymentConnectionRecord,
  PaymentRequestRecord,
  PaymentRequestStatus,
  PaymentStore,
  PaymentTransactionRecord,
} from "./payments.types";
import type {
  PaymentProviderAdapter,
  ProviderPaymentStatus,
} from "./providers/payment-provider.types";

export type VerificationSource = "WEBHOOK" | "RECONCILIATION";

export interface VerifiedPaidEvent {
  businessId: number;
  paymentRequestId: number;
  /** The verified settlement record id — the money-in fact's stable key. */
  transactionId: number;
  amount: string;
  currency: string;
  occurredAt: Date;
}

export interface AuthoritativeVerificationDeps {
  store: PaymentStore;
  decryptConnectionCredential?: (connection: PaymentConnectionRecord) => string | null;
  /** Best-effort, idempotent money-in projection (FinancialEvent PAYMENT). */
  onVerifiedPaid?: (event: VerifiedPaidEvent) => Promise<void>;
  /** The canonical C3 settlement. Best-effort here; recovery retries it. */
  settleAccounting?: (event: { businessId: number; paymentTransactionId: number }) => Promise<void>;
  now?: () => Date;
}

export type UnresolvedReason =
  /** No active connection — the authority cannot be asked. */
  | "NO_ACTIVE_CONNECTION"
  /** The verification call failed (network, timeout, HTTP, bad body). */
  | "VERIFICATION_ERROR"
  /** The provider has no conclusive outcome yet. */
  | "PROVIDER_OUTCOME_PENDING"
  /** PAID, but without the provider's own transaction id. */
  | "PAID_WITHOUT_PROVIDER_TRANSACTION_ID"
  /** PAID, but without a verified positive amount and currency. */
  | "PAID_WITHOUT_VERIFIED_AMOUNT"
  /** The provider's transaction id is already another request's money. */
  | "PROVIDER_TRANSACTION_CONFLICT";

/** Unresolved reasons that are not "not yet" but "something is wrong". */
export const ANOMALOUS_UNRESOLVED_REASONS: ReadonlySet<UnresolvedReason> = new Set<UnresolvedReason>([
  "PAID_WITHOUT_PROVIDER_TRANSACTION_ID",
  "PAID_WITHOUT_VERIFIED_AMOUNT",
  "PROVIDER_TRANSACTION_CONFLICT",
]);

export type AuthoritativeResolution =
  /** The adapter has no verification path; a signal cannot settle anything. */
  | { kind: "SIGNAL_ONLY" }
  | { kind: "UNRESOLVED"; reason: UnresolvedReason; detail: string | null }
  /** A new money row (or a FAILED/CANCELLED row) was recorded by THIS call. */
  | {
      kind: "RECORDED";
      outcome: "PAID" | "FAILED" | "CANCELLED";
      transactionId: number;
      requestStatus: PaymentRequestStatus;
      amountMismatch: boolean;
      currencyMismatch: boolean;
      /** The request's status before the money arrived, when it was not PENDING. */
      paidAfterClosedStatus: PaymentRequestStatus | null;
    }
  /** The provider's transaction was already recorded — nothing new was written. */
  | {
      kind: "ALREADY_RECORDED";
      transactionId: number;
      requestStatus: PaymentRequestStatus;
      /** True when this call brought a stale request status up to PAID. */
      statusRepaired: boolean;
    }
  /** A verified FAILED/CANCELLED for a request that is no longer open: no-op. */
  | { kind: "NO_CHANGE"; outcome: "FAILED" | "CANCELLED"; requestStatus: PaymentRequestStatus };

/** Statuses a verified payment may move to PAID. PAID itself is final. */
const PAYABLE_FROM: readonly PaymentRequestStatus[] = ["PENDING", "FAILED", "CANCELLED", "EXPIRED"];

// --- money helpers ------------------------------------------------------------

const ZERO = BigInt(0);
const HUNDRED = BigInt(100);

/**
 * A non-negative decimal amount with at most two decimals → integer minor
 * units, or null. Exact (BigInt): DECIMAL(18,2) exceeds a float's integers.
 */
export function toMinorUnits(amount: string | null | undefined): bigint | null {
  if (amount == null) return null;
  const m = /^\s*(\d+)(?:\.(\d{1,2}))?\s*$/.exec(String(amount));
  if (!m) return null;
  return BigInt(m[1]) * HUNDRED + BigInt((m[2] ?? "").padEnd(2, "0"));
}

/** A positive amount as a canonical "123.45" string, or null. */
export function normaliseAmount(amount: string | null | undefined): string | null {
  const minor = toMinorUnits(amount);
  if (minor == null || minor <= ZERO) return null;
  const cents = (minor % HUNDRED).toString().padStart(2, "0");
  return `${(minor / HUNDRED).toString()}.${cents}`;
}

function normaliseCurrency(currency: string | null | undefined): string | null {
  const c = (currency ?? "").trim().toUpperCase();
  return c === "" ? null : c;
}

function normaliseProviderId(id: string | null | undefined): string | null {
  const s = id == null ? "" : String(id).trim();
  return s === "" ? null : s;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

// --- the path -------------------------------------------------------------------

export interface ResolvePaymentInput {
  /** The STORED request, read inside its own tenant. */
  request: PaymentRequestRecord;
  adapter: PaymentProviderAdapter;
  source: VerificationSource;
  /**
   * What is kept on a newly recorded money row as its raw evidence. The webhook
   * passes the callback body it always kept; reconciliation passes a summary of
   * the provider's authoritative answer.
   */
  rawPayload?: unknown;
}

export async function resolvePaymentAuthoritatively(
  input: ResolvePaymentInput,
  deps: AuthoritativeVerificationDeps
): Promise<AuthoritativeResolution> {
  const { request, adapter, source } = input;
  const store = deps.store;
  const now = deps.now ?? (() => new Date());
  const provider = request.provider;

  const tenant = getTenantContext();
  if (!tenant || tenant.businessId !== request.businessId) {
    throw new Error("resolvePaymentAuthoritatively must run inside the request's own tenant context");
  }

  const audit = (
    eventType: PaymentAuditEventType,
    summary: string,
    metadata: Record<string, unknown>,
    auditSource: "SYSTEM" | "PROVIDER" = "SYSTEM"
  ) =>
    recordPaymentAuditEvent(store, {
      businessId: request.businessId,
      paymentRequestId: request.id,
      eventType,
      source: auditSource,
      summary,
      metadata: { provider, source, ...metadata },
      occurredAt: now(),
    });

  // An anomaly is recorded once per request, not once per ask: reconciliation
  // asks again every run, and the trail must stay readable.
  const auditOnce = async (
    eventType: PaymentAuditEventType,
    summary: string,
    metadata: Record<string, unknown>
  ) => {
    try {
      const prior = await store.listAuditEvents(request.businessId, {
        paymentRequestId: request.id,
        eventType,
        limit: 1,
      });
      if (prior.length > 0) return;
    } catch {
      // A failed read must not suppress the evidence; fall through and write.
    }
    await audit(eventType, summary, metadata);
  };

  if (typeof adapter.getPaymentStatus !== "function") {
    return { kind: "SIGNAL_ONLY" };
  }

  const connection = await store.findActiveConnection(request.businessId, provider);
  if (!connection) {
    const write = source === "WEBHOOK" ? audit : auditOnce;
    await write(
      "PAYMENT_VERIFICATION_UNAVAILABLE",
      `Verification unavailable for ${provider} request ${request.id}: no active connection`,
      {}
    );
    return { kind: "UNRESOLVED", reason: "NO_ACTIVE_CONNECTION", detail: null };
  }
  const credential = deps.decryptConnectionCredential?.(connection) ?? null;

  let status: ProviderPaymentStatus;
  try {
    status = await adapter.getPaymentStatus({
      // The STORED request's provider id and our own id — never a payload's.
      providerRequestId: request.providerRequestId,
      merchantId: connection.merchantId,
      credential,
      correlationValue: String(request.id),
    });
  } catch (error) {
    // A failed ask establishes nothing. Nothing is recorded, nothing inferred.
    // The webhook records each failure (as it always did); reconciliation
    // reports failures in its run report instead of writing a row per run.
    if (source === "WEBHOOK") {
      await audit("PAYMENT_VERIFICATION_ERROR", `Verification call failed for ${provider} request ${request.id}`, {});
    }
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    return { kind: "UNRESOLVED", reason: "VERIFICATION_ERROR", detail: code || null };
  }

  const outcome = status.outcome;
  if (outcome !== "PAID" && outcome !== "FAILED" && outcome !== "CANCELLED") {
    return { kind: "UNRESOLVED", reason: "PROVIDER_OUTCOME_PENDING", detail: status.detail ?? null };
  }

  // Only the provider's own answer keys the money. A callback body's claimed
  // transaction id is never a substitute: it is unauthenticated.
  const providerTransactionId = normaliseProviderId(status.providerTransactionId);

  if (outcome === "PAID") {
    if (!providerTransactionId) {
      await auditOnce(
        "PAYMENT_VERIFIED_WITHOUT_TRANSACTION_ID",
        `${provider} reported PAID for request ${request.id} without its transaction id — not recorded`,
        {}
      );
      return { kind: "UNRESOLVED", reason: "PAID_WITHOUT_PROVIDER_TRANSACTION_ID", detail: null };
    }
    const verifiedAmount = normaliseAmount(status.verifiedAmount);
    const verifiedCurrency = normaliseCurrency(status.verifiedCurrency);
    if (!verifiedAmount || !verifiedCurrency) {
      await auditOnce(
        "PAYMENT_VERIFIED_WITHOUT_AMOUNT",
        `${provider} reported PAID for request ${request.id} without a verified amount and currency — not recorded`,
        {
          providerTransactionId,
          verifiedAmount: status.verifiedAmount ?? null,
          verifiedCurrency: status.verifiedCurrency ?? null,
        }
      );
      return { kind: "UNRESOLVED", reason: "PAID_WITHOUT_VERIFIED_AMOUNT", detail: null };
    }

    const existing = await store.findTransactionByProviderTransactionId(provider, providerTransactionId);
    if (existing) {
      return alreadyRecorded(existing);
    }

    let transaction: PaymentTransactionRecord;
    try {
      transaction = await store.createTransaction({
        paymentRequestId: request.id,
        provider,
        providerTransactionId,
        amount: verifiedAmount,
        currency: verifiedCurrency,
        status: "PAID",
        rawPayload: input.rawPayload ?? null,
        openAccountingSettlement: { businessId: request.businessId },
      });
    } catch (error) {
      // The database refused a second row for this provider transaction: a
      // concurrent caller recorded it first. Treat it as a duplicate ONLY when
      // the winning row can actually be read back; anything else surfaces.
      if (!isUniqueViolation(error)) throw error;
      const winner = await store.findTransactionByProviderTransactionId(provider, providerTransactionId);
      if (!winner) throw error;
      return alreadyRecorded(winner);
    }

    const requested = normaliseAmount(request.amount);
    const amountMismatch = requested !== verifiedAmount;
    const currencyMismatch = normaliseCurrency(request.currency) !== verifiedCurrency;
    const evidence = {
      providerTransactionId,
      requestedAmount: request.amount,
      requestedCurrency: request.currency,
      verifiedAmount,
      verifiedCurrency,
    };

    const previousStatus = request.status;
    const moved = await store.transitionPaymentRequestStatus(request.id, {
      from: PAYABLE_FROM,
      to: "PAID",
      paidAt: now(),
    });
    const current = moved ?? (await store.findPaymentRequestById(request.id));
    const paidAfterClosedStatus = moved && previousStatus !== "PENDING" ? previousStatus : null;

    await audit(
      "PAYMENT_VERIFIED_PAID",
      `Provider verification established PAID for ${provider} request ${request.id}`,
      { ...evidence, outcome },
      "PROVIDER"
    );
    if (paidAfterClosedStatus) {
      await audit(
        "PAYMENT_PAID_AFTER_REQUEST_CLOSED",
        `Money arrived for ${provider} request ${request.id} after it was ${paidAfterClosedStatus}; recorded and settled`,
        { ...evidence, previousStatus: paidAfterClosedStatus }
      );
    }
    if (amountMismatch) {
      await audit(
        "PAYMENT_VERIFIED_AMOUNT_MISMATCH",
        `${provider} verified ${verifiedAmount} for request ${request.id}, which asked for ${request.amount}; accounting paused`,
        evidence
      );
    }
    if (currencyMismatch) {
      await audit(
        "PAYMENT_VERIFIED_CURRENCY_MISMATCH",
        `${provider} verified ${verifiedCurrency} for request ${request.id}, which asked for ${request.currency}; accounting paused`,
        evidence
      );
    }

    await projectAndSettle(transaction);

    return {
      kind: "RECORDED",
      outcome: "PAID",
      transactionId: transaction.id,
      requestStatus: current?.status ?? "PAID",
      amountMismatch,
      currencyMismatch,
      paidAfterClosedStatus,
    };
  }

  // FAILED / CANCELLED — no money moved. Only an OPEN request records it; a
  // request already closed gains nothing from another "no", and repeating it
  // on every reconciliation run would only grow noise.
  if (request.status !== "PENDING") {
    return { kind: "NO_CHANGE", outcome, requestStatus: request.status };
  }
  if (providerTransactionId) {
    const existing = await store.findTransactionByProviderTransactionId(provider, providerTransactionId);
    if (existing) {
      if (existing.paymentRequestId !== request.id) {
        return conflict(providerTransactionId);
      }
      return { kind: "NO_CHANGE", outcome, requestStatus: request.status };
    }
  }
  let failedRow: PaymentTransactionRecord;
  try {
    failedRow = await store.createTransaction({
      paymentRequestId: request.id,
      provider,
      providerTransactionId,
      amount: normaliseAmount(status.verifiedAmount) ?? request.amount,
      currency: normaliseCurrency(status.verifiedCurrency) ?? request.currency,
      status: outcome,
      rawPayload: input.rawPayload ?? null,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return { kind: "NO_CHANGE", outcome, requestStatus: request.status };
  }
  const moved = await store.transitionPaymentRequestStatus(request.id, { from: ["PENDING"], to: outcome });
  await audit(
    outcome === "FAILED" ? "PAYMENT_VERIFIED_FAILED" : "PAYMENT_VERIFIED_CANCELLED",
    `Provider verification established ${outcome} for ${provider} request ${request.id}`,
    { providerTransactionId, outcome },
    "PROVIDER"
  );
  const after = moved ?? (await store.findPaymentRequestById(request.id));
  return {
    kind: "RECORDED",
    outcome,
    transactionId: failedRow.id,
    requestStatus: after?.status ?? request.status,
    amountMismatch: false,
    currencyMismatch: false,
    paidAfterClosedStatus: null,
  };

  // --- helpers that close over the request -----------------------------------

  async function conflict(providerTransactionId: string): Promise<AuthoritativeResolution> {
    await auditOnce(
      "PAYMENT_PROVIDER_TRANSACTION_CONFLICT",
      `${provider} transaction ${providerTransactionId} is already recorded against another request; not recorded for request ${request.id}`,
      { providerTransactionId }
    );
    return { kind: "UNRESOLVED", reason: "PROVIDER_TRANSACTION_CONFLICT", detail: null };
  }

  async function alreadyRecorded(existing: PaymentTransactionRecord): Promise<AuthoritativeResolution> {
    if (existing.paymentRequestId !== request.id) {
      return conflict(existing.providerTransactionId ?? "");
    }
    // The money is already on the record. What may still be missing is what
    // should have followed it: the request's status (a crash between the two
    // writes, or money that landed on a closed request before M1), the money-in
    // projection, and the accounting. All three are idempotent.
    let statusRepaired = false;
    let requestStatus = request.status;
    if (existing.status === "PAID" && Number(existing.amount) > 0) {
      const moved = await store.transitionPaymentRequestStatus(request.id, {
        from: PAYABLE_FROM,
        to: "PAID",
        paidAt: now(),
      });
      if (moved) {
        statusRepaired = true;
        requestStatus = moved.status;
        if (request.status !== "PENDING") {
          await audit(
            "PAYMENT_PAID_AFTER_REQUEST_CLOSED",
            `Money recorded for ${provider} request ${request.id} while it was ${request.status}; status now follows the money`,
            { providerTransactionId: existing.providerTransactionId, previousStatus: request.status }
          );
        }
      }
      // The money-in projection is re-fired only when this call is the one that
      // finished the job (the status had not caught up — the earlier writer died
      // after the money row). A plain redelivery projects nothing twice.
      await projectAndSettle(existing, { project: statusRepaired });
    }
    return { kind: "ALREADY_RECORDED", transactionId: existing.id, requestStatus, statusRepaired };
  }

  async function projectAndSettle(
    transaction: PaymentTransactionRecord,
    options: { project: boolean } = { project: true }
  ): Promise<void> {
    if (transaction.status !== "PAID" || !(Number(transaction.amount) > 0)) return;
    if (options.project) await project(transaction);
    if (!deps.settleAccounting) return;
    try {
      // The canonical C3 settlement. If this fails or the process dies, the
      // PENDING settlement row opened with the money is still there for
      // scheduled recovery — nothing needs the provider again.
      await deps.settleAccounting({ businessId: request.businessId, paymentTransactionId: transaction.id });
    } catch (err) {
      console.error("settleAccounting hook error:", {
        paymentTransactionId: transaction.id,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }

  async function project(transaction: PaymentTransactionRecord): Promise<void> {
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
      console.error("onVerifiedPaid hook error:", {
        paymentTransactionId: transaction.id,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }
}
