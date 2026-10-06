/**
 * M7-B — purchase demand from online-store orders (docs/business-intake-m7-decision-v1.md §11):
 * `OfferingDemandSignal` PURCHASE, source COMMERCE, "only when a line maps to an offering".
 *
 * A line maps ONLY on an exact SKU naming exactly ONE active product of the business. No SKU, no
 * product, or several products with that SKU → no signal (never guessed, never matched by title).
 * One signal per order line (`purchase:commerce-line:<id>`), recorded once the order is a purchase
 * (paid / fulfilled / partially refunded); a cancel or a full refund later does not erase that it was
 * bought. Categories only: no customer, no text, no amount is written.
 */

import type { Prisma } from "@prisma/client";
import { recordOfferingDemand } from "@/lib/services/offering/offering-demand";

type Tx = Prisma.TransactionClient;

export const PURCHASE_STATES = new Set(["paid", "fulfilled", "partially_refunded"]);

export async function recordCommerceDemand(tx: Tx, businessId: number, orderId: number): Promise<number> {
  const lines = await tx.commerceOrderLine.findMany({
    where: { businessId, orderId, present: true, sku: { not: null } },
    select: { id: true, sku: true },
    orderBy: { id: "asc" },
  });
  let recorded = 0;
  for (const line of lines) {
    const sku = line.sku?.trim();
    if (!sku) continue;
    const items = await tx.inventoryItem.findMany({
      where: { businessId, sku, isActive: true },
      select: { id: true },
      take: 2,
    });
    if (items.length !== 1) continue;
    const signal = await recordOfferingDemand(tx, {
      businessId,
      kind: "PRODUCT",
      offeringId: items[0].id,
      signalType: "PURCHASE",
      source: "COMMERCE",
      idempotencyKey: `purchase:commerce-line:${line.id}`,
      commerceOrderLineId: line.id,
    });
    if (signal) recorded += 1;
  }
  return recorded;
}
