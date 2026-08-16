/**
 * Shared money PRESENTATION helper (Desktop Content System).
 *
 * Presentation only — never calculates, derives, or fetches amounts. Consolidates
 * the per-surface money formatters (first consumer: Documents/incoming).
 *
 * Semantic parity with the Documents inbox `fmtMoney` is MANDATORY:
 *   - locale he-IL
 *   - `maximumFractionDigits: 2` with NO forced minimum (1500 → ₪1,500, not ₪1,500.00)
 *   - null / non-finite → "—"
 *   - ILS default (₪); $ / € supported for future consumers.
 *
 * Payments keeps its own `money()` (different semantics) — not touched here.
 */
export function formatMoney(
  amount: number | string | null | undefined,
  currency: string = "ILS"
): string {
  if (amount === null || amount === undefined) return "—";
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) return "—";
  const symbol =
    currency === "ILS" ? "₪" : currency === "USD" ? "$" : currency === "EUR" ? "€" : "";
  return `${symbol}${n.toLocaleString("he-IL", { maximumFractionDigits: 2 })}`;
}
