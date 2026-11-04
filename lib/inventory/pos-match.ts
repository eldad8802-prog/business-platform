import type { InventoryItemDTO, InventoryPendingMatchDTO } from "@/lib/api/inventory";

/**
 * Client-side helpers for linking a POS sale line to a product. The scoring is the
 * one the matching screen always used (barcode 100, SKU 80, name contained 50);
 * only its presentation changed — it now returns the best few instead of one.
 */
export function posSaleName(pending: Pick<InventoryPendingMatchDTO, "metadata" | "externalSaleId">): string {
  const meta = pending.metadata ?? ({} as InventoryPendingMatchDTO["metadata"]);
  return meta.name || meta.sku || meta.barcode || pending.externalSaleId || "פריט מהקופה";
}

export function scorePosMatch(meta: InventoryPendingMatchDTO["metadata"], item: InventoryItemDTO): number {
  let s = 0;
  if (meta.barcode && item.barcode === meta.barcode) s += 100;
  if (meta.sku && item.sku === meta.sku) s += 80;
  if (meta.name && item.name) {
    const n = meta.name.toLowerCase();
    const i = item.name.toLowerCase();
    if (i.includes(n) || n.includes(i)) s += 50;
  }
  return s;
}

/** Products worth suggesting (score ≥ 50, the old "possible match" band), best first. */
export function suggestPosMatches(
  pending: Pick<InventoryPendingMatchDTO, "metadata">,
  items: InventoryItemDTO[],
  limit = 5
): Array<{ item: InventoryItemDTO; score: number }> {
  const meta = pending.metadata ?? ({} as InventoryPendingMatchDTO["metadata"]);
  return items
    .map((item) => ({ item, score: scorePosMatch(meta, item) }))
    .filter((m) => m.score >= 50)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name, "he"))
    .slice(0, limit);
}

export function formatPosWhen(value: string | undefined | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("he-IL", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
}
