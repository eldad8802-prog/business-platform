import {
  BillingDocumentStatus,
  BillingDocumentType,
  PaymentAccountingSettlementStatus,
  Prisma,
} from "@prisma/client";
import { ValidationError } from "@/lib/errors";
import { assertBillingIdentityReadyForTaxInvoice } from "@/lib/billing/business-identity";
import { issueBillingDocumentTx } from "@/lib/services/billing/billing-issue.service";
import { billingTenantTx } from "@/lib/services/billing/billing-tenant-tx";
import { loadInvoiceEconomicStateTx } from "@/lib/services/billing/domain/billing-invoice-economic-remaining";
import { setReceiptAllocationsTx } from "@/lib/services/billing/receipt/billing-payment-allocation.service";
import { createReceiptDraftTx } from "@/lib/services/billing/receipt/billing-receipt-draft.service";
import { lockBillingDocumentRowsTx } from "@/lib/services/billing/receipt/billing-receipt-issuance-integrity";
import { buildPaymentAuditRow } from "@/lib/services/payments/payment-audit.service";

/**
 * C3 — VERIFIED PAYMENT → ACCOUNTING SETTLEMENT.
 *
 * A customer who paid through Dubiz used to leave a verified PaymentTransaction,
 * a PAID request and a FinancialEvent — and no receipt, no allocation, and an
 * invoice that still looked unpaid. This is the one function that finishes the
 * job. The webhook fast path, provider redelivery, scheduled recovery and a
 * manual retry all call it; there is no second implementation.
 *
 *   PAID PaymentTransaction (money IN, provider-verified)
 *     → PaymentAccountingSettlement row (opened with it, same DB transaction)
 *     → settleVerifiedPayment(transactionId)
 *         lock settlement row → re-read the authoritative facts
 *         → one pure RECEIPT for the whole amount
 *         → allocation = min(amount, invoice economic remaining)   (if invoice-backed)
 *         → unappliedAmount = the rest                               (stated, never inferred)
 *         → issued by the system, through the same C2.5-guarded issuance
 *         → settlement SETTLED
 *     all in ONE transaction.
 *
 * EXACTLY ONCE, and why. Three layers, each sufficient against a different
 * failure:
 *   1. the settlement row is locked FOR UPDATE, so concurrent callers queue and
 *      the second sees SETTLED and does nothing;
 *   2. BillingDocument.sourcePaymentTransactionId is UNIQUE, so even a caller
 *      that bypassed the lock could not commit a second receipt;
 *   3. everything is one transaction, so there is never a receipt without its
 *      allocation, or a settled row without its receipt.
 *
 * WHAT IT NEVER DOES. It never marks a payment FAILED, never invents a
 * customer, never allocates more than an invoice can take, and never writes
 * anything for a transaction that has no settlement row (historical, refund,
 * failed, pending) — that row is the forward-only boundary.
 */

export type SettlementAttentionReason =
  | "NO_CUSTOMER"
  | "CUSTOMER_MISMATCH"
  | "BILLING_IDENTITY_INCOMPLETE"
  | "CURRENCY_MISMATCH"
  | "DOCUMENT_NOT_ALLOCATABLE"
  | "TRANSACTION_NOT_ELIGIBLE"
  | "RETRY_EXHAUSTED";

export type SettleVerifiedPaymentResult =
  | {
      outcome: "SETTLED";
      receiptDocumentId: number;
      allocatedAmount: string;
      unappliedAmount: string;
    }
  | { outcome: "ALREADY_SETTLED"; receiptDocumentId: number | null }
  /** No settlement row: historical, refund, failed or pending — never settled automatically. */
  | { outcome: "NOT_ELIGIBLE" }
  | { outcome: "REQUIRES_ATTENTION"; reason: SettlementAttentionReason }
  | {
      outcome: "RETRY_SCHEDULED";
      attemptCount: number;
      nextAttemptAt: Date;
      errorCode: string;
    };

export type SettlementDeps = {
  now?: () => Date;
};

/** Backoff after a transient failure: 1m → 5m → 30m → 2h → 12h, then 12h. */
export const SETTLEMENT_BACKOFF_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  12 * 60 * 60_000,
] as const;

/** Transient attempts before a settlement stops retrying on its own. */
export const SETTLEMENT_MAX_TRANSIENT_ATTEMPTS = 10;

export function nextSettlementAttemptAt(now: Date, attemptCount: number): Date {
  const i = Math.min(Math.max(attemptCount, 1), SETTLEMENT_BACKOFF_MS.length) - 1;
  return new Date(now.getTime() + SETTLEMENT_BACKOFF_MS[i]);
}

