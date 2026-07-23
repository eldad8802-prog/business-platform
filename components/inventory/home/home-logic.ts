import { getStockTone } from "@/components/inventory/inventory-design";
import type { InventoryItemDTO } from "@/lib/api/inventory";

/**
 * Home-screen derivations. Everything here is computed CLIENT-SIDE from the
 * existing `GET /api/inventory/items` payload — no new endpoint, no schema
 * change. (The mockup's trend % + sparkline are intentionally omitted: they need
 * stock-value history over time, which this payload does not carry.)
 */

const valueFormatter = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 0 });

/** Full number with thousands grouping; the ₪ symbol is rendered separately. */
export function formatStockValue(value: number): string {
  return valueFormatter.format(Math.round(value));
}

export type HomeSummary = {
  okCount: number;
  lowCount: number;
  criticalCount: number;
  activeCount: number;
  stockValue: number;
};

/** Tone counts + on-hand value, derived exactly like the previous home (getStockTone). */
export function deriveHomeSummary(items: InventoryItemDTO[]): HomeSummary {
  let okCount = 0;
  let lowCount = 0;
  let criticalCount = 0;
  let stockValue = 0;

  for (const item of items) {
    const tone = getStockTone(item);
    if (tone === "critical") criticalCount += 1;
    else if (tone === "low") lowCount += 1;
    else okCount += 1;

    const unitCost = item.costPerUnit ?? item.lastPurchaseCost ?? 0;
    stockValue += item.currentQuantity * unitCost;
  }

  return { okCount, lowCount, criticalCount, activeCount: items.length, stockValue };
}

export type AttentionReadout = {
  current: number;
  target: number;
  /** Fill percentage for the quantity bar, clamped to 0..100. */
  pct: number;
};

/**
 * "q / target" readout for an attention row. `target` is the reorder point when
 * set (the level whose breach raised the flag), else the hard minimum — both are
 * real DTO fields, nothing invented. The bar fills to `current / target`.
 */
export function getAttentionReadout(item: InventoryItemDTO): AttentionReadout {
  const target =
    item.reorderPoint != null && item.reorderPoint > 0
      ? item.reorderPoint
      : Math.max(item.minimumQuantity ?? 0, 1);
  const pct = Math.max(0, Math.min(100, (item.currentQuantity / target) * 100));
  return { current: item.currentQuantity, target, pct };
}

/** Time-of-day greeting (client local time). */
export function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "בוקר טוב";
  if (h < 18) return "צהריים טובים";
  return "ערב טוב";
}

/** Attention items (anything not "ok"), most severe first, then by name (he). */
export function selectAttentionItems(items: InventoryItemDTO[]): InventoryItemDTO[] {
  const order: Record<string, number> = { critical: 0, low: 1, ok: 2 };
  return [...items]
    .filter((item) => getStockTone(item) !== "ok")
    .sort((a, b) => {
      const ta = order[getStockTone(a)];
      const tb = order[getStockTone(b)];
      if (ta !== tb) return ta - tb;
      return a.name.localeCompare(b.name, "he");
    });
}
