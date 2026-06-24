/**
 * Purchasing Phase D — share event end-to-end (run manually, DIRECT url):
 *   DATABASE_URL=$DIRECT_URL npx tsx lib/services/inventory/purchase-order-shared.e2e.test.ts
 *
 * Proves Status Honesty: "shared/sent to supplier" is recorded as an EVENT
 * (sharedAt) with NO status write, fulfillment stays derived, and CANCELLED stays
 * a real stored status that blocks both sharing and receiving.
 */
import assert from "node:assert/strict";
import {
  InventoryUnitType,
  PurchaseOrderStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { deleteTestBusinesses } from "@/lib/testing/cleanup-test-businesses";
import { purchaseOrderService } from "@/lib/services/inventory/purchase-order.service";
import { receivingService } from "@/lib/services/inventory/receiving.service";
import { getPurchaseOrderFulfillment } from "@/lib/services/inventory/purchase-fulfillment";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function main() {
  const business = await prisma.business.create({
    data: {
      name: `Phase D ${runId}`,
      users: { create: { email: `phase-d-${runId}@example.test`, password: "test-password", name: "Phase D" } },
    },
    include: { users: true },
  });
  const businessId = business.id;
  const userId = business.users[0].id;

  try {
    const item = await prisma.inventoryItem.create({
      data: { businessId, name: `Item ${runId}`, unitType: InventoryUnitType.UNIT, currentQuantity: 0, minimumQuantity: 0 },
    });

    const po = await purchaseOrderService.createPurchaseOrder({
      businessId,
      createdByUserId: userId,
      status: PurchaseOrderStatus.CONFIRMED,
      lines: [{ itemId: item.id, orderedQty: 10, unitCost: 5 }],
    });

    // Fresh PO: not shared, status CONFIRMED, fulfillment NOT_RECEIVED.
    const before = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    assert.equal(before.sharedAt, null, "fresh PO has no sharedAt");
    assert.equal(before.status, PurchaseOrderStatus.CONFIRMED, "status CONFIRMED");

    // ===== Mark shared → sharedAt set, status UNCHANGED =====
    const t1 = new Date("2026-06-24T09:00:00.000Z");
    await purchaseOrderService.markPurchaseOrderShared({ businessId, purchaseOrderId: po.id, sharedAt: t1 });
    const shared1 = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    assert.ok(shared1.sharedAt, "sharedAt is set after marking shared");
    assert.equal(shared1.sharedAt?.toISOString(), t1.toISOString(), "sharedAt = t1");
    assert.equal(shared1.status, PurchaseOrderStatus.CONFIRMED, "status STILL CONFIRMED (no status write)");

    // Shared PO with no receiving remains NOT_RECEIVED (fulfillment derived).
    const f = await getPurchaseOrderFulfillment(businessId, po.id);
    assert.equal(f.status, "NOT_RECEIVED", "shared but unreceived → NOT_RECEIVED (derived)");

    // ===== Re-share refreshes the event timestamp =====
    const t2 = new Date("2026-06-25T11:30:00.000Z");
    await purchaseOrderService.markPurchaseOrderShared({ businessId, purchaseOrderId: po.id, sharedAt: t2 });
    const shared2 = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    assert.equal(shared2.sharedAt?.toISOString(), t2.toISOString(), "re-share updates sharedAt to t2");
    assert.equal(shared2.status, PurchaseOrderStatus.CONFIRMED, "still CONFIRMED after re-share");

    // No ghost status was ever written.
    assert.notEqual(shared2.status, "SENT");
    assert.notEqual(shared2.status, "AWAITING_DELIVERY");
    assert.notEqual(shared2.status, "CLOSED");

    // ===== CANCELLED is a real stored status: blocks share AND receiving =====
    const poCancel = await purchaseOrderService.createPurchaseOrder({
      businessId,
      createdByUserId: userId,
      status: PurchaseOrderStatus.CONFIRMED,
      lines: [{ itemId: item.id, orderedQty: 5, unitCost: 5 }],
    });
    await prisma.purchaseOrder.update({
      where: { id: poCancel.id },
      data: { status: PurchaseOrderStatus.CANCELLED },
    });

    await assert.rejects(
      () => purchaseOrderService.markPurchaseOrderShared({ businessId, purchaseOrderId: poCancel.id }),
      /cancelled/i,
      "cannot share a cancelled PO"
    );
    await assert.rejects(
      () =>
        receivingService.createReceivingSession({
          businessId,
          purchaseOrderId: poCancel.id,
          lines: [{ purchaseOrderLineId: poCancel.lines[0].id, receivedQty: 1 }],
        }),
      /cancelled/i,
      "cannot receive against a cancelled PO"
    );

    console.log("\nAll purchase-order-shared e2e checks passed");
  } finally {
    await deleteTestBusinesses([businessId]);
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
