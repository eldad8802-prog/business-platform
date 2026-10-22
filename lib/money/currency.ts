/**
 * Multi-currency foundation — the currency registry.
 *
 * The ONLY currencies Dubiz lets a business choose as base / display currency, and the facts the
 * money engine needs about each one. A currency outside this registry may still appear on a stored
 * row (a provider callback, a historical import) — the money engine refuses to compute with it
 * instead of guessing, and presentation falls back to the raw ISO code.
 *
 * Pure: no I/O, no locale. Labels live in the i18n dictionaries (`currency.ILS` …), not here.
 */

export const SUPPORTED_CURRENCIES = ["ILS", "USD", "EUR"] as const;
export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

/** Every existing business, row and default in the system is ILS. */
export const DEFAULT_BASE_CURRENCY: CurrencyCode = "ILS";

type CurrencyMeta = {
  /** ISO-4217 minor-unit exponent: 2 → amounts are stored in 1/100ths. */
  readonly exponent: number;
  /** The narrow symbol, used when a locale's Intl data has none. */
  readonly symbol: string;
};

const META: Readonly<Record<CurrencyCode, CurrencyMeta>> = {
  ILS: { exponent: 2, symbol: "₪" },
  USD: { exponent: 2, symbol: "$" },
  EUR: { exponent: 2, symbol: "€" },
};

export function isSupportedCurrency(value: unknown): value is CurrencyCode {
  return typeof value === "string" && (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

export class UnsupportedCurrencyError extends Error {
  readonly code = "UNSUPPORTED_CURRENCY";
  constructor(readonly currency: unknown) {
    super(`Unsupported currency: ${String(currency)}`);
    this.name = "UnsupportedCurrencyError";
  }
}

/** Normalises "usd" / " USD " → "USD"; anything not in the registry throws (never defaults). */
export function parseCurrency(value: unknown): CurrencyCode {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : value;
  if (!isSupportedCurrency(normalized)) throw new UnsupportedCurrencyError(value);
  return normalized;
}

export function currencyExponent(currency: CurrencyCode): number {
  return META[currency].exponent;
}

export function currencySymbol(currency: string): string {
  return isSupportedCurrency(currency) ? META[currency].symbol : currency;
}
