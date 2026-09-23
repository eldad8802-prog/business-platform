import { BillingDocumentType, Prisma } from "@prisma/client";
import { NotFoundError, UnauthorizedError, ValidationError } from "@/lib/errors";
import { billingTenantTx } from "@/lib/services/billing/billing-tenant-tx";
import { authoritativeAllocationWhere } from "@/lib/services/billing/domain/billing-allocation-authority";

/**
 * Derived settlement state for an issued invoice. Computed purely from
 * BillingPaymentAllocation rows — the invoice itself is NEVER mutated and there
 * is no paidAt/paymentStatus column. Mirrors the credit-state aggregation
 * pattern (getBillingCreditState).
 *
 * C2 — only the allocations of an ISSUED receipt are counted, through Billing's
 * shared authority filter. An invoice does not become PAID because someone
 * prepared a receipt that was never issued.
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

  // Both reads carry the tenant explicitly, in one transaction.
  //
  // The aggregate used to go through `billingDbStep`, which scopes a read only
  // when an ALS tenant context is already established — and this function's
  // only caller is an API route, which establishes none. Under FORCE RLS on
  // `BillingPaymentAllocation` the aggregate therefore matched zero rows, and
  // the route reported an invoice that had been half settled as UNPAID with no
  // allocations. Observed in Production: invoice 3 of the QA tenant, 5.00 of
  // 10.00 collected and receipted, reported as owing the full 10.00.
  //
  // The invoice read above was already scoped, which is what made the result
  // look plausible rather than empty: a real invoice, a false balance.
  const { invoice, aggregate } = await billingTenantTx(args.businessId, async (tx) => {
    const invoiceRow = await tx.billingDocument.findFirst({
      where: { id: args.invoiceDocumentId, businessId: args.businessId },
      select: { id: true, documentType: true, totalAmount: true },
    });
    if (!invoiceRow || invoiceRow.documentType !== BillingDocumentType.TAX_INVOICE) {
      // The classification below needs the row; the aggregate would be
      // meaningless without it, so it is not run.
      return { invoice: invoiceRow, aggregate: null };
    }
    return {
      invoice: invoiceRow,
      aggregate: await tx.billingPaymentAllocation.aggregate({
        where: {
          businessId: args.businessId,
          invoiceDocumentId: args.invoiceDocumentId,
          ...authoritativeAllocationWhere(args.businessId),
        },
        _sum: { allocatedAmount: true },
        _count: { _all: true },
      }),
    };
  });

  if (!invoice) {
    throw new NotFoundError("Invoice not found");
  }
  if (invoice.documentType !== BillingDocumentType.TAX_INVOICE) {
    throw new ValidationError(
      "Settlement state is only defined for a TAX_INVOICE"
    );
  }
  if (!aggregate) {
    throw new NotFoundError("Invoice not found");
  }

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
