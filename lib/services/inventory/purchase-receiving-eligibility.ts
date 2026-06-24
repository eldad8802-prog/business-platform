import { PurchaseOrderStatus } from "@prisma/client";
import { purchaseOrderService } from "@/lib/services/inventory/purchase-order.service";
import {
  derivePurchaseOrderFulfillment,
  type FulfillmentLineQuantities,
  type FulfillmentReadout,
  type FulfillmentStatus,
} from "@/lib/services/inventory/purchase-fulfillment";

/**
 * Purchasing Lifecycle Alignment — Phase C: Receiving Eligibility (read-only).
 *
 * Decides whether a PurchaseOrder can still be received, derived ENTIRELY from the
 * Receiving ledger (Phase B fulfillment) — never from the dead AWAITING_DELIVERY /
 * SENT / CLOSED stored statuses. This is what reconnects the dormant Receiving
 * engine to an open PO (e.g. one created via approve COMMIT_ONLY).
 *
 * Read-only: no writes, no schema, no status changes, no change to the receiving
 * engine / postReceivingSession / InventoryMovement.
 */

const EPS = 1e-9;

export type ReceiveEligibility = {
  receivable: boolean;
  fulfillment: FulfillmentStatus;
  totals: FulfillmentReadout["totals"];
  status: PurchaseOrderStatus;
};

/**
 * Pure predicate. A PurchaseOrder is receivable iff:
 *   - it is not CANCELLED,
 *   - it has ordered lines (orderedQty > 0),
 *   - it has open quantity (openQty > 0),
 *   - its derived fulfillment is NOT_RECEIVED or PARTIALLY_RECEIVED.
 * It NEVER consults AWAITING_DELIVERY / SENT / CLOSED.
 */
export function isPurchaseOrderReceivable(input: {
  status: PurchaseOrderStatus;
  fulfillment: FulfillmentStatus;
  totals: { orderedQty: number; openQty: number };
}): boolean {
  if (input.status === PurchaseOrderStatus.CANCELLED) return false;
  if (input.totals.orderedQty <= EPS) return false;
  if (input.totals.openQty <= EPS) return false;
  return (
    input.fulfillment === "NOT_RECEIVED" ||
    input.fulfillment === "PARTIALLY_RECEIVED"
  );
}

function buildEligibility(
  storedStatus: PurchaseOrderStatus,
  lines: FulfillmentLineQuantities[]
): ReceiveEligibility {
  const { status: fulfillment, totals } = derivePurchaseOrderFulfillment(lines);
  return {
    receivable: isPurchaseOrderReceivable({ status: storedStatus, fulfillment, totals }),
    fulfillment,
    totals,
    status: storedStatus,
  };
}

/**
 * `getPurchaseOrder` / `listPurchaseOrders` enrich each line with ledger-derived
 * quantities at runtime (receivedQty / closedShortQty / openQty) via
 * withPurchaseOrderLineQuantities, but the inferred type does not surface them.
 */
function enrichedLines(po: { lines: unknown }): FulfillmentLineQuantities[] {
  return po.lines as unknown as FulfillmentLineQuantities[];
}

/** Read-only: derive receive-eligibility for one PurchaseOrder. */
export async function getPurchaseOrderReceiveEligibility(
  businessId: number,
  purchaseOrderId: number
): Promise<ReceiveEligibility> {
  const po = await purchaseOrderService.getPurchaseOrder({
    businessId,
    purchaseOrderId,
  });
  return buildEligibility(po.status, enrichedLines(po));
}

/** Read-only: the PurchaseOrders that can still be received, derived from openQty. */
export async function listReceivablePurchaseOrders(
  businessId: number,
  limit?: number
): Promise<Array<{ purchaseOrderId: number; eligibility: ReceiveEligibility }>> {
  const purchaseOrders = await purchaseOrderService.listPurchaseOrders({
    businessId,
    limit: limit ?? null,
  });

  return purchaseOrders
    .map((po) => ({
      purchaseOrderId: po.id,
      eligibility: buildEligibility(po.status, enrichedLines(po)),
    }))
    .filter((row) => row.eligibility.receivable);
}
