import { Prisma } from "@prisma/client";
import {
  authoritativeAllocationWhere,
  authoritativeCreditNoteWhere,
} from "@/lib/services/billing/domain/billing-allocation-authority";

/**
 * What an invoice can still legitimately be settled for.
 *
 *   economicRemaining = max(0, total − ISSUED receipt allocations − ISSUED credit notes)
 *
 * ONE RULE, NOT THREE. The collection list and the payments store already
 * computed exactly this for display; the allocation guard computed a different
 * number (it ignored credit notes), so a payment against a credited invoice
 * could settle more than the invoice was still worth. C3 settles real money
 * automatically, so the write side must use the same figure the owner sees.
 * Every reader and writer now takes it from here.
 *
 * WHAT THIS IS NOT. It does not change how a credit note is bounded — the
 * credit guard still answers "how much of this invoice may be credited", and
 * crediting a fully paid invoice (the refund-shaped case) stays legal. This
 * only answers "how much may still be settled by money".
 *
 * The clamp at zero matters: a paid-then-credited invoice has a negative raw
 * figure, and "negative remaining" must never read as capacity.
 */
export function computeEconomicRemaining(
  total: Prisma.Decimal,
  issuedAllocated: Prisma.Decimal,
  issuedCredited: Prisma.Decimal
): Prisma.Decimal {
  const raw = total.minus(issuedAllocated).minus(issuedCredited);
  return raw.lessThan(0) ? new Prisma.Decimal(0) : raw;
}

export type InvoiceEconomicState = {
  totalAmount: Prisma.Decimal;
  issuedAllocated: Prisma.Decimal;
  issuedCredited: Prisma.Decimal;
  economicRemaining: Prisma.Decimal;
};

/**
 * The same figure, read inside the caller's transaction.
 *
 * Callers that act on the answer must already hold the invoice's row lock
 * (`lockBillingDocumentRowsTx`): receipt issuance, credit-note issuance and
 * payment settlement all take it, so the ISSUED allocations and credits read
 * here cannot change until the caller's transaction ends.
 *
 * `excludeReceiptDocumentId` leaves out the receipt being issued, so its own
 * allocation is measured against what the others have already consumed.
 */
export async function loadInvoiceEconomicStateTx(
  tx: Prisma.TransactionClient,
  args: {
    businessId: number;
    invoiceDocumentId: number;
    totalAmount: Prisma.Decimal;
    excludeReceiptDocumentId?: number;
  }
): Promise<InvoiceEconomicState> {
  const allocated = await tx.billingPaymentAllocation.aggregate({
    where: {
      businessId: args.businessId,
      invoiceDocumentId: args.invoiceDocumentId,
      ...(args.excludeReceiptDocumentId !== undefined
        ? { receiptDocumentId: { not: args.excludeReceiptDocumentId } }
        : {}),
      ...authoritativeAllocationWhere(args.businessId),
    },
    _sum: { allocatedAmount: true },
  });
  const credited = await tx.billingDocument.aggregate({
    where: {
      businessId: args.businessId,
      referenceDocumentId: args.invoiceDocumentId,
      ...authoritativeCreditNoteWhere(),
    },
    _sum: { totalAmount: true },
  });
  const issuedAllocated = allocated._sum.allocatedAmount ?? new Prisma.Decimal(0);
  const issuedCredited = credited._sum.totalAmount ?? new Prisma.Decimal(0);
  return {
    totalAmount: args.totalAmount,
    issuedAllocated,
    issuedCredited,
    economicRemaining: computeEconomicRemaining(
      args.totalAmount,
      issuedAllocated,
      issuedCredited
    ),
  };
}
