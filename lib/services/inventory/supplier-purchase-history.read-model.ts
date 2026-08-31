/**
 * Supplier Purchase History — canonical READ-ONLY read model for the supplier
 * card (S4-P4). Returns the purchase orders linked to a Supplier ENTITY via the
 * Tier-2 Entity-FK `PurchaseOrder.supplierId` ONLY. `supplierName` is a Tier-1
 * Historical Snapshot and is NEVER used to relate orders to a supplier — it is
 * returned for display only. See docs/dubiz-party-identity-strategy-v1.md.
 *
 * Every query is double-scoped by `businessId` AND `supplierId`. A supplier from
 * another business behaves exactly like a non-existent one (tenant-safe).
 *
 * Canonical date = `createdAt` (always present, monotonic, deterministic) — used
 * for ordering and `lastPurchaseOrderAt`. `orderDate` is nullable/optional and is
 * therefore returned as a display-only field, not the canonical key.
 *
 * "Open" purchase orders = any status that is NOT terminal. Terminal statuses are
 * CLOSED and CANCELLED; open = DRAFT | CONFIRMED | SENT | AWAITING_DELIVERY. No
 * new statuses are introduced.
 */

import { PurchaseOrderStatus, ReceivingSessionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  InventoryNotFoundError,
  InventoryUnauthorizedError,
  InventoryValidationError,
} from "@/lib/services/inventory/inventory.errors";

/** Terminal (not-open) statuses. Open = everything else. */
export const TERMINAL_PURCHASE_ORDER_STATUSES: PurchaseOrderStatus[] = [
  PurchaseOrderStatus.CLOSED,
  PurchaseOrderStatus.CANCELLED,
];
export const OPEN_PURCHASE_ORDER_STATUSES: PurchaseOrderStatus[] = [
  PurchaseOrderStatus.DRAFT,
  PurchaseOrderStatus.CONFIRMED,
  PurchaseOrderStatus.SENT,
  PurchaseOrderStatus.AWAITING_DELIVERY,
];

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export type SupplierPurchaseOrderItem = {
  id: number;
  supplierId: number | null;
  /** Tier-1 snapshot — display only, never used for the relation. */
  supplierName: string | null;
  status: PurchaseOrderStatus;
  /** Business date, display only (may be null). */
  orderDate: string | null;
  /** Canonical date (ordering + lastPurchaseOrderAt). */
  createdAt: string;
  lineCount: number;
  /**
   * Σ(orderedQty × unitCost) over the order's lines, counting only lines that
   * actually state a cost. Null when NO line states one — an order with no
   * costs recorded has no total, and showing ₪0 would be a lie.
   */
  orderedValue: number | null;
};

export type SupplierPurchaseHistorySummary = {
  purchaseOrderCount: number;
  openPurchaseOrderCount: number;
  lastPurchaseOrderAt: string | null;
  /**
   * What was actually taken into stock from this supplier: Σ(receivedQty ×
   * unitCost) over POSTED receiving lines only. This is spend, not intent — an
   * order that was placed but never received contributes nothing.
   */
  receivedValue: number;
  /** Σ(orderedQty × unitCost) across every order, costed lines only. */
  orderedValue: number;
  /**
   * How many order lines carry no cost at all. The UI needs this to say
   * "מבוסס על X מתוך Y שורות" instead of presenting a partial sum as a total.
   */
  linesWithoutCost: number;
  totalLineCount: number;
};

/**
 * What this supplier actually supplies, most-purchased first. Answers "מה קניתי
 * ממנו" and — via first/last unit cost — "האם המחירים השתנו", from data the
 * purchase lines already hold. No scoring, no inference, no new analytics.
 */
export type SupplierPurchasedItem = {
  itemId: number;
  name: string;
  orderCount: number;
  totalQty: number;
  firstUnitCost: number | null;
  lastUnitCost: number | null;
};

