/**
 * Which currency a single-number total is in, when rows may carry several.
 *
 * The rule every read-side total follows (audit B2–B4, the pattern PR #752 set for the collection
 * inbox): amounts in different currencies are NEVER added and NEVER converted (no FX rates exist).
 * A single-number field carries the HEADLINE currency only; every other currency is reported on
 * its own line, and a flag tells the screen that the headline does not cover everything.
 *
 * Pure, no Prisma: safe for client components. It only chooses and orders currency codes — the
 * arithmetic stays at each call site, so the numbers an all-ILS business sees are produced by
 * exactly the same operations as before.
 */

/** Every existing business reports in ILS; the base-currency setting does not exist in the schema yet. */
export const BASE_CURRENCY = "ILS";

/**
 * A row's currency. Every currency column defaults to ILS in the schema and is never null in the
 * database; an absent value (an older wire shape, a test double) is read as that same default.
 */
export function currencyOrBase(currency: string | null | undefined): string {
  return typeof currency === "string" && currency.trim() !== "" ? currency : BASE_CURRENCY;
}

/**
 * The headline currency of a set of codes: ILS when present, else the first by code, else null
 * (nothing at all). An all-ILS set always answers ILS; a set in ONE other currency answers that
 * currency, so its total is still shown in full and in its own currency.
 */
export function headlineCurrency(codes: Iterable<string>): string | null {
  const sorted = [...new Set(codes)].sort();
  if (sorted.length === 0) return null;
  return sorted.includes(BASE_CURRENCY) ? BASE_CURRENCY : sorted[0];
}

/** `headline` first, then every other code alphabetically (each once). */
export function orderCurrencies(codes: Iterable<string>, headline: string): string[] {
  const set = new Set(codes);
  const rest = [...set].filter((c) => c !== headline).sort();
  return set.has(headline) ? [headline, ...rest] : rest;
}