/**
 * The diagnostic kept on the settlement row. A class and a code only — error
 * messages can quote values (Prisma's do), and this column must never become a
 * place where a customer's details end up.
 */
export function settlementErrorCode(error: unknown): string {
  const name =
    error instanceof Error ? error.constructor.name || error.name : "UnknownError";
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  return (code ? `${name}:${code}` : name).slice(0, 120);
}

/** A deterministic blocker: retrying without someone changing something cannot help. */
class SettlementAttention extends Error {
  constructor(readonly reason: SettlementAttentionReason) {
    super(reason);
  }
}

type LockedSettlementRow = {
  id: number;
  status: PaymentAccountingSettlementStatus;
  attemptCount: number;
};

async function lockSettlementRowTx(
  tx: Prisma.TransactionClient,
  businessId: number,
  paymentTransactionId: number
): Promise<LockedSettlementRow | null> {
  const rows = await tx.$queryRaw<LockedSettlementRow[]>`
    SELECT "id", "status", "attemptCount"
    FROM "PaymentAccountingSettlement"
    WHERE "paymentTransactionId" = ${paymentTransactionId}
      AND "businessId" = ${businessId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

function assertPositiveInt(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${field} must be a positive integer`);
  }
}

async function appendSettlementAuditTx(
  tx: Prisma.TransactionClient,
  args: {
    businessId: number;
    paymentRequestId: number | null;
    eventType:
      | "PAYMENT_ACCOUNTING_SETTLED"
      | "PAYMENT_ACCOUNTING_REQUIRES_ATTENTION"
      | "PAYMENT_ACCOUNTING_RETRY_SCHEDULED";
    summary: string;
    metadata: Record<string, unknown>;
    occurredAt: Date;
  }
): Promise<void> {
  const row = buildPaymentAuditRow({
    businessId: args.businessId,
    paymentRequestId: args.paymentRequestId,
    eventType: args.eventType,
    source: "SYSTEM",
    summary: args.summary,
    metadata: args.metadata,
    occurredAt: args.occurredAt,
  });
  await tx.paymentAuditEvent.create({
    data: {
      ...row,
      metadata: row.metadata as Prisma.InputJsonValue,
    },
  });
}

/**
 * Settle one verified payment. Idempotent, safe to call concurrently from any
 * path, and resumable from local state alone — no provider involvement.
 */
export async function settleVerifiedPayment(
  input: { businessId: number; paymentTransactionId: number },
  deps: SettlementDeps = {}
): Promise<SettleVerifiedPaymentResult> {
  assertPositiveInt(input.businessId, "businessId");
  assertPositiveInt(input.paymentTransactionId, "paymentTransactionId");
  const now = deps.now ?? (() => new Date());

  try {
    return await billingTenantTx(
      input.businessId,
      (tx) => settleInTx(tx, input, now()),
      { timeoutMs: 30_000 }
    );
  } catch (error) {
    return recordTransientFailure(input, error, now());
  }
}