export type SupplierPurchaseHistory = {
  summary: SupplierPurchaseHistorySummary;
  items: SupplierPurchaseOrderItem[];
  /** Top purchased items. Capped — this is a card section, not a report. */
  purchasedItems: SupplierPurchasedItem[];
  pagination: { limit: number; offset: number; total: number; hasMore: boolean };
};

const PURCHASED_ITEMS_LIMIT = 5;

export type GetSupplierPurchaseHistoryInput = {
  businessId: number;
  supplierId: number;
  limit?: number | null;
  offset?: number | null;
};

function normalizeLimit(value?: number | null): number {
  if (value == null) return DEFAULT_LIMIT;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InventoryValidationError("Invalid limit");
  }
  return Math.min(n, MAX_LIMIT);
}

function normalizeOffset(value?: number | null): number {
  if (value == null) return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new InventoryValidationError("Invalid offset");
  }
  return n;
}

function normalizeId(value: number, field: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InventoryValidationError(`Invalid ${field}`);
  }
  return n;
}

export async function getSupplierPurchaseHistory(
  input: GetSupplierPurchaseHistoryInput,
  options?: { tx?: import("@prisma/client").Prisma.TransactionClient }
): Promise<SupplierPurchaseHistory> {
  if (!input.businessId || Number.isNaN(input.businessId)) {
    throw new InventoryUnauthorizedError("Invalid business id");
  }
  const db = options?.tx ?? prisma;
  const businessId = input.businessId;
  const supplierId = normalizeId(input.supplierId, "supplier id");
  const limit = normalizeLimit(input.limit);
  const offset = normalizeOffset(input.offset);

  // Tenant-safe existence: a supplier of another business looks non-existent.
  const supplier = await db.supplier.findFirst({
    where: { id: supplierId, businessId },
    select: { id: true },
  });
  if (!supplier) {
    throw new InventoryNotFoundError("Supplier not found");
  }

  // Relation is by ENTITY only — double-scoped, never by supplierName.
  const scope = { businessId, supplierId } as const;

  // ── TWO queries, and that is the budget ─────────────────────────────────
  // These run sequentially (a TenantTx must not issue concurrent queries) while
  // the tenant transaction holds its pooled connection, so every extra statement
  // is a serialized network round trip that also keeps the connection away from
  // the other requests the supplier card fires in parallel. This read model used
  // to spend FOUR (count + open-count + max(createdAt) + page) and returned no
  // money at all; it now spends TWO and returns the totals and the items as well.
  //
  // The cost of that: the supplier's orders and lines are read in full and the
  // page is sliced in memory rather than by the database. That is the right
  // trade here — the totals and the purchased-item roll-up are defined over ALL
  // of a supplier's orders anyway ("how much have I spent with them" must not
  // quietly mean "on this page"), so the rows are needed regardless, and one
  // supplier's purchase history is a bounded, card-sized set. The paging
  // contract on the wire is unchanged.
  const orders = await db.purchaseOrder.findMany({
    where: scope,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      supplierId: true,
      supplierName: true,
      status: true,
      orderDate: true,
      createdAt: true,
      _count: { select: { lines: true } },
    },
  });

  const total = orders.length;
  const openCount = orders.filter((o) =>
    OPEN_PURCHASE_ORDER_STATUSES.includes(o.status)
  ).length;
  const lastCreatedAt = orders.length ? orders[0].createdAt : null;

  // ── Money and items (P7) ────────────────────────────────────────────────
  // Aggregated over EVERY order of this supplier, not just the page above, so
  // "how much have I spent with them" does not silently mean "on this page".
  // Still double-scoped by businessId AND supplierId, and still sequential —
  // a TenantTx must not run concurrent queries.
  // ONE query for every money and item figure below: the lines, the item they
  // point at, and each line's POSTED receipts, nested rather than fetched as a
  // second round trip. Prisma cannot express Σ(qty × unitCost) in an aggregate,
  // so the rows are summed here — but they are read once, not twice.
  const allLines = await db.purchaseOrderLine.findMany({
    where: { purchaseOrder: scope },
    select: {
      id: true,
      itemId: true,
      orderedQty: true,
      unitCost: true,
      purchaseOrderId: true,
      item: { select: { id: true, name: true } },
      receivingLines: {
        where: { receivingSession: { status: ReceivingSessionStatus.POSTED } },
        select: { receivedQty: true, unitCost: true },
      },
    },
    orderBy: { id: "asc" },
  });

  const orderedValue = allLines.reduce(
    (sum, l) => (l.unitCost != null ? sum + l.orderedQty * l.unitCost : sum),
    0
  );
  const linesWithoutCost = allLines.filter((l) => l.unitCost == null).length;

  // Spend = what was actually posted into stock, never what was merely ordered.
  const receivedValue = allLines.reduce(
    (sum, line) =>
      sum +
      line.receivingLines.reduce(
        (lineSum, r) =>
          r.unitCost != null ? lineSum + r.receivedQty * r.unitCost : lineSum,
        0
      ),
    0
  );

  // Lines already arrive ordered by id ascending = creation order, so the first
  // costed line seen for an item is genuinely its earliest recorded cost.
  const byItem = new Map<
    number,
    {
      name: string;
      orders: Set<number>;
      totalQty: number;
      firstUnitCost: number | null;
      lastUnitCost: number | null;
    }
  >();

  for (const line of allLines) {
    if (line.itemId == null || !line.item) continue;
    const existing = byItem.get(line.itemId) ?? {
      name: line.item.name,
      orders: new Set<number>(),
      totalQty: 0,
      firstUnitCost: null,
      lastUnitCost: null,
    };
    existing.orders.add(line.purchaseOrderId);
    existing.totalQty += line.orderedQty;
    if (line.unitCost != null) {
      if (existing.firstUnitCost == null) existing.firstUnitCost = line.unitCost;
      existing.lastUnitCost = line.unitCost;
    }
    byItem.set(line.itemId, existing);
  }

  // Per-order totals come from the lines already in hand — no third query.
  const orderedValueByOrder = new Map<number, number | null>();
  for (const line of allLines) {
    if (line.unitCost == null) continue;
    const current = orderedValueByOrder.get(line.purchaseOrderId) ?? 0;
    orderedValueByOrder.set(
      line.purchaseOrderId,
      current + line.orderedQty * line.unitCost
    );
  }

  const items: SupplierPurchaseOrderItem[] = orders
    .slice(offset, offset + limit)
    .map((r) => ({
      id: r.id,
      supplierId: r.supplierId,
      supplierName: r.supplierName,
      status: r.status,
      orderDate: r.orderDate ? r.orderDate.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      lineCount: r._count.lines,
      orderedValue: orderedValueByOrder.get(r.id) ?? null,
    }));

  const purchasedItems: SupplierPurchasedItem[] = Array.from(byItem.entries())
    .map(([itemId, v]) => ({
      itemId,
      name: v.name,
      orderCount: v.orders.size,
      totalQty: v.totalQty,
      firstUnitCost: v.firstUnitCost,
      lastUnitCost: v.lastUnitCost,
    }))
    .sort((a, b) => b.totalQty - a.totalQty || a.itemId - b.itemId)
    .slice(0, PURCHASED_ITEMS_LIMIT);

  return {
    summary: {
      purchaseOrderCount: total,
      openPurchaseOrderCount: openCount,
      lastPurchaseOrderAt: lastCreatedAt ? lastCreatedAt.toISOString() : null,
      receivedValue,
      orderedValue,
      linesWithoutCost,
      totalLineCount: allLines.length,
    },
    items,
    purchasedItems,
    pagination: { limit, offset, total, hasMore: offset + items.length < total },
  };
}
