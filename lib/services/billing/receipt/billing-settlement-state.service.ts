import { BillingDocumentType, Prisma } from "@prisma/client";
import { NotFoundError, UnauthorizedError, ValidationError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { billingDbStep } from "../billing-db-step";

/**
 * Derived settlement state for an issued invoice. Computed purely from
 * BillingPaymentAllocation rows — the invoice itself is NEVER mutated and there
 * is no paidAt/paymentStatus column. Mirrors the credit-state aggregation
 * pattern (getBillingCreditState).
 */

export type SettlementStatus = "UNPAID" | "PARTIALLY_PAID" | "PAID";

export type InvoiceSettlementState = {
  invoiceDocumentId: number;
  totalAmount: Prisma.Decimal;
  allocatedAmount: Prisma.Decimal;
  remainingAmount: Prisma.Decimal;
  status: SettlementStatus;
  allocationCount: number;
};

/** Pure: classify settlement from totals only. */
export function computeSettlementStatus(
  totalAmount: Prisma.Decimal,
  allocatedAmount: Prisma.Decimal
): SettlementStatus {
  if (allocatedAmount.lessThanOrEqualTo(0)) {
    return "UNPAID";
  }
  if (allocatedAmount.greaterThanOrEqualTo(totalAmount)) {
    return "PAID";
  }
  return "PARTIALLY_PAID";
}

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!value || Number.isNaN(value) || !Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${fieldName} must be a positive integer`);
  }
}

/**
 * Reads the derived settlement state of an invoice. Read-only: aggregates
 * allocations; performs no write to BillingDocument.
 */
export async function getInvoiceSettlementState(args: {
  businessId: number;
  invoiceDocumentId: number;
}): Promise<InvoiceSettlementState> {
  if (!args.businessId || Number.isNaN(args.businessId)) {
    throw new UnauthorizedError();
  }
  assertPositiveInteger(args.invoiceDocumentId, "invoiceDocumentId");

  const invoice = await prisma.billingDocument.findFirst({
    where: { id: args.invoiceDocumentId, businessId: args.businessId },
    select: { id: true, documentType: true, totalAmount: true },
  });
  if (!invoice) {
    throw new NotFoundError("Invoice not found");
  }
  if (invoice.documentType !== BillingDocumentType.TAX_INVOICE) {
    throw new ValidationError(
      "Settlement state is only defined for a TAX_INVOICE"
    );
  }

  const aggregate = await billingDbStep((db) => db.billingPaymentAllocation.aggregate({
    where: {
      businessId: args.businessId,
      invoiceDocumentId: args.invoiceDocumentId,
    },
    _sum: { allocatedAmount: true },
    _count: { _all: true },
  }));

  const allocatedAmount = aggregate._sum.allocatedAmount ?? new Prisma.Decimal(0);
  const remainingAmount = invoice.totalAmount.minus(allocatedAmount);

  return {
    invoiceDocumentId: invoice.id,
    totalAmount: invoice.totalAmount,
    allocatedAmount,
    remainingAmount,
    status: computeSettlementStatus(invoice.totalAmount, allocatedAmount),
    allocationCount: aggregate._count._all,
  };
}