async function settleInTx(
  tx: Prisma.TransactionClient,
  input: { businessId: number; paymentTransactionId: number },
  at: Date
): Promise<SettleVerifiedPaymentResult> {
  const { businessId, paymentTransactionId } = input;

  const row = await lockSettlementRowTx(tx, businessId, paymentTransactionId);
  if (!row) {
    return { outcome: "NOT_ELIGIBLE" };
  }
  if (row.status === PaymentAccountingSettlementStatus.SETTLED) {
    const receipt = await tx.billingDocument.findFirst({
      where: { businessId, sourcePaymentTransactionId: paymentTransactionId },
      select: { id: true },
    });
    return { outcome: "ALREADY_SETTLED", receiptDocumentId: receipt?.id ?? null };
  }
  if (row.status === PaymentAccountingSettlementStatus.REQUIRES_ATTENTION) {
    // Paused until someone resolves the cause and requeues it. Not an attempt.
    const current = await tx.paymentAccountingSettlement.findUniqueOrThrow({
      where: { id: row.id },
      select: { attentionReason: true },
    });
    return {
      outcome: "REQUIRES_ATTENTION",
      reason: (current.attentionReason ?? "TRANSACTION_NOT_ELIGIBLE") as SettlementAttentionReason,
    };
  }

  // A receipt already committed for this payment means a previous attempt
  // succeeded and only the row update was lost — impossible inside one
  // transaction, but the invariant is cheap to honour: never a second receipt.
  const existing = await tx.billingDocument.findFirst({
    where: { businessId, sourcePaymentTransactionId: paymentTransactionId },
    select: { id: true, status: true },
  });

  let requestId: number | null = null;
  try {
    // ── the authoritative facts, re-read under the tenant ──────────────────
    const payment = await tx.paymentTransaction.findFirst({
      where: { id: paymentTransactionId, paymentRequest: { businessId } },
      include: { paymentRequest: true },
    });
    if (!payment) {
      throw new SettlementAttention("TRANSACTION_NOT_ELIGIBLE");
    }
    requestId = payment.paymentRequestId;
    if (payment.status !== "PAID" || !payment.amount.greaterThan(0)) {
      throw new SettlementAttention("TRANSACTION_NOT_ELIGIBLE");
    }
    const request = payment.paymentRequest;
    const currency = payment.currency.toUpperCase();
    if (request.currency.toUpperCase() !== currency) {
      throw new SettlementAttention("CURRENCY_MISMATCH");
    }
    const amount = payment.amount;

    if (existing) {
      if (existing.status !== BillingDocumentStatus.ISSUED) {
        throw new Error("settlement receipt exists but is not issued");
      }
      await markSettledTx(tx, row, at);
      return { outcome: "ALREADY_SETTLED", receiptDocumentId: existing.id };
    }

    // ── who the receipt is for, and what it may settle ─────────────────────
    let customerId: number | null = null;
    let customerNameSnapshot: string | null = null;
    let invoice: { id: number; totalAmount: Prisma.Decimal } | null = null;

    if (request.billingDocumentId !== null) {
      // Lock the invoice before reading what it can still take: receipt and
      // credit-note issuance take the same lock, so the figure cannot be stale.
      await lockBillingDocumentRowsTx(tx, businessId, [request.billingDocumentId]);
      const doc = await tx.billingDocument.findFirst({
        where: { id: request.billingDocumentId, businessId },
        select: {
          id: true,
          documentType: true,
          status: true,
          currency: true,
          totalAmount: true,
          customerId: true,
          customerNameSnapshot: true,
        },
      });
      if (
        !doc ||
        doc.documentType !== BillingDocumentType.TAX_INVOICE ||
        doc.status !== BillingDocumentStatus.ISSUED
      ) {
        throw new SettlementAttention("DOCUMENT_NOT_ALLOCATABLE");
      }
      if (doc.currency.toUpperCase() !== currency) {
        throw new SettlementAttention("CURRENCY_MISMATCH");
      }
      if (
        request.customerId !== null &&
        doc.customerId !== null &&
        request.customerId !== doc.customerId
      ) {
        throw new SettlementAttention("CUSTOMER_MISMATCH");
      }
      invoice = { id: doc.id, totalAmount: doc.totalAmount };
      customerId = doc.customerId ?? request.customerId;
      customerNameSnapshot = (doc.customerNameSnapshot ?? "").trim() || null;
    } else {
      customerId = request.customerId;
    }

    if (customerId !== null) {
      const customer = await tx.customer.findFirst({
        where: { id: customerId, businessId },
        select: { id: true, name: true },
      });
      if (customer) {
        customerNameSnapshot = customerNameSnapshot ?? ((customer.name ?? "").trim() || null);
      } else if (invoice === null) {
        // An ad-hoc payment whose named customer is not ours: never guess.
        throw new SettlementAttention("NO_CUSTOMER");
      } else {
        customerId = null; // the invoice's frozen snapshot still names them
      }
    }
    if (!customerNameSnapshot) {
      throw new SettlementAttention("NO_CUSTOMER");
    }

    // The same identity gate issuance applies — checked first so an incomplete
    // profile is a stated pause, not an anonymous exception.
    const profile = await tx.businessProfile.findUnique({
      where: { businessId },
      select: {
        billingLegalName: true,
        billingBusinessKind: true,
        billingTaxId: true,
        billingPhone: true,
        billingEmail: true,
        billingAddress: true,
      },
    });
    try {
      assertBillingIdentityReadyForTaxInvoice(profile);
    } catch {
      throw new SettlementAttention("BILLING_IDENTITY_INCOMPLETE");
    }

    // ── the split: what settles the debt, and what is stated unapplied ────
    let allocated = new Prisma.Decimal(0);
    if (invoice) {
      const state = await loadInvoiceEconomicStateTx(tx, {
        businessId,
        invoiceDocumentId: invoice.id,
        totalAmount: invoice.totalAmount,
      });
      allocated = Prisma.Decimal.min(amount, state.economicRemaining);
    }
    // Excess exists only relative to a debt. An ad-hoc payment settles no
    // invoice and is not "unapplied" money awaiting a decision — it is a plain
    // receipt with no allocation (the legitimate ad-hoc shape).
    const unapplied = invoice ? amount.minus(allocated) : new Prisma.Decimal(0);

    // ── one receipt, through the same services a person's receipt uses ─────
    const receipt = await createReceiptDraftTx(
      tx,
      {
        businessId,
        actorUserId: null,
        documentType: BillingDocumentType.RECEIPT,
        customerId,
        customerNameSnapshot,
        currency,
        paymentLines: [
          {
            // The provider verified that money arrived; it did not tell us, in
            // a form we hold authoritatively, HOW it was paid. OTHER is the
            // honest method — no card brand, last4 or approval is invented.
            method: "OTHER",
            amount: amount.toFixed(2),
            currency,
            paymentDate: payment.createdAt.toISOString(),
            reference: payment.providerTransactionId ?? undefined,
          },
        ],
      },
      { sourcePaymentTransactionId: paymentTransactionId, unappliedAmount: unapplied }
    );

    if (invoice && allocated.greaterThan(0)) {
      await setReceiptAllocationsTx(tx, {
        businessId,
        receiptDocumentId: receipt.id,
        allocations: [
          { invoiceDocumentId: invoice.id, allocatedAmount: allocated.toFixed(2) },
        ],
      });
    }

    await issueBillingDocumentTx(tx, {
      businessId,
      billingDocumentId: receipt.id,
      actor: { kind: "PAYMENT_SETTLEMENT", sourcePaymentTransactionId: paymentTransactionId },
      issuedAt: at,
    });

    await markSettledTx(tx, row, at);
    await appendSettlementAuditTx(tx, {
      businessId,
      paymentRequestId: requestId,
      eventType: "PAYMENT_ACCOUNTING_SETTLED",
      summary: `Verified payment ${paymentTransactionId} settled by receipt ${receipt.id}`,
      metadata: {
        paymentTransactionId,
        receiptDocumentId: receipt.id,
        invoiceDocumentId: invoice?.id ?? null,
        allocatedAmount: allocated.toFixed(2),
        unappliedAmount: unapplied.toFixed(2),
        currency,
      },
      occurredAt: at,
    });

    return {
      outcome: "SETTLED",
      receiptDocumentId: receipt.id,
      allocatedAmount: allocated.toFixed(2),
      unappliedAmount: unapplied.toFixed(2),
    };
  } catch (error) {
    if (!(error instanceof SettlementAttention)) {
      throw error; // transient: roll everything back, record outside
    }
    // Deterministic: nothing accounting-side was written before any of these
    // throws, so recording the pause in this same transaction is safe.
    await tx.paymentAccountingSettlement.update({
      where: { id: row.id },
      data: {
        status: PaymentAccountingSettlementStatus.REQUIRES_ATTENTION,
        attentionReason: error.reason,
        attemptCount: row.attemptCount + 1,
        lastAttemptAt: at,
        nextAttemptAt: null,
        lastError: `SettlementAttention:${error.reason}`,
      },
    });
    await appendSettlementAuditTx(tx, {
      businessId,
      paymentRequestId: requestId,
      eventType: "PAYMENT_ACCOUNTING_REQUIRES_ATTENTION",
      summary: `Verified payment ${paymentTransactionId} needs attention before a receipt can be issued`,
      metadata: { paymentTransactionId, reason: error.reason },
      occurredAt: at,
    });
    return { outcome: "REQUIRES_ATTENTION", reason: error.reason };
  }
}

