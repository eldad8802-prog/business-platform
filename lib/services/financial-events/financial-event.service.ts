import type { BillingDocument } from "@prisma/client";
import {
  BillingDocumentStatus,
  BillingDocumentType,
  FinancialEventDirection,
  FinancialEventSourceType,
  FinancialEventStatus,
  Prisma,
} from "@prisma/client";

function isUniqueConstraintError(
  e: unknown
): e is Prisma.PrismaClientKnownRequestError {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002"
  );
}

const BILLING_CATEGORY_SALES = "sales";

/**
 * Creates a POSTED income FinancialEvent for an ISSUED billing invoice.
 * Idempotent: at most one row per billing document (unique on billingDocumentId
 * and on businessId + sourceType + sourceKey).
 *
 * Parallel issue attempts can race on create(); unique violations (P2002) are
 * treated as success after re-reading the row another transaction inserted.
 *
 * Call only from billing issue flow after the document is persisted as ISSUED.
 */
export async function ensureBillingInvoicePostedEvent(
  tx: Prisma.TransactionClient,
  doc: BillingDocument
): Promise<void> {
  if (doc.documentType !== BillingDocumentType.TAX_INVOICE) {
    return;
  }
  if (doc.status !== BillingDocumentStatus.ISSUED) {
    return;
  }
  if (!doc.issuedAt) {
    return;
  }

  const existing = await tx.financialEvent.findUnique({
    where: { billingDocumentId: doc.id },
  });
  if (existing) {
    return;
  }

  const counterpartyName = (doc.customerNameSnapshot ?? "").trim();

  try {
    await tx.financialEvent.create({
      data: {
        businessId: doc.businessId,
        direction: FinancialEventDirection.INCOME,
        amount: doc.totalAmount,
        currency: doc.currency,
        occurredAt: doc.issuedAt,
        category: BILLING_CATEGORY_SALES,
        counterpartyName: counterpartyName.length > 0 ? counterpartyName : null,
        sourceType: FinancialEventSourceType.BILLING_INVOICE,
        sourceKey: String(doc.id),
        status: FinancialEventStatus.POSTED,
        billingDocumentId: doc.id,
      },
    });
  } catch (e) {
    if (!isUniqueConstraintError(e)) {
      throw e;
    }

    const winner = await tx.financialEvent.findUnique({
      where: { billingDocumentId: doc.id },
    });
    if (winner) {
      return;
    }

    const byComposite = await tx.financialEvent.findUnique({
      where: {
        businessId_sourceType_sourceKey: {
          businessId: doc.businessId,
          sourceType: FinancialEventSourceType.BILLING_INVOICE,
          sourceKey: String(doc.id),
        },
      },
    });
    if (byComposite) {
      return;
    }

    throw e;
  }
}

const PAYMENT_CATEGORY = "payment";

export interface EnsurePaymentPostedEventInput {
  businessId: number;
  paymentRequestId: number;
  /** The verified settlement record — the money-in FACT this event represents. */
  transactionId: number;
  /** Settled amount, decimal serialized as string. */
  amount: string;
  currency: string;
  /** When the payment was verified PAID. */
  occurredAt: Date;
  counterpartyName?: string | null;
}

/**
 * Creates a POSTED income FinancialEvent (sourceType=PAYMENT) for a verified
 * settlement — the fact that money actually came in. Keyed on the
 * PaymentTransaction (sourceKey = transaction id), NOT the PaymentRequest:
 * Financial Control records settlement facts, not intents.
 *
 * Idempotent on (businessId, PAYMENT, sourceKey) — a duplicate webhook can never
 * create a second event. billingDocumentId is left null (PAYMENT is keyed on the
 * composite only). Call ONLY after a verified PAID PaymentTransaction exists.
 */
export async function ensurePaymentPostedEvent(
  tx: Prisma.TransactionClient,
  input: EnsurePaymentPostedEventInput
): Promise<void> {
  const sourceKey = String(input.transactionId);

  const existing = await tx.financialEvent.findUnique({
    where: {
      businessId_sourceType_sourceKey: {
        businessId: input.businessId,
        sourceType: FinancialEventSourceType.PAYMENT,
        sourceKey,
      },
    },
  });
  if (existing) {
    return;
  }

  const counterpartyName = (input.counterpartyName ?? "").trim();

  try {
    await tx.financialEvent.create({
      data: {
        businessId: input.businessId,
        direction: FinancialEventDirection.INCOME,
        amount: input.amount,
        currency: input.currency,
        occurredAt: input.occurredAt,
        category: PAYMENT_CATEGORY,
        counterpartyName: counterpartyName.length > 0 ? counterpartyName : null,
        sourceType: FinancialEventSourceType.PAYMENT,
        sourceKey,
        status: FinancialEventStatus.POSTED,
        // billingDocumentId intentionally null — PAYMENT dedups on the composite.
      },
    });
  } catch (e) {
    if (!isUniqueConstraintError(e)) {
      throw e;
    }
    const winner = await tx.financialEvent.findUnique({
      where: {
        businessId_sourceType_sourceKey: {
          businessId: input.businessId,
          sourceType: FinancialEventSourceType.PAYMENT,
          sourceKey,
        },
      },
    });
    if (winner) {
      return;
    }
    throw e;
  }
}
