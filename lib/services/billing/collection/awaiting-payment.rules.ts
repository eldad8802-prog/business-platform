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

import { computeEconomicRemaining } from "../domain/billing-invoice-economic-remaining";
import {
  computeExpectedPaymentDate,
  daysAwaiting,
  isAwaitingPayment,
  resolveCustomerPaymentTermsDays,
} from "./payment-terms";

/** D2 — the only document type that can represent a debt. */
export const COLLECTIBLE_DOCUMENT_TYPE = "TAX_INVOICE" as const;
/** Only an issued document can be owed. */
export const COLLECTIBLE_DOCUMENT_STATUS = "ISSUED" as const;

const ZERO = new Prisma.Decimal(0);
/** Every existing business reports in ILS; the headline total uses it whenever it is present. */
const HEADLINE_CURRENCY = "ILS";

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
  /** M5 — the customer own configured payment terms, or null to use the business default. */
  readonly customerTermsDays: number | null;
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

export interface AwaitingCurrencyTotal {
  readonly currency: string;
  readonly totalOutstanding: Prisma.Decimal;
}

export interface AwaitingPaymentList {
  /**
   * One entry per (customer, currency): a customer who owes in two currencies appears twice, each
   * row with its own single-currency total — amounts in different currencies are never added.
   */
  readonly customers: readonly AwaitingCustomer[];
  /** The headline total, in `currency` only (see totalsByCurrency for every currency). */
  readonly totalOutstanding: Prisma.Decimal;
  /** The headline currency: ILS when present (every business today), else the first by code. */
  readonly currency: string;
  /** Per-currency totals, headline currency first. A single entry for every ILS-only business. */
  readonly totalsByCurrency: readonly AwaitingCurrencyTotal[];
  /** True when debts exist in more than one currency — the headline then does not cover them all. */
  readonly isMixedCurrency: boolean;
  /** Distinct customers (a customer owing in two currencies counts once). */
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
 *
 * C3: the arithmetic is the shared economic-remaining rule, so the balance the
 * owner sees is the same figure payment settlement is bounded by.
 */
export function computeOutstanding(row: InvoiceRow): Prisma.Decimal {
  return computeEconomicRemaining(
    row.totalAmount,
    row.allocatedAmount,
    row.creditedAmount
  );
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
  // Keyed by customer AND currency: invoices in different currencies are never summed together.
  const byCustomer = new Map<string, AwaitingInvoice[]>();
  const identity = new Map<string, InvoiceRow>();
  let unassignedCount = 0;

  for (const row of input.rows) {
    if (!isCollectible(row)) continue;

    // M5 — terms are resolved PER ROW now, because they can legitimately differ per customer: this
    // customer's own value, else the business's, else the system default. Every customer's value is
    // null today, so this is the same number the business-level resolution produced before the
    // column existed — the behaviour changes only once somebody configures one.
    const termsDays = resolveCustomerPaymentTermsDays(
      row.customerTermsDays,
      input.configuredTermsDays,
    );
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

    const key = `${row.customerId}|${row.currency}`;
    const bucket = byCustomer.get(key);
    if (bucket) {
      bucket.push(invoice);
    } else {
      byCustomer.set(key, [invoice]);
      identity.set(key, row);
    }
  }

  const customers: AwaitingCustomer[] = [];
  const totals = new Map<string, Prisma.Decimal>();
  const distinctCustomers = new Set<number>();

  for (const [key, invoices] of byCustomer) {
    const who = identity.get(key) as InvoiceRow;
    const customerId = who.customerId as number;
    distinctCustomers.add(customerId);

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

    totals.set(invoices[0].currency, (totals.get(invoices[0].currency) ?? ZERO).plus(sum));
  }

  customers.sort((a, b) => {
    const byAmount = b.totalOutstanding.comparedTo(a.totalOutstanding);
    if (byAmount !== 0) return byAmount;
    // Equal amounts: the one waiting longest goes first.
    return a.awaitingSince.getTime() - b.awaitingSince.getTime();
  });

  const codes = [...totals.keys()].sort();
  const headline = totals.has(HEADLINE_CURRENCY) ? HEADLINE_CURRENCY : (codes[0] ?? HEADLINE_CURRENCY);
  const totalsByCurrency: AwaitingCurrencyTotal[] = [headline, ...codes.filter((c) => c !== headline)]
    .filter((c) => totals.has(c))
    .map((c) => ({ currency: c, totalOutstanding: totals.get(c) as Prisma.Decimal }));

  return {
    customers,
    totalOutstanding: totals.get(headline) ?? ZERO,
    currency: headline,
    totalsByCurrency,
    isMixedCurrency: totals.size > 1,
    customerCount: distinctCustomers.size,
    unassignedCount,
  };
}
