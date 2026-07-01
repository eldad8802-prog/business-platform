/**
 * WP3 — shared decimal-string helpers (single source for report sums + display).
 * Integer-agorot math (exact within safe range); no float drift, deterministic.
 * Distinct from WP2's fixed-width `formatSignedAmount` (that is file-layout; this
 * is aggregation + human display).
 */

function toCents(value: string | number | null | undefined): number {
  const raw = String(value == null ? "0" : value).trim();
  if (raw === "") return 0;
  const negative = raw.startsWith("-");
  const unsigned = raw.replace(/^[+-]/, "");
  const [intRaw = "0", fracRaw = ""] = unsigned.split(".");
  const intPart = intRaw.replace(/\D/g, "") || "0";
  const fracPart = (fracRaw.replace(/\D/g, "") + "00").slice(0, 2);
  const cents = Number(intPart) * 100 + Number(fracPart);
  return negative ? -cents : cents;
}

function centsToDecimal(cents: number): string {
  const rounded = Math.round(cents);
  const negative = rounded < 0;
  const abs = Math.abs(rounded);
  const intPart = Math.floor(abs / 100);
  const fracPart = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}${intPart}.${fracPart}`;
}

/** Sum a list of 2-decimal strings → 2-decimal string. */
export function sumDecimal2(values: Array<string | number | null | undefined>): string {
  let acc = 0;
  for (const v of values) acc += toCents(v);
  return centsToDecimal(acc);
}

/** Human display, e.g. "320000" → "320,000.00", "-12.3" → "-12.30". */
export function formatMoneyDisplay(value: string | number | null | undefined): string {
  const cents = Math.round(toCents(value));
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const intPart = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fracPart = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}${intPart}.${fracPart}`;
}
