/**
 * M7-B — a store's decimal amount ("259.00", "-40.5", 40.56) → integer ISO-4217 minor units, exactly
 * (string arithmetic, never floating point). Unknown / malformed → null (the order is refused, never
 * guessed). Minor-unit exponent per ISO-4217: 0 for the zero-decimal currencies, 3 for the three-decimal
 * ones, 2 otherwise (ILS, USD, EUR, …).
 */
const ZERO = new Set(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF"]);
const THREE = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export function minorExponent(currency: string): number {
  return ZERO.has(currency) ? 0 : THREE.has(currency) ? 3 : 2;
}

/** Absolute value in minor units (refunds arrive negative). */
export function toMinor(amount: unknown, currency: string): number | null {
  const raw = typeof amount === "number" && Number.isFinite(amount) ? String(amount) : typeof amount === "string" ? amount.trim() : "";
  const m = /^-?(\d{1,12})(?:\.(\d{1,6}))?$/.exec(raw);
  if (!m) return null;
  const exp = minorExponent(currency);
  const frac = (m[2] ?? "").padEnd(exp, "0");
  // Digits beyond the currency's exponent must be zero (no silent rounding of real money).
  if (frac.length > exp && /[1-9]/.test(frac.slice(exp))) return null;
  const value = Number(m[1]) * 10 ** exp + (exp ? Number(frac.slice(0, exp)) : 0);
  return Number.isSafeInteger(value) ? value : null;
}