async function markSettledTx(
  tx: Prisma.TransactionClient,
  row: LockedSettlementRow,
  at: Date
): Promise<void> {
  await tx.paymentAccountingSettlement.update({
    where: { id: row.id },
    data: {
      status: PaymentAccountingSettlementStatus.SETTLED,
      settledAt: at,
      attentionReason: null,
      attemptCount: row.attemptCount + 1,
      lastAttemptAt: at,
      nextAttemptAt: null,
      lastError: null,
    },
  });
}

/**
 * A transient failure rolled the attempt back entirely. Record it on its own,
 * under the same row lock, so the next attempt is scheduled — or, after
 * SETTLEMENT_MAX_TRANSIENT_ATTEMPTS, stops retrying blindly.
 */
async function recordTransientFailure(
  input: { businessId: number; paymentTransactionId: number },
  error: unknown,
  at: Date
): Promise<SettleVerifiedPaymentResult> {
  const errorCode = settlementErrorCode(error);
  return billingTenantTx(input.businessId, async (tx) => {
    const row = await lockSettlementRowTx(tx, input.businessId, input.paymentTransactionId);
    if (!row) {
      throw error; // no settlement to record against: surface the real failure
    }
    if (row.status === PaymentAccountingSettlementStatus.SETTLED) {
      // A concurrent caller won (e.g. the loser of a unique race). Idempotent.
      const receipt = await tx.billingDocument.findFirst({
        where: {
          businessId: input.businessId,
          sourcePaymentTransactionId: input.paymentTransactionId,
        },
        select: { id: true },
      });
      return { outcome: "ALREADY_SETTLED", receiptDocumentId: receipt?.id ?? null } as const;
    }
    if (row.status === PaymentAccountingSettlementStatus.REQUIRES_ATTENTION) {
      const current = await tx.paymentAccountingSettlement.findUniqueOrThrow({
        where: { id: row.id },
        select: { attentionReason: true },
      });
      return {
        outcome: "REQUIRES_ATTENTION",
        reason: (current.attentionReason ?? "TRANSACTION_NOT_ELIGIBLE") as SettlementAttentionReason,
      } as const;
    }

    const attemptCount = row.attemptCount + 1;
    const request = await tx.paymentTransaction.findFirst({
      where: { id: input.paymentTransactionId },
      select: { paymentRequestId: true },
    });
    if (attemptCount >= SETTLEMENT_MAX_TRANSIENT_ATTEMPTS) {
      await tx.paymentAccountingSettlement.update({
        where: { id: row.id },
        data: {
          status: PaymentAccountingSettlementStatus.REQUIRES_ATTENTION,
          attentionReason: "RETRY_EXHAUSTED",
          attemptCount,
          lastAttemptAt: at,
          nextAttemptAt: null,
          lastError: errorCode,
        },
      });
      await appendSettlementAuditTx(tx, {
        businessId: input.businessId,
        paymentRequestId: request?.paymentRequestId ?? null,
        eventType: "PAYMENT_ACCOUNTING_REQUIRES_ATTENTION",
        summary: `Verified payment ${input.paymentTransactionId} stopped retrying after ${attemptCount} attempts`,
        metadata: {
          paymentTransactionId: input.paymentTransactionId,
          reason: "RETRY_EXHAUSTED",
          errorCode,
        },
        occurredAt: at,
      });
      return { outcome: "REQUIRES_ATTENTION", reason: "RETRY_EXHAUSTED" } as const;
    }

    const nextAttemptAt = nextSettlementAttemptAt(at, attemptCount);
    await tx.paymentAccountingSettlement.update({
      where: { id: row.id },
      data: { attemptCount, lastAttemptAt: at, nextAttemptAt, lastError: errorCode },
    });
    await appendSettlementAuditTx(tx, {
      businessId: input.businessId,
      paymentRequestId: request?.paymentRequestId ?? null,
      eventType: "PAYMENT_ACCOUNTING_RETRY_SCHEDULED",
      summary: `Verified payment ${input.paymentTransactionId} will be retried`,
      metadata: {
        paymentTransactionId: input.paymentTransactionId,
        attemptCount,
        nextAttemptAt: nextAttemptAt.toISOString(),
        errorCode,
      },
      occurredAt: at,
    });
    return { outcome: "RETRY_SCHEDULED", attemptCount, nextAttemptAt, errorCode } as const;
  });
}

/**
 * Return a paused settlement to the queue once its cause has been resolved
 * (a customer named, the billing profile completed, …). It does NOT settle by
 * itself and creates no accounting effect: the next call to
 * settleVerifiedPayment — inline, recovery or manual — does that, exactly once.
 */
export async function requeueSettlement(
  input: { businessId: number; paymentTransactionId: number },
  deps: SettlementDeps = {}
): Promise<{ requeued: boolean }> {
  assertPositiveInt(input.businessId, "businessId");
  assertPositiveInt(input.paymentTransactionId, "paymentTransactionId");
  const at = (deps.now ?? (() => new Date()))();
  return billingTenantTx(input.businessId, async (tx) => {
    const row = await lockSettlementRowTx(tx, input.businessId, input.paymentTransactionId);
    if (!row || row.status !== PaymentAccountingSettlementStatus.REQUIRES_ATTENTION) {
      return { requeued: false };
    }
    await tx.paymentAccountingSettlement.update({
      where: { id: row.id },
      data: {
        status: PaymentAccountingSettlementStatus.PENDING,
        attentionReason: null,
        attemptCount: 0,
        nextAttemptAt: at,
      },
    });
    return { requeued: true };
  });
}
