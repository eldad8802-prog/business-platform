import { Prisma } from "@prisma/client";
import { NotFoundError } from "@/lib/errors";
import { authoritativeAllocationWhere } from "@/lib/services/billing/domain/billing-allocation-authority";
import {
  assertAllocationWithinRemaining,
  assertInvoiceAllocatable,
  assertReceiptAllocationsMatchTotal,
  assertSameCurrency,
  computeRemainingAllocatable,
} from "@/lib/services/billing/receipt/billing-receipt-allocation.rules";

/**
 * C2.5 — the moment a receipt's allocations become authoritative is the moment
 * they are checked.
 *
 * THE DEFECTS THIS CLOSES. C2 made only an ISSUED receipt's allocations reduce
 * a debt, but the capacity check still ran when a DRAFT was allocated, counted
 * every other draft as if it had already settled something, and held nothing
 * between reading the balance and writing the row. So an abandoned draft could
 * block a real payment forever, while two concurrent receipts could each read
 * the same untouched invoice and both settle it (runtime Case F: 19/20). And
 * because nothing looked at allocations at issuance, a receipt whose payment
 * lines were replaced after it was allocated could settle more than it received
 * (Case E4).
 *
 * The check therefore moves to where the authority changes hands: inside the
 * issuance transaction, after the rows that own the balances are locked.
 *
 * WHY THE INVOICE ROW. The allocations that would conflict belong to other
 * receipts and may not be authoritative yet, so there is nothing of theirs to
 * lock. What every competing issuance shares is the invoice it settles, and an
 * allocation only becomes authoritative through issuance, which now takes this
 * lock. Once it is held, the issued allocations read below cannot change until
 * this transaction ends.
 *
 * WHAT THE CAPACITY IS. Exactly the rule the draft path always applied —
 * invoice total minus the other receipts' allocations — narrowed by C2's
 * authority filter to the allocations that actually count. Credit notes are
 * deliberately left where they were: the allocation guard has never counted
 * them, and changing how credit and payment share an invoice is a separate
 * accounting decision, not an integrity fix.
 */

/**
 * Row-lock billing documents, always in ascending id order.
 *
 * Every path that holds more than one of these locks takes them through here,
 * so two transactions touching the same set acquire them in the same order and
 * cannot wait on each other in a cycle. The tenant predicate is repeated so a
 * lock can never be taken on another business's row, even where RLS is absent.
 */
export async function lockBillingDocumentRowsTx(
  tx: Prisma.TransactionClient,
  businessId: number,
  documentIds: number[]
): Promise<void> {
  const ids = orderedUniqueIds(documentIds);
  if (ids.length === 0) {
    return;
  }
  await tx.$queryRaw`
    SELECT "id" FROM "BillingDocument"
    WHERE "businessId" = ${businessId}
      AND "id" IN (${Prisma.join(ids)})
    ORDER BY "id"
    FOR UPDATE
  `;
}

/** Pure: the lock order. Exported so the ordering itself is testable. */
export function orderedUniqueIds(ids: number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

/**
 * Asserts, inside the issuance transaction, that a pure RECEIPT may become
 * ISSUED. The caller must already hold the receipt's own row lock.
 *
 *  1. zero allocations          → ad-hoc receipt, nothing to check
 *  2. allocations ≠ receipt total → reject (E4)
 *  3. lock every target invoice, ascending id
 *  4. re-read each invoice and its ISSUED allocations under that lock
 *  5. new allocation > remaining  → reject (F)
 */
export async function assertReceiptAllocationIntegrityTx(
  tx: Prisma.TransactionClient,
  args: {
    businessId: number;
    receiptDocumentId: number;
    receiptCurrency: string;
    receiptTotal: Prisma.Decimal;
  }
): Promise<void> {
  const allocations = await tx.billingPaymentAllocation.findMany({
    where: {
      businessId: args.businessId,
      receiptDocumentId: args.receiptDocumentId,
    },
    select: { invoiceDocumentId: true, allocatedAmount: true },
    orderBy: { invoiceDocumentId: "asc" },
  });

  assertReceiptAllocationsMatchTotal(allocations, args.receiptTotal);
  if (allocations.length === 0) {
    return;
  }

  await lockBillingDocumentRowsTx(
    tx,
    args.businessId,
    allocations.map((a) => a.invoiceDocumentId)
  );

  for (const allocation of allocations) {
    const invoice = await tx.billingDocument.findFirst({
      where: { id: allocation.invoiceDocumentId, businessId: args.businessId },
      select: {
        documentType: true,
        status: true,
        currency: true,
        totalAmount: true,
      },
    });
    if (!invoice) {
      throw new NotFoundError(
        `Invoice ${allocation.invoiceDocumentId} not found`
      );
    }
    assertInvoiceAllocatable(invoice);
    assertSameCurrency(args.receiptCurrency, invoice.currency);

    const settled = await tx.billingPaymentAllocation.aggregate({
      where: {
        businessId: args.businessId,
        invoiceDocumentId: allocation.invoiceDocumentId,
        receiptDocumentId: { not: args.receiptDocumentId },
        ...authoritativeAllocationWhere(args.businessId),
      },
      _sum: { allocatedAmount: true },
    });
    const remaining = computeRemainingAllocatable(
      invoice.totalAmount,
      settled._sum.allocatedAmount ?? new Prisma.Decimal(0)
    );
    assertAllocationWithinRemaining(allocation.allocatedAmount, remaining);
  }
}
