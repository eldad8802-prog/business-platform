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

import { PurchaseOrderStatus } from "@prisma/client";
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
};

export type SupplierPurchaseHistorySummary = {
  purchaseOrderCount: number;
  openPurchaseOrderCount: number;
  lastPurchaseOrderAt: string | null;
};

export type SupplierPurchaseHistory = {
  summary: SupplierPurchaseHistorySummary;
  items: SupplierPurchaseOrderItem[];
  pagination: { limit: number; offset: number; total: number; hasMore: boolean };
};

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
  input: GetSupplierPurchaseHistoryInput
): Promise<SupplierPurchaseHistory> {
  if (!input.businessId || Number.isNaN(input.businessId)) {
    throw new InventoryUnauthorizedError("Invalid business id");
  }
  const businessId = input.businessId;
  const supplierId = normalizeId(input.supplierId, "supplier id");
  const limit = normalizeLimit(input.limit);
  const offset = normalizeOffset(input.offset);

  // Tenant-safe existence: a supplier of another business looks non-existent.
  const supplier = await prisma.supplier.findFirst({
    where: { id: supplierId, businessId },
    select: { id: true },
  });
  if (!supplier) {
    throw new InventoryNotFoundError("Supplier not found");
  }

  // Relation is by ENTITY only — double-scoped, never by supplierName.
  const scope = { businessId, supplierId } as const;

  const [total, openCount, lastAgg, rows] = await Promise.all([
    prisma.purchaseOrder.count({ where: scope }),
    prisma.purchaseOrder.count({
      where: { ...scope, status: { in: OPEN_PURCHASE_ORDER_STATUSES } },
    }),
    prisma.purchaseOrder.aggregate({ where: scope, _max: { createdAt: true } }),
    prisma.purchaseOrder.findMany({
      where: scope,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: offset,
      take: limit,
      select: {
        id: true,
        supplierId: true,
        supplierName: true,
        status: true,
        orderDate: true,
        createdAt: true,
        _count: { select: { lines: true } },
      },
    }),
  ]);

  const items: SupplierPurchaseOrderItem[] = rows.map((r) => ({
    id: r.id,
    supplierId: r.supplierId,
    supplierName: r.supplierName,
    status: r.status,
    orderDate: r.orderDate ? r.orderDate.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    lineCount: r._count.lines,
  }));

  return {
    summary: {
      purchaseOrderCount: total,
      openPurchaseOrderCount: openCount,
      lastPurchaseOrderAt: lastAgg._max.createdAt
        ? lastAgg._max.createdAt.toISOString()
        : null,
    },
    items,
    pagination: { limit, offset, total, hasMore: offset + items.length < total },
  };
}
