import { prisma } from "@/lib/prisma";
import { purchaseOrderService } from "@/lib/services/inventory/purchase-order.service";

/**
 * Purchasing Lifecycle Alignment — Phase B: Derived Fulfillment Status.
 *
 * Fulfillment is a READ MODEL, never stored (closes G3). It is derived purely from
 * the Receiving ledger quantities that already exist today:
 *   orderedQty, receivedQty (Σ POSTED ReceivingSessions), closedShortQty
 *   (CLOSED_SHORT remaining decisions), and openQty (= ordered − received − closed).
 *
 * No column, no enum, no migration, no write. The same PurchaseOrder yields a
 * different fulfillment label over time as the ledger grows — with zero status
 * writes. This intentionally does NOT touch reachability (receive page, openQty
 * eligibility, AWAITING_DELIVERY/SENT/CLOSED stored statuses) — that is Phase C/D.
 */

export type FulfillmentStatus =
  | "NOT_RECEIVED"
  | "PARTIALLY_RECEIVED"
  | "FULLY_RECEIVED"
  | "CLOSED";

/** Float tolerance for quantity comparisons (qtys are stored as Float). */
const EPS = 1e-9;

export type FulfillmentLineQuantities = {
  orderedQty: number;
  receivedQty: number;
  closedShortQty: number;
  openQty: number;
};

export type FulfillmentReadout = {
  status: FulfillmentStatus;
  totals: {
    orderedQty: number;
    receivedQty: number;
    closedShortQty: number;
    openQty: number;
  };
};

/**
 * Derive a PurchaseOrder's fulfillment status from its line quantities. Pure.
 *
 *   openQty  > 0  →  NOT_RECEIVED      (nothing physically received yet)
 *                    PARTIALLY_RECEIVED (some received, remainder still open)
 *   openQty == 0  →  FULLY_RECEIVED    (everything received, no shortfall)
 *                    CLOSED            (done, but with a closed-short shortfall)
 */
export function derivePurchaseOrderFulfillment(
  lines: FulfillmentLineQuantities[]
): FulfillmentReadout {
  if (lines.length === 0) {
    return {
      status: "NOT_RECEIVED",
      totals: { orderedQty: 0, receivedQty: 0, closedShortQty: 0, openQty: 0 },
    };
  }

  const totals = lines.reduce(
    (acc, line) => {
      acc.orderedQty += line.orderedQty;
      acc.receivedQty += line.receivedQty;
      acc.closedShortQty += line.closedShortQty;
      acc.openQty += line.openQty;
      return acc;
    },
    { orderedQty: 0, receivedQty: 0, closedShortQty: 0, openQty: 0 }
  );

  let status: FulfillmentStatus;
  if (totals.openQty > EPS) {
    status = totals.receivedQty > EPS ? "PARTIALLY_RECEIVED" : "NOT_RECEIVED";
  } else {
    status = totals.closedShortQty > EPS ? "CLOSED" : "FULLY_RECEIVED";
  }

  return { status, totals };
}

/**
 * Read-only consumer: fetch a PurchaseOrder (with ledger-derived line quantities)
 * and return its derived fulfillment. Reuses the existing enriched read — no new
 * source of truth, no writes.
 */
export async function getPurchaseOrderFulfillment(
  businessId: number,
  purchaseOrderId: number
): Promise<FulfillmentReadout> {
  const purchaseOrder = await purchaseOrderService.getPurchaseOrder({
    businessId,
    purchaseOrderId,
  });

  // `getPurchaseOrder` enriches each line with ledger-derived quantities at
  // runtime (receivedQty / closedShortQty / openQty) via
  // withPurchaseOrderLineQuantities, but its inferred return type does not surface
  // them. Read them through the precise enriched shape — no new source of truth.
  const lines = purchaseOrder.lines as unknown as FulfillmentLineQuantities[];

  return derivePurchaseOrderFulfillment(
    lines.map((line) => ({
      orderedQty: line.orderedQty,
      receivedQty: line.receivedQty,
      closedShortQty: line.closedShortQty,
      openQty: line.openQty,
    }))
  );
}

/**
 * Read-only batch variant for a business — derives fulfillment per PurchaseOrder
 * from the same ledger. Convenience for callers that already hold a list; still
 * pure-derivation under the hood. (Kept minimal: Phase B exposes the capability,
 * it does not wire any queue/eligibility — that is Phase C.)
 */
export async function listPurchaseOrderFulfillments(
  businessId: number,
  purchaseOrderIds: number[]
): Promise<Map<number, FulfillmentReadout>> {
  const result = new Map<number, FulfillmentReadout>();
  if (purchaseOrderIds.length === 0) return result;

  // Reuse the enriched read per id to keep a single derivation path.
  for (const id of purchaseOrderIds) {
    const exists = await prisma.purchaseOrder.findFirst({
      where: { id, businessId },
      select: { id: true },
    });
    if (!exists) continue;
    result.set(id, await getPurchaseOrderFulfillment(businessId, id));
  }

  return result;
}
