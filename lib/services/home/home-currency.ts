/**
 * HOME — per-currency totals for the money collected through Dubiz.
 *
 * `PaymentTransaction.currency` can be USD / EUR today (a standalone payment request accepts a
 * currency). Every Home figure is drawn as ₪, so the existing single-number fields carry the ILS
 * rows ONLY — a USD payment is never added into a shekel total (audit B2). The other currencies
 * travel beside them in `totalsByCurrency`, and `isMixedCurrency` tells the screen they exist.
 * For an all-ILS business every existing field is the same value as before.
 */
import { Prisma } from "@prisma/client";

import { BASE_CURRENCY, currencyOrBase, orderCurrencies } from "@/lib/money/currency-split";

/** The currency every Home figure is drawn in (the screen formats them as ₪). */
export const HOME_CURRENCY = BASE_CURRENCY;

const ZERO = new Prisma.Decimal(0);

/** One currency's share of a Home figure. Money as a fixed string, like every Home amount. */
export type HomeCurrencyTotal = { currency: string; total: string; count: number };

type Accumulator = Map<string, { total: Prisma.Decimal; count: number }>;

/** Adds one row into its OWN currency's total (never into another currency's). */
export function addToCurrency(
  acc: Accumulator,
  currency: string | null | undefined,
  amount: Prisma.Decimal | number | string,
  count = 1
): void {
  const code = currencyOrBase(currency);
  const entry = acc.get(code) ?? { total: ZERO, count: 0 };
  acc.set(code, { total: entry.total.plus(amount), count: entry.count + count });
}

/** ILS first, then the rest by code; only currencies that actually occurred. */
export function listCurrencyTotals(acc: Accumulator): HomeCurrencyTotal[] {
  return orderCurrencies(acc.keys(), HOME_CURRENCY).map((currency) => {
    const entry = acc.get(currency)!;
    return { currency, total: entry.total.toFixed(2), count: entry.count };
  });
}

/** True when money in a currency other than ILS occurred — the ₪ headline does not include it. */
export function hasOtherCurrency(totals: readonly HomeCurrencyTotal[]): boolean {
  return totals.some((t) => t.currency !== HOME_CURRENCY);
}

/** The shape of `paymentTransaction.groupBy({ by: ["currency"], _sum: { amount }, _count: { _all } })`. */
export type PaidCurrencyGroup = {
  currency: string;
  _sum: { amount: Prisma.Decimal | null };
  _count: { _all: number };
};

/**
 * A grouped month read, folded into the Home figure.
 *
 * `amount` is the ILS group's own `_sum` — the same Decimal the single `aggregate` returned for an
 * all-ILS business — and `count` is every paid transaction, as before (a count adds no money).
 */
export function foldPaidGroups(groups: readonly PaidCurrencyGroup[]): {
  amount: Prisma.Decimal;
  count: number;
  totalsByCurrency: HomeCurrencyTotal[];
} {
  const acc: Accumulator = new Map();
  let count = 0;
  let amount = ZERO;
  for (const g of groups) {
    count += g._count._all;
    const currency = currencyOrBase(g.currency);
    addToCurrency(acc, currency, g._sum.amount ?? ZERO, g._count._all);
    if (currency === HOME_CURRENCY) amount = g._sum.amount ?? ZERO;
  }
  return { amount, count, totalsByCurrency: listCurrencyTotals(acc) };
}
