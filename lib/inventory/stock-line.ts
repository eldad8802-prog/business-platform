import type { InventoryItemDTO } from "@/lib/api/inventory";
import { getStockTone } from "@/lib/inventory/stock-tone";
import { qtyWithUnit } from "@/lib/inventory/unit-words";

/**
 * The short stock sentence a list row shows, worded by the existing tone rule
 * (critical: qty ≤ minimum; low: qty ≤ reorder point): "אזל מהמלאי",
 * "נותר 1 מארז", "נותרו 3 יחידות", "5 מארזים במלאי".
 */
export function stockLine(item: Pick<InventoryItemDTO, "currentQuantity" | "minimumQuantity" | "reorderPoint" | "unitType">): {
  text: string;
  tone: "critical" | "low" | "ok";
} {
  const tone = getStockTone(item as InventoryItemDTO);
  if (tone === "critical") {
    if (item.currentQuantity <= 0) return { text: "אזל מהמלאי", tone };
    return { text: `${item.currentQuantity === 1 ? "נותר" : "נותרו"} ${qtyWithUnit(item.currentQuantity, item.unitType)}`, tone };
  }
  return { text: `${qtyWithUnit(item.currentQuantity, item.unitType)} במלאי`, tone };
}

export const TONE_WORD: Record<"critical" | "low" | "ok", string> = {
  critical: "מלאי קריטי",
  low: "מלאי נמוך",
  ok: "תקין",
};
