/**
 * Money values: an exact amount in ISO minor units + its currency. Arithmetic across two
 * currencies is a TYPE of error here, not a rounding question — it throws CurrencyMismatchError.
 * To total rows of mixed currency use `sumByCurrency` (aggregate.ts), then convert explicitly
 * through an FxRate (fx.ts).
 */
import { currencyExponent, parseCurrency, type CurrencyCode } from "./currency";
import { formatScaled, parseScaled, type DecimalInput, type RoundingMode } from "./decimal";

export type Money = {
  readonly minor: bigint;
  readonly currency: CurrencyCode;
};

export class CurrencyMismatchError extends Error {
  readonly code = "CURRENCY_MISMATCH";
  constructor(readonly left: string, readonly right: string) {
    super(`Cannot combine ${left} with ${right} without an explicit conversion`);
    this.name = "CurrencyMismatchError";
  }
}

export function money(minor: bigint, currency: CurrencyCode): Money {
  return { minor, currency };
}

/**
 * A stored decimal amount (DB Decimal(18,2), API string, legacy Float) → Money.
 * Exact by default: an amount with more decimals than the currency allows throws, it is never
 * silently rounded. Pass `rounding` only where the caller owns a rounding rule (e.g. a computed
 * line total).
 */
export function moneyFromDecimal(
  amount: DecimalInput,
  currency: string,
  rounding?: RoundingMode
): Money {
  const code = parseCurrency(currency);
  return { minor: parseScaled(amount, currencyExponent(code), rounding), currency: code };
}

/** Money → plain decimal string ("1234.50"), the shape Prisma.Decimal and the APIs take. */
export function toDecimalString(value: Money): string {
  return formatScaled(value.minor, currencyExponent(value.currency));
}

export function zero(currency: CurrencyCode): Money {
  return { minor: BigInt(0), currency };
}

function assertSame(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  assertSame(a, b);
  return { minor: a.minor + b.minor, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  assertSame(a, b);
  return { minor: a.minor - b.minor, currency: a.currency };
}

export function negate(a: Money): Money {
  return { minor: -a.minor, currency: a.currency };
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSame(a, b);
  return a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0;
}

export function isZero(a: Money): boolean {
  return a.minor === BigInt(0);
}

/** Sums values that MUST share one currency (throws on a mix). Empty list → zero(currency). */
export function sumSameCurrency(values: readonly Money[], currency: CurrencyCode): Money {
  let total = BigInt(0);
  for (const v of values) {
    if (v.currency !== currency) throw new CurrencyMismatchError(currency, v.currency);
    total += v.minor;
  }
  return { minor: total, currency };
}
