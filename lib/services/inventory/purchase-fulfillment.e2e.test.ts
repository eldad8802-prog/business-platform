/**
 * Purchasing Phase B — derived fulfillment end-to-end (run manually, DIRECT url):
 *   DATABASE_URL=$DIRECT_URL npx tsx lib/services/inventory/purchase-fulfillment.e2e.test.ts
 *
 * Proves fulfillment is derived from the Receiving ledger ALONE, with ZERO status
 * writes:
 *   - Fresh PO (no receiving)            → NOT_RECEIVED
 *   - After partial POSTED receiving     → PARTIALLY_RECEIVED
 *   - After full POSTED receiving        → FULLY_RECEIVED
 *   - CLOSED_SHORT on the open remainder → CLOSED
 *   - The same PO changes fulfillment over time while PurchaseOrder.status stays
 *     CONFIRMED throughout (no stored fulfillment, G3 closed).
 */
import assert from "node:assert/strict";
import {
  InventoryUnitType,
  PurchaseOrderLineRemainingDecision,
  PurchaseOrderStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { deleteTestBusinesses } from "@/lib/testing/cleanup-test-businesses";
import { purchaseOrderService } from "@/lib/services/inventory/purchase-order.service";
import { receivingService } from "@/lib/services/inventory/receiving.service";
import { getPurchaseOrderFulfillment } from "@/lib/services/inventory/purchase-fulfillment";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function storedStatus(poId: number): Promise<PurchaseOrderStatus> {
  const po = await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: poId },
    select: { status: true },
  });
  return po.status;
}

async function receive(
  businessId: number,
  poId: number,
  poLineId: number,
  qty: number
) {
  const session = await receivingService.createReceivingSession({
    businessId,
    purchaseOrderId: poId,
    lines: [{ purchaseOrderLineId: poLineId, receivedQty: qty }],
  });
  await receivingService.postReceivingSession({
    businessId,
    receivingSessionId: session.id,
  });
}

async function main() {
  const business = await prisma.business.create({
    data: {
      name: `Phase B ${runId}`,
      users: { create: { email: `phase-b-${runId}@example.test`, password: "test-password", name: "Phase B" } },
    },
    include: { users: true },
  });
  const businessId = business.id;
  const userId = business.users[0].id;

  try {
    const item = await prisma.inventoryItem.create({
      data: { businessId, name: `Item ${runId}`, unitType: InventoryUnitType.UNIT, currentQuantity: 0, minimumQuantity: 0 },
    });

    // ===== Transition path: NOT → PARTIALLY → FULLY, no status writes =====
    const po = await purchaseOrderService.createPurchaseOrder({
      businessId,
      createdByUserId: userId,
      supplierName: "Phase B Supplier",
      status: PurchaseOrderStatus.CONFIRMED,
      lines: [{ itemId: item.id, orderedQty: 10, unitCost: 5 }],
    });
    const poLineId = po.lines[0].id;

    let f = await getPurchaseOrderFulfillment(businessId, po.id);
    assert.equal(f.status, "NOT_RECEIVED", "fresh PO → NOT_RECEIVED");
    assert.equal(f.totals.openQty, 10, "openQty = 10");
    assert.equal(await storedStatus(po.id), PurchaseOrderStatus.CONFIRMED, "status CONFIRMED");

    await receive(businessId, po.id, poLineId, 4);
    f = await getPurchaseOrderFulfillment(businessId, po.id);
    assert.equal(f.status, "PARTIALLY_RECEIVED", "after 4/10 → PARTIALLY_RECEIVED");
    assert.equal(f.totals.receivedQty, 4, "receivedQty = 4");
    assert.equal(f.totals.openQty, 6, "openQty = 6");
    assert.equal(await storedStatus(po.id), PurchaseOrderStatus.CONFIRMED, "status still CONFIRMED (no write)");

    await receive(businessId, po.id, poLineId, 6);
    f = await getPurchaseOrderFulfillment(businessId, po.id);
    assert.equal(f.status, "FULLY_RECEIVED", "after 10/10 → FULLY_RECEIVED");
    assert.equal(f.totals.openQty, 0, "openQty = 0");
    assert.equal(await storedStatus(po.id), PurchaseOrderStatus.CONFIRMED, "status STILL CONFIRMED after full receipt");

    // ===== CLOSED_SHORT on open remainder → CLOSED =====
    const po2 = await purchaseOrderService.createPurchaseOrder({
      businessId,
      createdByUserId: userId,
      supplierName: "Phase B Supplier",
      status: PurchaseOrderStatus.CONFIRMED,
      lines: [{ itemId: item.id, orderedQty: 10, unitCost: 5 }],
    });
    const po2LineId = po2.lines[0].id;

    await receive(businessId, po2.id, po2LineId, 4);
    assert.equal(
      (await getPurchaseOrderFulfillment(businessId, po2.id)).status,
      "PARTIALLY_RECEIVED",
      "po2 after 4/10 → PARTIALLY_RECEIVED"
    );

    await purchaseOrderService.setPurchaseOrderLineRemainingDecision({
      businessId,
      purchaseOrderId: po2.id,
      purchaseOrderLineId: po2LineId,
      decidedByUserId: userId,
      remainingDecision: PurchaseOrderLineRemainingDecision.CLOSED_SHORT,
      remainingDecisionQty: 6,
    });
    const f2 = await getPurchaseOrderFulfillment(businessId, po2.id);
    assert.equal(f2.status, "CLOSED", "after closing the 6 short → CLOSED");
    assert.equal(f2.totals.closedShortQty, 6, "closedShortQty = 6");
    assert.equal(f2.totals.openQty, 0, "openQty = 0");
    assert.equal(await storedStatus(po2.id), PurchaseOrderStatus.CONFIRMED, "po2 status still CONFIRMED");

    console.log("\nAll purchase-fulfillment e2e checks passed");
  } finally {
    await deleteTestBusinesses([businessId]);
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
