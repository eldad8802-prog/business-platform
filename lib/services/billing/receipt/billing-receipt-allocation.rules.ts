import {
  BillingDocumentStatus,
  BillingDocumentType,
  Prisma,
} from "@prisma/client";
import { ForbiddenError, ValidationError } from "@/lib/errors";

/**
 * Pure rules for receipt → invoice payment allocation and receipt-total
 * reconciliation. No DB access. The orchestration layer loads rows and feeds
 * plain values here so every regulation-critical decision is unit-testable.
 */

export type AllocatableInvoiceFacts = {
  businessId: number;
  documentType: BillingDocumentType;
  status: BillingDocumentStatus;
  currency: string;
  totalAmount: Prisma.Decimal;
};

/** An invoice can be settled by a receipt only when it is an ISSUED TAX_INVOICE. */
export function assertInvoiceAllocatable(invoice: {
  documentType: BillingDocumentType;
  status: BillingDocumentStatus;
}): void {
  if (invoice.documentType !== BillingDocumentType.TAX_INVOICE) {
    throw new ValidationError(
      "Payment can only be allocated to a TAX_INVOICE"
    );
  }
  if (invoice.status !== BillingDocumentStatus.ISSUED) {
    throw new ForbiddenError(
      "Payment can only be allocated to an ISSUED invoice"
    );
  }
}

export function assertSameBusiness(
  receiptBusinessId: number,
  invoiceBusinessId: number
): void {
  if (receiptBusinessId !== invoiceBusinessId) {
    throw new ForbiddenError(
      "Receipt and invoice must belong to the same business"
    );
  }
}

export function assertSameCurrency(
  receiptCurrency: string,
  invoiceCurrency: string
): void {
  if (receiptCurrency !== invoiceCurrency) {
    throw new ValidationError(
      "Allocation currency must match the invoice currency"
    );
  }
}

export function assertAllocationPositive(amount: Prisma.Decimal): void {
  if (amount.lessThanOrEqualTo(0)) {
    throw new ValidationError("Allocated amount must be greater than zero");
  }
}

/** Remaining allocatable on an invoice = invoice total − already-allocated payments. */
export function computeRemainingAllocatable(
  invoiceTotal: Prisma.Decimal,
  alreadyAllocated: Prisma.Decimal
): Prisma.Decimal {
  return invoiceTotal.minus(alreadyAllocated);
}

export function assertAllocationWithinRemaining(
  proposedAllocation: Prisma.Decimal,
  remaining: Prisma.Decimal
): void {
  if (proposedAllocation.greaterThan(remaining)) {
    throw new ForbiddenError(
      "Allocated amount exceeds the invoice remaining unpaid amount"
    );
  }
}

export function sumPaymentLineAmounts(
  lines: { amount: Prisma.Decimal }[]
): Prisma.Decimal {
  return lines.reduce(
    (acc, line) => acc.plus(line.amount),
    new Prisma.Decimal(0)
  );
}

export function sumAllocationAmounts(
  allocations: { allocatedAmount: Prisma.Decimal }[]
): Prisma.Decimal {
  return allocations.reduce(
    (acc, a) => acc.plus(a.allocatedAmount),
    new Prisma.Decimal(0)
  );
}

/**
 * Total reconciliation between the document total and its payment lines.
 * - TAX_INVOICE_RECEIPT: payment lines must sum exactly to the goods-derived total.
 * - RECEIPT: the document total *is* the payments sum (identity), so any goods
 *   total is rejected as a misuse.
 */
export function assertReceiptTotalsReconcile(input: {
  documentType: BillingDocumentType;
  documentTotal: Prisma.Decimal;
  paymentsTotal: Prisma.Decimal;
}): void {
  if (input.documentType === BillingDocumentType.TAX_INVOICE_RECEIPT) {
    if (!input.paymentsTotal.equals(input.documentTotal)) {
      throw new ValidationError(
        "Tax-invoice-receipt payment lines must sum exactly to the document total"
      );
    }
    return;
  }
  if (input.documentType === BillingDocumentType.RECEIPT) {
    if (!input.paymentsTotal.equals(input.documentTotal)) {
      throw new ValidationError(
        "Receipt total must equal the sum of its payment lines"
      );
    }
    return;
  }
  throw new ValidationError(
    "Total reconciliation is only defined for RECEIPT and TAX_INVOICE_RECEIPT"
  );
}
