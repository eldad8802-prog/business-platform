/**
 * Supplier Domain Phase 3 — Measure / Representation Conversion (pure).
 *
 * Translates a supplier's purchase-unit into Dubiz's stock-unit using the
 * learned `factor` (stock-units per 1 purchase-unit). The factor is nominal and
 * lives on the RepresentationMapping; null / non-positive ⇒ 1:1.
 *
 * Pure functions only — NO DB, NO side effects, and they NEVER move inventory.
 * Their result is applied where quantity/cost enter the record (at approval),
 * never here. (Guard: Measure never moves stock; only Receiving does.)
 */

/** Effective factor: a positive multiplier; null / ≤0 / non-finite ⇒ 1:1. */
export function effectiveFactor(factor: number | null | undefined): number {
  if (factor == null) return 1;
  const f = Number(factor);
  return Number.isFinite(f) && f > 0 ? f : 1;
}

/** purchase-unit quantity → stock-unit quantity. */
export function toStockQuantity(
  purchaseQty: number,
  factor: number | null | undefined
): number {
  return purchaseQty * effectiveFactor(factor);
}

/** cost per purchase-unit → cost per stock-unit. null/non-finite in ⇒ null out. */
export function toStockUnitCost(
  purchaseUnitCost: number | null | undefined,
  factor: number | null | undefined
): number | null {
  if (purchaseUnitCost == null) return null;
  const c = Number(purchaseUnitCost);
  if (!Number.isFinite(c)) return null;
  return c / effectiveFactor(factor);
}
