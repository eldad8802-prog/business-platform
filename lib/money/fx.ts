/**
 * Exchange rates and conversion — explicit, sourced, and never silent.
 *
 * An FxRate always says WHERE it came from, WHAT kind of rate it is, WHEN it applies, and whether it
 * was verified. `convert` returns a discriminated result: a conversion that cannot be justified
 * (missing / stale / unverified / wrong pair) is a typed refusal the caller must handle — the engine
 * never falls back to "some rate" or to 1:1.
 *
 * Kinds (they are NOT interchangeable):
 *  - REPRESENTATIVE — an official reference rate for a date (e.g. Bank of Israel שער יציג).
 *                     The only kind accounting / reporting rules may use.
 *  - TRANSACTION    — the rate actually applied by a counterparty (a provider settlement, a bank
 *                     statement). Belongs to that one transaction.
 *  - DISPLAY        — an indicative rate for showing approximate totals. Never written into a
 *                     financial record; results are always marked approximate.
 *
 * `rate` = units of `quote` for ONE unit of `base`, as an exact decimal string (≤ RATE_SCALE places).
 */
import { currencyExponent, type CurrencyCode } from "./currency";
import { divRound, formatScaled, parseScaled, pow10, type RoundingMode } from "./decimal";
import type { Money } from "./money";

export const RATE_SCALE = 10;

export type FxRateKind = "REPRESENTATIVE" | "TRANSACTION" | "DISPLAY";
export type FxRateSource = "BANK_OF_ISRAEL" | "PAYMENT_PROVIDER" | "MANUAL";
export type FxVerification = "VERIFIED" | "UNVERIFIED";

export type FxRate = {
  readonly base: CurrencyCode;
  readonly quote: CurrencyCode;
  readonly rate: string;
  readonly kind: FxRateKind;
  readonly source: FxRateSource;
  /** The civil date (YYYY-MM-DD, business time zone) the rate is published for. */
  readonly rateDate: string;
  /** When Dubiz obtained the rate (ISO instant). */
  readonly fetchedAt: string;
  readonly verification: FxVerification;
};

export type ConversionPolicy = {
  /** The kinds this use may consume. Accounting: ["REPRESENTATIVE"] (or TRANSACTION for that txn). */
  readonly allowedKinds: readonly FxRateKind[];
  readonly requireVerified: boolean;
  /** The civil date the conversion is for, and how many days older the rate may be (weekends/holidays). */
  readonly asOfDate: string;
  readonly maxAgeDays: number;
  readonly rounding: RoundingMode;
};

/** Display totals: indicative rates allowed, verified not required, a week of staleness tolerated. */
export function displayPolicy(asOfDate: string): ConversionPolicy {
  return {
    allowedKinds: ["REPRESENTATIVE", "DISPLAY"],
    requireVerified: false,
    asOfDate,
    maxAgeDays: 7,
    rounding: "HALF_UP",
  };
}

/** Accounting / reporting: verified representative rate only, at most 4 days old (weekend + holiday). */
export function accountingPolicy(asOfDate: string): ConversionPolicy {
  return {
    allowedKinds: ["REPRESENTATIVE"],
    requireVerified: true,
    asOfDate,
    maxAgeDays: 4,
    rounding: "HALF_UP",
  };
}

export type ConversionRefusal =
  | "RATE_MISSING"
  | "RATE_PAIR_MISMATCH"
  | "RATE_KIND_NOT_ALLOWED"
  | "RATE_UNVERIFIED"
  | "RATE_STALE"
  | "RATE_FROM_FUTURE"
  | "RATE_INVALID";

export type ConversionResult =
  | {
      readonly ok: true;
      readonly money: Money;
      /** False when source and target currency are equal (no rate was involved). */
      readonly converted: boolean;
      readonly rate: FxRate | null;
      /** True when the rate was used in the reverse direction (quote → base). */
      readonly inverted: boolean;
      /** True for DISPLAY-kind or unverified rates — the UI must mark the value as approximate. */
      readonly approximate: boolean;
    }
  | { readonly ok: false; readonly reason: ConversionRefusal; readonly from: CurrencyCode; readonly to: CurrencyCode };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function civilDayNumber(date: string): number {
  if (!DATE_RE.test(date)) return Number.NaN;
  return Math.floor(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) / 86_400_000);
}

/** Validates a rate's shape; returns the scaled rate or null. A zero / negative rate is invalid. */
export function scaledRate(rate: FxRate): bigint | null {
  try {
    const v = parseScaled(rate.rate, RATE_SCALE);
    return v > BigInt(0) ? v : null;
  } catch {
    return null;
  }
}

export function convert(
  value: Money,
  to: CurrencyCode,
  rate: FxRate | null | undefined,
  policy: ConversionPolicy
): ConversionResult {
  const from = value.currency;
  if (from === to) {
    return { ok: true, money: value, converted: false, rate: null, inverted: false, approximate: false };
  }
  const refuse = (reason: ConversionRefusal): ConversionResult => ({ ok: false, reason, from, to });
  if (!rate) return refuse("RATE_MISSING");

  const direct = rate.base === from && rate.quote === to;
  const inverse = rate.base === to && rate.quote === from;
  if (!direct && !inverse) return refuse("RATE_PAIR_MISMATCH");
  if (!policy.allowedKinds.includes(rate.kind)) return refuse("RATE_KIND_NOT_ALLOWED");
  if (policy.requireVerified && rate.verification !== "VERIFIED") return refuse("RATE_UNVERIFIED");

  const rateDay = civilDayNumber(rate.rateDate);
  const asOfDay = civilDayNumber(policy.asOfDate);
  if (Number.isNaN(rateDay) || Number.isNaN(asOfDay)) return refuse("RATE_INVALID");
  if (rateDay > asOfDay) return refuse("RATE_FROM_FUTURE");
  if (asOfDay - rateDay > policy.maxAgeDays) return refuse("RATE_STALE");

  const r = scaledRate(rate);
  if (r === null) return refuse("RATE_INVALID");

  // target_minor = source_minor × rate × 10^expTo / (10^RATE_SCALE × 10^expFrom)   (direct)
  // target_minor = source_minor × 10^RATE_SCALE × 10^expTo / (rate × 10^expFrom)   (inverse)
  const expFrom = pow10(currencyExponent(from));
  const expTo = pow10(currencyExponent(to));
  const scale = pow10(RATE_SCALE);
  const minor = direct
    ? divRound(value.minor * r * expTo, scale * expFrom, policy.rounding)
    : divRound(value.minor * scale * expTo, r * expFrom, policy.rounding);

  return {
    ok: true,
    money: { minor, currency: to },
    converted: true,
    rate,
    inverted: inverse,
    approximate: rate.kind === "DISPLAY" || rate.verification !== "VERIFIED",
  };
}

/** Normalises a rate string to RATE_SCALE places (for storage / snapshot hashing). */
export function canonicalRateString(rate: string): string {
  return formatScaled(parseScaled(rate, RATE_SCALE), RATE_SCALE);
}

/** Picks, from candidate rates for one pair, the newest one the policy accepts (null if none). */
export function selectRate(
  candidates: readonly FxRate[],
  from: CurrencyCode,
  to: CurrencyCode,
  policy: ConversionPolicy
): FxRate | null {
  let best: FxRate | null = null;
  for (const c of candidates) {
    const probe = convert({ minor: BigInt(1), currency: from }, to, c, policy);
    if (!probe.ok) continue;
    if (!best || c.rateDate > best.rateDate || (c.rateDate === best.rateDate && c.fetchedAt > best.fetchedAt)) {
      best = c;
    }
  }
  return best;
}
