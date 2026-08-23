/**
 * Collection · "awaiting payment" read-model — the pure core.
 *
 * Answers one question the system could not answer before: **who owes the
 * business money right now, and since when.**
 *
 * Pure. Takes rows in, returns the list out. No Prisma queries, no clock — the
 * caller supplies `now`. The loader that fetches the rows lives beside this
 * file; every rule that decides what counts as a debt lives here, where it can
 * be tested exhaustively.
 *
 * THREE PRODUCT DECISIONS ARE ENCODED HERE, and each one exists to stop Dubiz
 * asking a customer for money they do not owe — the single failure that costs
 * the owner standing in front of his own client:
 *
 *   D1  Expectation comes from business-wide terms counted off `issuedAt`.
 *   D2  Only TAX_INVOICE is a debt. TAX_INVOICE_RECEIPT was paid at issuance;
 *       putting it on this list would ask for money already received.
 *   D3  A credit note reduces the balance. Fully credited, the invoice leaves
 *       the list entirely.
 */

import { Prisma } from "@prisma/client";

import {
  computeExpectedPaymentDate,
  daysAwaiting,
  isAwaitingPayment,
  resolvePaymentTermsDays,
} from "./payment-terms";

/** D2 — the only document type that can represent a debt. */
export const COLLECTIBLE_DOCUMENT_TYPE = "TAX_INVOICE" as const;
/** Only an issued document can be owed. */
export const COLLECTIBLE_DOCUMENT_STATUS = "ISSUED" as const;

const ZERO = new Prisma.Decimal(0);

/** One issued document, with everything already applied against it. */
export interface InvoiceRow {
  readonly id: number;
  readonly documentNumber: string | null;
  readonly type: string;
  readonly status: string;
  readonly issuedAt: Date | null;
  readonly totalAmount: Prisma.Decimal;
  readonly currency: string;
  /** Sum of receipt allocations against this invoice. */
  readonly allocatedAmount: Prisma.Decimal;
  /** D3 — sum of credit notes referencing this invoice. */
  readonly creditedAmount: Prisma.Decimal;
  readonly customerId: number | null;
  readonly customerName: string | null;
  readonly customerPhone: string | null;
  readonly customerEmail: string | null;
}

export interface AwaitingInvoice {
  readonly id: number;
  readonly documentNumber: string | null;
  readonly outstanding: Prisma.Decimal;
  readonly currency: string;
  readonly issuedAt: Date;
  readonly expectedPaymentDate: Date;
  readonly daysAwaiting: number;
  /** True when something was paid or credited but a balance remains. */
  readonly isPartiallySettled: boolean;
}

/** One customer — one row, one conversation, one message. */
export interface AwaitingCustomer {
  readonly customerId: number;
  readonly customerName: string;
  readonly customerPhone: string | null;
  readonly customerEmail: string | null;
  readonly totalOutstanding: Prisma.Decimal;
  readonly currency: string;
  /** The oldest expectation across this customer's invoices. */
  readonly awaitingSince: Date;
  readonly maxDaysAwaiting: number;
  readonly invoices: readonly AwaitingInvoice[];
  /** No phone and no email — nothing can be sent, and we say so. */
  readonly hasNoContactChannel: boolean;
}

export interface AwaitingPaymentList {
  readonly customers: readonly AwaitingCustomer[];
  readonly totalOutstanding: Prisma.Decimal;
  readonly customerCount: number;
  /**
   * Issued invoices past their expected date that carry a balance but have no
   * customer attached, so they cannot be collected. Surfaced as a COUNT rather
   * than hidden: a list that silently omits debt understates what is owed.
   */
  readonly unassignedCount: number;
}

/**
 * What is still owed on one invoice.
 *
 * Total, less what was paid, less what was credited. Never negative — an
 * over-allocation is a bookkeeping matter, not a debt of the customer.
 */
export function computeOutstanding(row: InvoiceRow): Prisma.Decimal {
  const outstanding = row.totalAmount
    .minus(row.allocatedAmount)
    .minus(row.creditedAmount);
  return outstanding.lessThan(ZERO) ? ZERO : outstanding;
}

