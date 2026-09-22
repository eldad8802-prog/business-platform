import { Prisma } from "@prisma/client";
import { NotFoundError } from "@/lib/errors";
import { loadInvoiceEconomicStateTx } from "@/lib/services/billing/domain/billing-invoice-economic-remaining";
import {
  assertAllocationWithinRemaining,
  assertInvoiceAllocatable,
  assertReceiptAllocationsMatchTotal,
  assertSameCurrency,
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
 * WHAT THE CAPACITY IS. The invoice's economic remaining — total, less the
 * other receipts' ISSUED allocations, less ISSUED credit notes — from the one
 * shared rule (billing-invoice-economic-remaining). C2.5 originally left credit
 * notes out; C3 settles real money automatically, and a payment must not settle
 * more than a credited invoice is still worth. Credit-note issuance takes the
 * same invoice lock, so the credits read here are not stale.
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
 *  1. zero allocations, nothing unapplied → ad-hoc receipt, nothing to check
 *  2. allocations + unapplied ≠ receipt total → reject (E4)
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
    /** C3: money the receipt states it applies to no debt. 0 for manual receipts. */
    unappliedAmount: Prisma.Decimal;
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

  assertReceiptAllocationsMatchTotal(allocations, args.receiptTotal, args.unappliedAmount);
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

    const state = await loadInvoiceEconomicStateTx(tx, {
      businessId: args.businessId,
      invoiceDocumentId: allocation.invoiceDocumentId,
      totalAmount: invoice.totalAmount,
      excludeReceiptDocumentId: args.receiptDocumentId,
    });
    assertAllocationWithinRemaining(
      allocation.allocatedAmount,
      state.economicRemaining
    );
  }
}
