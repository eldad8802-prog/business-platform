import { prisma } from "@/lib/prisma";
import { InventoryMovementReason } from "@prisma/client";

const WINDOW_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type ItemVelocity = {
  itemId: number;
  soldLast30d: number;
  txCount: number;
  avgDailyRate: number;
  daysOfStockLeft: number | null;
  urgency: "CRITICAL" | "HIGH" | "MEDIUM" | null;
};

function computeUrgency(
  daysOfStockLeft: number | null,
  txCount: number,
  avgDailyRate: number
): "CRITICAL" | "HIGH" | "MEDIUM" | null {
  if (txCount < 2) return null;         // too few data points — not reliable
  if (avgDailyRate <= 0) return null;   // item not selling
  if (daysOfStockLeft === null) return null;
  if (daysOfStockLeft < 7) return "CRITICAL";
  if (daysOfStockLeft < 14) return "HIGH";
  if (daysOfStockLeft < 21) return "MEDIUM";
  return null;
}

/**
 * Computes 30-day sales velocity for a set of inventory items.
 *
 * Only reads InventoryMovement rows with reason=SALE — no writes,
 * no side effects, no changes to stock or movement logic.
 *
 * @param businessId     Scopes all queries to the business.
 * @param itemIds        Subset to compute (avoids full-table scan).
 * @param currentQtyMap  Current quantity per itemId, passed in to avoid
 *                       a second DB round-trip from the caller.
 */
export async function getVelocityMap(
  businessId: number,
  itemIds: number[],
  currentQtyMap: Map<number, number>
): Promise<Map<number, ItemVelocity>> {
  if (itemIds.length === 0) return new Map();

  const since = new Date(Date.now() - WINDOW_DAYS * MS_PER_DAY);

  const rows = await prisma.inventoryMovement.groupBy({
    by: ["itemId"],
    where: {
      businessId,
      reason: InventoryMovementReason.SALE,
      itemId: { in: itemIds },
      createdAt: { gte: since },
    },
    _sum: { quantityDelta: true },
    _count: { id: true },
  });

  const result = new Map<number, ItemVelocity>();

  for (const row of rows) {
    // quantityDelta is negative for OUT movements — use absolute value.
    const soldLast30d = Math.abs(row._sum.quantityDelta ?? 0);
    const txCount = row._count.id;
    const avgDailyRate = soldLast30d / WINDOW_DAYS;

    const currentQty = currentQtyMap.get(row.itemId) ?? 0;

    // Items at zero stock are already covered by low/critical alerts.
    // Avoid division-by-zero and misleading "0 days" display.
    const daysOfStockLeft =
      currentQty > 0 && avgDailyRate > 0
        ? currentQty / avgDailyRate
        : null;

    result.set(row.itemId, {
      itemId: row.itemId,
      soldLast30d,
      txCount,
      avgDailyRate,
      daysOfStockLeft,
      urgency: computeUrgency(daysOfStockLeft, txCount, avgDailyRate),
    });
  }

  return result;
}
