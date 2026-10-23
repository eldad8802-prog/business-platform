/**
 * Secretary — totals of obligations, per currency (audit B4).
 *
 * `BusinessObligation.currency` accepts any ISO code, so a list can hold ILS and USD side by side.
 * The screens used to add every amount and label the result with the first row's currency. Now:
 * each currency is summed on its own (never added to another, never converted), the headline is
 * ILS when present (else the only / first currency by code), and when more than one currency
 * exists the text lists each one — "₪1,200 + $300" — instead of one wrong number.
 *
 * For an all-ILS list the result is exactly the string the screens produced before: the same
 * Number additions in the same order, the same formatter, the same input text.
 */
import { BASE_CURRENCY, currencyOrBase, headlineCurrency, orderCurrencies } from "@/lib/money/currency-split";

export type AmountInCurrency = { amount: string; currency: string };

export type ObligationCurrencyTotal = { currency: string; total: number };

export type ObligationTotals = {
  /** The headline currency: ILS when present, else the first by code (ILS for an empty list). */
  currency: string;
  /** The headline currency's total only. */
  total: number;
  /** Every currency that occurred, headline first. */
  totalsByCurrency: ObligationCurrencyTotal[];
  /** True when more than one currency occurred — `total` does not cover them all. */
  isMixedCurrency: boolean;
};

/** Sums per currency. An amount that is not a finite number adds nothing (as both screens did). */
export function obligationTotalsByCurrency(items: readonly AmountInCurrency[]): ObligationTotals {
  const sums = new Map<string, number>();
  for (const item of items) {
    const currency = currencyOrBase(item.currency);
    const amount = Number(item.amount);
    const running = sums.get(currency) ?? 0;
    sums.set(currency, Number.isFinite(amount) ? running + amount : running);
  }
  const currency = headlineCurrency(sums.keys()) ?? BASE_CURRENCY;
  const totalsByCurrency = orderCurrencies(sums.keys(), currency).map((code) => ({
    currency: code,
    total: sums.get(code) ?? 0,
  }));
  return {
    currency,
    total: sums.get(currency) ?? 0,
    totalsByCurrency,
    isMixedCurrency: totalsByCurrency.length > 1,
  };
}

/**
 * The display text: the headline alone for a single currency (byte-identical to before), or every
 * currency's own total joined with " + " when there are several.
 */
export function formatObligationTotals(
  totals: ObligationTotals,
  format: (amount: string, currency: string) => string
): string {
  if (!totals.isMixedCurrency) return format(String(totals.total), totals.currency);
  return totals.totalsByCurrency.map((t) => format(String(t.total), t.currency)).join(" + ");
}
