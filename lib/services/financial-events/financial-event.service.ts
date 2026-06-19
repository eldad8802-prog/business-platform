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
const BILLING_CATEGORY_PAYMENT = "payment";

function billingPaymentSourceKey(billingDocumentId: number): string {
  return `payment:${billingDocumentId}`;
}

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
  // Revenue recognition applies to a tax invoice and to a tax-invoice-receipt
  // (which is also a tax invoice). A pure RECEIPT recognizes no new revenue —
  // it only records cash against an already-issued invoice (see
  // ensureBillingPaymentPostedEvent).
  if (
    doc.documentType !== BillingDocumentType.TAX_INVOICE &&
    doc.documentType !== BillingDocumentType.TAX_INVOICE_RECEIPT
  ) {
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

/**
 * Creates a POSTED income FinancialEvent of source PAYMENT (cash received) for
 * an ISSUED RECEIPT or TAX_INVOICE_RECEIPT. This represents money received, NOT
 * revenue recognition — a pure RECEIPT therefore never posts a BILLING_INVOICE
 * event, and a TAX_INVOICE_RECEIPT posts BILLING_INVOICE once (revenue) plus
 * PAYMENT once (cash). The financial summary ignores PAYMENT, so cash receipts
 * never double-count income.
 *
 * billingDocumentId is intentionally null: a TAX_INVOICE_RECEIPT already has a
 * BILLING_INVOICE row holding the (unique) billingDocumentId, so the PAYMENT row
 * is keyed only by (businessId, sourceType=PAYMENT, sourceKey="payment:<id>").
 * Idempotent on that composite key.
 */
export async function ensureBillingPaymentPostedEvent(
  tx: Prisma.TransactionClient,
  doc: BillingDocument
): Promise<void> {
  if (
    doc.documentType !== BillingDocumentType.RECEIPT &&
    doc.documentType !== BillingDocumentType.TAX_INVOICE_RECEIPT
  ) {
    return;
  }
  if (doc.status !== BillingDocumentStatus.ISSUED) {
    return;
  }
  if (!doc.issuedAt) {
    return;
  }

  const sourceKey = billingPaymentSourceKey(doc.id);

  const existing = await tx.financialEvent.findUnique({
    where: {
      businessId_sourceType_sourceKey: {
        businessId: doc.businessId,
        sourceType: FinancialEventSourceType.PAYMENT,
        sourceKey,
      },
    },
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
        category: BILLING_CATEGORY_PAYMENT,
        counterpartyName: counterpartyName.length > 0 ? counterpartyName : null,
        sourceType: FinancialEventSourceType.PAYMENT,
        sourceKey,
        status: FinancialEventStatus.POSTED,
        billingDocumentId: null,
      },
    });
  } catch (e) {
    if (!isUniqueConstraintError(e)) {
      throw e;
    }

    const byComposite = await tx.financialEvent.findUnique({
      where: {
        businessId_sourceType_sourceKey: {
          businessId: doc.businessId,
          sourceType: FinancialEventSourceType.PAYMENT,
          sourceKey,
        },
      },
    });
    if (byComposite) {
      return;
    }

    throw e;
  }
}

/**
 * Projects an approved OCR document's FinancialRecord into the unified
 * FinancialEvent layer (sourceType = OCR_DOCUMENT). Idempotent upsert keyed on
 * (businessId, sourceType, sourceKey=documentId): re-approval updates the
 * projected fields in place, never creating a duplicate. Never links a
 * billingDocumentId (Billing isolation). No-ops for non-income/expense
 * directions or non-positive amounts (defense-in-depth alongside the caller).
 */
export async function ensureDocumentFinancialEvent(
  tx: Prisma.TransactionClient,
  input: {
    businessId: number;
    documentId: number;
    amount: number;
    direction: string;
    occurredAt: Date;
    category: string;
    vendorName: string;
  }
): Promise<void> {
  const direction =
    input.direction === "income"
      ? FinancialEventDirection.INCOME
      : input.direction === "expense"
      ? FinancialEventDirection.EXPENSE
      : null;
  if (!direction) {
    return;
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return;
  }

  const sourceKey = String(input.documentId);
  const counterpartyName = input.vendorName.trim();
  const projected = {
    direction,
    amount: input.amount,
    occurredAt: input.occurredAt,
    category: input.category,
    counterpartyName: counterpartyName.length > 0 ? counterpartyName : null,
  };

  await tx.financialEvent.upsert({
    where: {
      businessId_sourceType_sourceKey: {
        businessId: input.businessId,
        sourceType: FinancialEventSourceType.OCR_DOCUMENT,
        sourceKey,
      },
    },
    update: projected,
    create: {
      businessId: input.businessId,
      currency: "ILS",
      sourceType: FinancialEventSourceType.OCR_DOCUMENT,
      sourceKey,
      status: FinancialEventStatus.POSTED,
      ...projected,
    },
  });
}
