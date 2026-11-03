/**
 * Purchasing hub — presentation helpers (inventory redesign, owner-approved 2026-11-03).
 * Pure functions only: they word the two purchasing models (supplier-purchase DRAFT and
 * PurchaseOrder) for the screens. No request, no business rule changes.
 */

export type HubDraftLine = {
  id: number;
  rawName: string | null;
  quantity: number;
  unitType?: string | null;
  matchedItemId?: number | null;
};

export type HubDraft = {
  id: number;
  supplierId?: number | null;
  supplierName: string | null;
  externalOrderId?: string | null;
  status: string;
  orderDate?: string | null;
  createdAt?: string;
  lines: HubDraftLine[];
};

export type HubPoLine = {
  id: number;
  itemId?: number | null;
  rawName?: string | null;
  orderedQty: number;
  unitType?: string | null;
  receivedQty?: number;
  closedShortQty?: number;
  openQty?: number;
};

export type HubPo = {
  id: number;
  supplierId?: number | null;
  supplierName: string | null;
  externalOrderId: string | null;
  status: string;
  orderDate: string | null;
  createdAt: string;
  sourceSupplierPurchaseDraftId?: number | null;
  lines: HubPoLine[];
};

export type HubTab = "receive" | "open" | "history";
export type StatusTone = "ok" | "warn" | "info" | undefined;

export type HubRow = {
  key: string;
  kind: "draft" | "po";
  id: number;
  kicker: string;
  supplier: string;
  supplierId: number | null;
  lineCount: number;
  externalOrderId: string | null;
  date: string | null;
  status: { label: string; tone: StatusTone };
  action: { label: string; href: string };
  tab: HubTab;
};

const BASE = "/inventory/supplier-purchases";

function lineOpen(line: HubPoLine): number {
  const open =
    typeof line.openQty === "number"
      ? line.openQty
      : line.orderedQty - (line.receivedQty ?? 0) - (line.closedShortQty ?? 0);
  return Math.max(0, open);
}

export function poOpenQty(po: HubPo): number {
  if (po.status === "CLOSED" || po.status === "CANCELLED") return 0;
  return po.lines.reduce((s, l) => s + lineOpen(l), 0);
}

export function poReceivedQty(po: HubPo): number {
  return po.lines.reduce((s, l) => s + Math.max(0, l.receivedQty ?? 0), 0);
}

const PO_WORD: Record<string, string> = {
  DRAFT: "טיוטה",
  CONFIRMED: "מאושרת",
  SENT: "נשלחה",
  AWAITING_DELIVERY: "ממתינה לאספקה",
};

export function poStatus(po: HubPo): { label: string; tone: StatusTone } {
  if (po.status === "CLOSED") return { label: "הושלמה", tone: "ok" };
  if (po.status === "CANCELLED") return { label: "בוטלה", tone: undefined };
  if (poReceivedQty(po) > 0 && poOpenQty(po) > 0) return { label: "התקבלה חלקית", tone: "info" };
  return { label: PO_WORD[po.status] ?? "הזמנה פתוחה", tone: undefined };
}

export function draftStatus(status: string): { label: string; tone: StatusTone } {
  if (status === "PENDING_REVIEW") return { label: "טיוטה ממתינה לקליטה", tone: "warn" };
  if (status === "APPROVED") return { label: "נקלטה במלאי", tone: "ok" };
  if (status === "REJECTED") return { label: "בוטלה", tone: undefined };
  return { label: "טיוטה", tone: undefined };
}

export function isPoOpen(po: HubPo): boolean {
  return po.status !== "CLOSED" && po.status !== "CANCELLED";
}

/**
 * One list for both models. An APPROVED draft and the CLOSED PO created from it
 * (sourceSupplierPurchaseDraftId) are ONE history row — shown as the purchase order.
 */
export function buildHubRows(drafts: HubDraft[], pos: HubPo[]): HubRow[] {
  const rows: HubRow[] = [];
  const poFromDraft = new Set<number>();
  for (const po of pos) {
    if (po.sourceSupplierPurchaseDraftId != null) poFromDraft.add(po.sourceSupplierPurchaseDraftId);
  }
  for (const d of drafts) {
    if (d.status === "APPROVED" && poFromDraft.has(d.id)) continue;
    const pending = d.status === "PENDING_REVIEW";
    rows.push({
      key: `d${d.id}`,
      kind: "draft",
      id: d.id,
      kicker: "טיוטת הזמנה",
      supplier: d.supplierName?.trim() || "ללא ספק",
      supplierId: d.supplierId ?? null,
      lineCount: d.lines.length,
      externalOrderId: d.externalOrderId ?? null,
      date: d.orderDate ?? d.createdAt ?? null,
      status: draftStatus(d.status),
      action: { label: "לצפייה", href: `${BASE}/${d.id}/send` },
      tab: pending ? "receive" : "history",
    });
  }
  for (const po of pos) {
    const open = poOpenQty(po) > 0;
    const fromDraft = po.sourceSupplierPurchaseDraftId != null && po.status === "CLOSED";
    rows.push({
      key: `p${po.id}`,
      kind: "po",
      id: po.id,
      kicker: "הזמנת רכש",
      supplier: po.supplierName?.trim() || "ללא ספק",
      supplierId: po.supplierId ?? null,
      lineCount: po.lines.length,
      externalOrderId: po.externalOrderId ?? null,
      date: po.orderDate ?? po.createdAt ?? null,
      status: fromDraft ? { label: "נקלטה במלאי", tone: "ok" } : poStatus(po),
      action: open
        ? { label: "לקבלת סחורה", href: `${BASE}/${po.id}/receive` }
        : { label: "לצפייה", href: `${BASE}/orders/${po.id}` },
      tab: isPoOpen(po) ? "open" : "history",
    });
  }
  rows.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  return rows;
}

/** Search by supplier name or order number (our id or the supplier's own order id). */
export function matchesHubSearch(row: HubRow, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  const num = s.replace(/^#/, "");
  return (
    row.supplier.toLowerCase().includes(s) ||
    String(row.id).includes(num) ||
    (row.externalOrderId ? row.externalOrderId.toLowerCase().includes(num) : false)
  );
}

/** "3.11.2026" — the order date line. */
export function formatOrderDate(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
}

export function productsWord(n: number): string {
  return n === 1 ? "מוצר אחד" : `${n.toLocaleString("he-IL")} מוצרים`;
}
