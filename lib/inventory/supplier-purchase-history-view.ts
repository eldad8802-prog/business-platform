/**
 * Supplier Purchase History — presentation helpers for the supplier card section
 * (S4-P5). Pure, framework-free logic so it can be unit-tested without a DOM.
 *
 * The status labels mirror the canonical PurchaseOrder status vocabulary already
 * used in the supplier-purchases screen (טיוטה / מאושרת / נשלחה / …). No new
 * statuses are introduced and open/closed is NOT computed here — the API owns
 * `openPurchaseOrderCount`.
 */

import type { SupplierPurchaseOrderItem } from "@/lib/api/suppliers";

export type StatusBadge = { label: string; className: string };

/**
 * Canonical PurchaseOrder statuses → Hebrew label + crm badge class. Mirrors the
 * labels in app/(shell)/inventory/supplier-purchases/page.tsx (single source of
 * truth for the wording); rendered with the supplier card's crm-badge tones.
 */
const STATUS_BADGE: Record<string, StatusBadge> = {
  DRAFT: { label: "טיוטה", className: "crm-badge" },
  CONFIRMED: { label: "מאושרת", className: "crm-badge crm-badge--info" },
  SENT: { label: "נשלחה", className: "crm-badge crm-badge--info" },
  AWAITING_DELIVERY: { label: "בהמתנה לאספקה", className: "crm-badge crm-badge--warning" },
  CLOSED: { label: "נסגרה", className: "crm-badge crm-badge--success" },
  CANCELLED: { label: "בוטלה", className: "crm-badge" },
};

/** Never invents a status: unknown values fall back to the raw string, neutral tone. */
export function statusBadge(status: string): StatusBadge {
  return STATUS_BADGE[status] ?? { label: status, className: "crm-badge" };
}

/** Israeli/Hebrew date, consistent with the supplier and customer cards. */
export function formatPurchaseDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("he-IL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

/** Human line/item count. 0 or invalid → calm fallback, never a broken "0 פריטים". */
export function formatLineCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "ללא פריטים";
  if (n === 1) return "פריט אחד";
  return `${n} פריטים`;
}

/**
 * Append the next page while preserving the server's order and dropping any id
 * already present. Guarantees no duplicates even if a page is requested twice.
 */
export function mergePurchaseOrderItems(
  existing: SupplierPurchaseOrderItem[],
  incoming: SupplierPurchaseOrderItem[]
): SupplierPurchaseOrderItem[] {
  const seen = new Set(existing.map((i) => i.id));
  const merged = existing.slice();
  for (const item of incoming) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      merged.push(item);
    }
  }
  return merged;
}

/**
 * Money, as ₪ with no fractional agorot. Returns null for "nothing to show" so a
 * caller can omit the line entirely rather than print ₪0 — an order with no
 * recorded costs has an UNKNOWN total, which is not the same as a zero one.
 */
export function formatSupplierMoney(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return `₪${Math.round(value).toLocaleString("he-IL")}`;
}

/**
 * How trustworthy a money figure is, given how many lines carried no cost.
 * Says so out loud rather than presenting a partial sum as a complete one.
 */
export function costCoverageNote(
  linesWithoutCost: number,
  totalLineCount: number
): string | null {
  if (totalLineCount <= 0 || linesWithoutCost <= 0) return null;
  if (linesWithoutCost >= totalLineCount) return "לא נרשמו עלויות בהזמנות";
  const withCost = totalLineCount - linesWithoutCost;
  return `מבוסס על ${withCost} מתוך ${totalLineCount} שורות שנרשמה בהן עלות`;
}

/**
 * Did the unit cost of an item move between the first and the last time it was
 * bought? Reports the direction only when BOTH ends are known — a single known
 * price is not a trend, and guessing one would be worse than saying nothing.
 */
export function priceTrend(
  firstUnitCost: number | null,
  lastUnitCost: number | null
): "UP" | "DOWN" | "SAME" | null {
  if (firstUnitCost == null || lastUnitCost == null) return null;
  if (lastUnitCost > firstUnitCost) return "UP";
  if (lastUnitCost < firstUnitCost) return "DOWN";
  return "SAME";
}

export const PRICE_TREND_LABEL: Record<"UP" | "DOWN" | "SAME", string> = {
  UP: "המחיר עלה",
  DOWN: "המחיר ירד",
  SAME: "המחיר לא השתנה",
};

/** The "טען עוד" button is enabled only when there is a next page and no fetch in flight. */
export function canLoadMore(hasMore: boolean, isLoadingMore: boolean): boolean {
  return hasMore && !isLoadingMore;
}