/**
 * Is this row a debt at all? Encodes D2 and the zero-balance exit.
 *
 * Deliberately time-independent: whether something IS a debt does not depend on
 * the clock. Whether it is due yet does, and that lives in `isAwaitingPayment`.
 */
export function isCollectible(row: InvoiceRow): boolean {
  if (row.type !== COLLECTIBLE_DOCUMENT_TYPE) return false;
  if (row.status !== COLLECTIBLE_DOCUMENT_STATUS) return false;
  if (row.issuedAt === null) return false;
  if (computeOutstanding(row).lessThanOrEqualTo(ZERO)) return false;
  return true;
}

export interface BuildAwaitingListInput {
  readonly rows: readonly InvoiceRow[];
  /** From BusinessProfile. Null when never configured. */
  readonly configuredTermsDays: number | null;
  readonly now: Date;
}

/**
 * Build the list.
 *
 * Ordering is by amount, largest first — "who owes me the most" is the question
 * an owner actually asks, and it needs no explanation. Time is shown as a date,
 * never as a countdown.
 */
export function buildAwaitingPaymentList(
  input: BuildAwaitingListInput,
): AwaitingPaymentList {
  const termsDays = resolvePaymentTermsDays(input.configuredTermsDays);
  const byCustomer = new Map<number, AwaitingInvoice[]>();
  const identity = new Map<number, InvoiceRow>();
  let unassignedCount = 0;

  for (const row of input.rows) {
    if (!isCollectible(row)) continue;

    const expected = computeExpectedPaymentDate(row.issuedAt, termsDays);
    if (!isAwaitingPayment(expected, input.now)) continue;

    if (row.customerId === null) {
      unassignedCount += 1;
      continue;
    }

    const outstanding = computeOutstanding(row);
    const invoice: AwaitingInvoice = {
      id: row.id,
      documentNumber: row.documentNumber,
      outstanding,
      currency: row.currency,
      issuedAt: row.issuedAt as Date,
      expectedPaymentDate: expected as Date,
      daysAwaiting: daysAwaiting(expected, input.now),
      isPartiallySettled:
        row.allocatedAmount.greaterThan(ZERO) ||
        row.creditedAmount.greaterThan(ZERO),
    };

    const bucket = byCustomer.get(row.customerId);
    if (bucket) {
      bucket.push(invoice);
    } else {
      byCustomer.set(row.customerId, [invoice]);
      identity.set(row.customerId, row);
    }
  }

  const customers: AwaitingCustomer[] = [];
  let total = ZERO;

  for (const [customerId, invoices] of byCustomer) {
    const who = identity.get(customerId) as InvoiceRow;

    let sum = ZERO;
    let oldest = invoices[0].expectedPaymentDate;
    let maxDays = 0;
    for (const inv of invoices) {
      sum = sum.plus(inv.outstanding);
      if (inv.expectedPaymentDate < oldest) oldest = inv.expectedPaymentDate;
      if (inv.daysAwaiting > maxDays) maxDays = inv.daysAwaiting;
    }

    customers.push({
      customerId,
      customerName: who.customerName ?? "",
      customerPhone: who.customerPhone,
      customerEmail: who.customerEmail,
      totalOutstanding: sum,
      currency: invoices[0].currency,
      awaitingSince: oldest,
      maxDaysAwaiting: maxDays,
      // Oldest first inside a customer — the message leads with the oldest debt.
      invoices: [...invoices].sort(
        (a, b) => a.expectedPaymentDate.getTime() - b.expectedPaymentDate.getTime(),
      ),
      hasNoContactChannel: !who.customerPhone && !who.customerEmail,
    });

    total = total.plus(sum);
  }

  customers.sort((a, b) => {
    const byAmount = b.totalOutstanding.comparedTo(a.totalOutstanding);
    if (byAmount !== 0) return byAmount;
    // Equal amounts: the one waiting longest goes first.
    return a.awaitingSince.getTime() - b.awaitingSince.getTime();
  });

  return {
    customers,
    totalOutstanding: total,
    customerCount: customers.length,
    unassignedCount,
  };
}
