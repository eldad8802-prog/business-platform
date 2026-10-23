/**
 * Safe aggregation across rows of possibly different currencies.
 *
 * The replacement for `rows.reduce((s, r) => s + r.amount, 0)` + `currency: rows[0].currency`:
 * totals are kept PER CURRENCY, and a single-currency total in a target currency exists only when
 * every component converted under an explicit policy. If any rate is missing, the caller gets the
 * per-currency breakdown plus the list of currencies that could not be converted — never a silently
 * wrong number.
 */
import type { CurrencyCode } from "./currency";
import { convert, type ConversionPolicy, type ConversionRefusal, type FxRate } from "./fx";
import type { Money } from "./money";

export type CurrencyTotals = ReadonlyMap<CurrencyCode, Money>;

export function sumByCurrency(values: Iterable<Money>): CurrencyTotals {
  const totals = new Map<CurrencyCode, bigint>();
  for (const v of values) totals.set(v.currency, (totals.get(v.currency) ?? BigInt(0)) + v.minor);
  const out = new Map<CurrencyCode, Money>();
  for (const [currency, minor] of totals) out.set(currency, { minor, currency });
  return out;
}

/** The only currency present, or null when the totals are empty or mixed. */
export function singleCurrency(totals: CurrencyTotals): CurrencyCode | null {
  return totals.size === 1 ? [...totals.keys()][0] : null;
}

export type ConvertedTotal =
  | {
      readonly ok: true;
      readonly total: Money;
      /** True when at least one component went through a rate. */
      readonly converted: boolean;
      readonly approximate: boolean;
      readonly ratesUsed: readonly FxRate[];
    }
  | {
      readonly ok: false;
      readonly breakdown: CurrencyTotals;
      readonly unconverted: readonly { currency: CurrencyCode; reason: ConversionRefusal }[];
    };

/**
 * Totals into `target`. `rateFor(currency)` supplies the rate for currency → target (or its
 * inverse); the policy decides whether it is acceptable.
 */
export function totalIn(
  totals: CurrencyTotals,
  target: CurrencyCode,
  rateFor: (currency: CurrencyCode) => FxRate | null | undefined,
  policy: ConversionPolicy
): ConvertedTotal {
  let sum = BigInt(0);
  let converted = false;
  let approximate = false;
  const ratesUsed: FxRate[] = [];
  const unconverted: { currency: CurrencyCode; reason: ConversionRefusal }[] = [];
  for (const [currency, value] of totals) {
    const result = convert(value, target, currency === target ? null : rateFor(currency), policy);
    if (!result.ok) {
      unconverted.push({ currency, reason: result.reason });
      continue;
    }
    sum += result.money.minor;
    if (result.converted) {
      converted = true;
      if (result.rate) ratesUsed.push(result.rate);
    }
    approximate ||= result.approximate;
  }
  if (unconverted.length > 0) return { ok: false, breakdown: totals, unconverted };
  return { ok: true, total: { minor: sum, currency: target }, converted, approximate, ratesUsed };
}
