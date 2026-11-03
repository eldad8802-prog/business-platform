/**
 * The stock state of one product — the single rule every inventory screen uses.
 * Pure (no React), so lib code can use it without pulling in UI components.
 * `components/inventory/inventory-design` re-exports it unchanged.
 */
export function getStockTone(item: {
  currentQuantity: number;
  minimumQuantity?: number;
  reorderPoint?: number | null;
}): "ok" | "critical" | "low" {
  const min = item.minimumQuantity ?? 0;
  if (item.currentQuantity <= min) return "critical";
  if (
    item.reorderPoint != null &&
    item.currentQuantity <= item.reorderPoint
  ) {
    return "low";
  }
  return "ok";
}
