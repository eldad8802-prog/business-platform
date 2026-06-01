import assert from "node:assert/strict";
import {
  InventoryUnitType,
  PurchaseOrderLineRemainingDecision,
  PurchaseOrderStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { purchaseOrderService } from "@/lib/services/inventory/purchase-order.service";
import { receivingService } from "@/lib/services/inventory/receiving.service";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function main() {
  const business = await prisma.business.create({
    data: {
      name: `PO Phase 1 Test ${runId}`,
      users: {
        create: {
          email: `po-phase-1-${runId}@example.test`,
          password: "test-password",
          name: "PO Test User",
        },
      },
    },
    include: { users: true },
  });

  const otherBusiness = await prisma.business.create({
    data: {
      name: `PO Phase 1 Other ${runId}`,
      users: {
        create: {
          email: `po-phase-1-other-${runId}@example.test`,
          password: "test-password",
          name: "Other PO Test User",
        },
      },
    },
  });

  try {
    const item = await prisma.inventoryItem.create({
      data: {
        businessId: business.id,
        name: "Test shampoo",
        unitType: InventoryUnitType.UNIT,
        currentQuantity: 7,
        minimumQuantity: 2,
      },
    });

    const otherItem = await prisma.inventoryItem.create({
      data: {
        businessId: otherBusiness.id,
        name: "Other business item",
        unitType: InventoryUnitType.UNIT,
        currentQuantity: 3,
        minimumQuantity: 0,
      },
    });

    const movementCountBefore = await prisma.inventoryMovement.count({
      where: { businessId: business.id },
    });

    const purchaseOrder = await purchaseOrderService.createPurchaseOrder({
      businessId: business.id,
      createdByUserId: business.users[0].id,
      supplierName: " Test Supplier ",
      sourceSupplierPurchaseDraftId: 999999,
      lines: [
        {
          itemId: item.id,
          rawName: " Test shampoo ",
          orderedQty: 20,
          unitCost: 10,
        },
      ],
    });

    assert.equal(purchaseOrder.status, PurchaseOrderStatus.DRAFT);
    assert.equal(purchaseOrder.supplierName, "Test Supplier");
    assert.equal(purchaseOrder.sourceSupplierPurchaseDraftId, 999999);
    assert.equal(purchaseOrder.lines.length, 1);
    assert.equal(purchaseOrder.lines[0].orderedQty, 20);
    assert.equal(purchaseOrder.lines[0].unitCost, 10);
    assert.equal(purchaseOrder.lines[0].unitType, InventoryUnitType.UNIT);

    const itemAfterCreate = await prisma.inventoryItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    assert.equal(itemAfterCreate.currentQuantity, 7);
    assert.equal(itemAfterCreate.lastPurchaseCost, null);
    assert.equal(itemAfterCreate.lastPurchaseCostAt, null);

    const movementCountAfter = await prisma.inventoryMovement.count({
      where: { businessId: business.id },
    });
    assert.equal(movementCountAfter, movementCountBefore);

    const fetched = await purchaseOrderService.getPurchaseOrder({
      businessId: business.id,
      purchaseOrderId: purchaseOrder.id,
    });
    assert.equal(fetched.id, purchaseOrder.id);
    assert.equal(fetched.lines.length, 1);
    assert.equal(fetched.lines[0].receivedQty, 0);
    assert.equal(fetched.lines[0].closedShortQty, 0);
    assert.equal(fetched.lines[0].openQty, 20);

    const draftReceiving = await receivingService.createReceivingSession({
      businessId: business.id,
      purchaseOrderId: purchaseOrder.id,
      lines: [
        {
          purchaseOrderLineId: purchaseOrder.lines[0].id,
          receivedQty: 5,
        },
      ],
    });
    assert.equal(draftReceiving.lines[0].unitCost, 10);

    const fetchedWithDraftReceiving =
      await purchaseOrderService.getPurchaseOrder({
        businessId: business.id,
        purchaseOrderId: purchaseOrder.id,
      });
    assert.equal(fetchedWithDraftReceiving.lines[0].receivedQty, 0);
    assert.equal(fetchedWithDraftReceiving.lines[0].openQty, 20);

    const itemAfterDraftReceiving = await prisma.inventoryItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    assert.equal(itemAfterDraftReceiving.lastPurchaseCost, null);
    assert.equal(itemAfterDraftReceiving.lastPurchaseCostAt, null);

    await receivingService.postReceivingSession({
      businessId: business.id,
      receivingSessionId: draftReceiving.id,
      postedByUserId: business.users[0].id,
    });

    const fetchedWithPostedReceiving =
      await purchaseOrderService.getPurchaseOrder({
        businessId: business.id,
        purchaseOrderId: purchaseOrder.id,
      });
    assert.equal(fetchedWithPostedReceiving.lines[0].receivedQty, 5);
    assert.equal(fetchedWithPostedReceiving.lines[0].openQty, 15);

    const itemAfterPostedReceiving =
      await prisma.inventoryItem.findUniqueOrThrow({
        where: { id: item.id },
      });
    assert.equal(itemAfterPostedReceiving.lastPurchaseCost, 10);
    assert.ok(itemAfterPostedReceiving.lastPurchaseCostAt);

    const movementCountBeforeDecision = await prisma.inventoryMovement.count({
      where: { businessId: business.id },
    });
    const costAtBeforeDecision = itemAfterPostedReceiving.lastPurchaseCostAt;

    const closedShortLine =
      await purchaseOrderService.setPurchaseOrderLineRemainingDecision({
        businessId: business.id,
        purchaseOrderId: purchaseOrder.id,
        purchaseOrderLineId: purchaseOrder.lines[0].id,
        decidedByUserId: business.users[0].id,
        remainingDecision: PurchaseOrderLineRemainingDecision.CLOSED_SHORT,
        remainingDecisionQty: 4,
        remainingDecisionNote: " Supplier cannot fulfill ",
      });

    assert.equal(
      closedShortLine.remainingDecision,
      PurchaseOrderLineRemainingDecision.CLOSED_SHORT
    );
    assert.equal(closedShortLine.receivedQty, 5);
    assert.equal(closedShortLine.closedShortQty, 4);
    assert.equal(closedShortLine.openQty, 11);
    assert.equal(closedShortLine.remainingDecisionNote, "Supplier cannot fulfill");

    const movementCountAfterClosedShort = await prisma.inventoryMovement.count({
      where: { businessId: business.id },
    });
    assert.equal(movementCountAfterClosedShort, movementCountBeforeDecision);
    const itemAfterClosedShort = await prisma.inventoryItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    assert.equal(itemAfterClosedShort.lastPurchaseCost, 10);
    assert.deepEqual(itemAfterClosedShort.lastPurchaseCostAt, costAtBeforeDecision);

    const backorderLine =
      await purchaseOrderService.setPurchaseOrderLineRemainingDecision({
        businessId: business.id,
        purchaseOrderId: purchaseOrder.id,
        purchaseOrderLineId: purchaseOrder.lines[0].id,
        decidedByUserId: business.users[0].id,
        remainingDecision: PurchaseOrderLineRemainingDecision.BACKORDER,
        remainingDecisionQty: 6,
        expectedAt: "2030-01-15T00:00:00.000Z",
      });

    assert.equal(
      backorderLine.remainingDecision,
      PurchaseOrderLineRemainingDecision.BACKORDER
    );
    assert.equal(backorderLine.closedShortQty, 0);
    assert.equal(backorderLine.openQty, 15);

    const movementCountAfterBackorder = await prisma.inventoryMovement.count({
      where: { businessId: business.id },
    });
    assert.equal(movementCountAfterBackorder, movementCountBeforeDecision);
    const itemAfterBackorder = await prisma.inventoryItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    assert.equal(itemAfterBackorder.lastPurchaseCost, 10);
    assert.deepEqual(itemAfterBackorder.lastPurchaseCostAt, costAtBeforeDecision);

    const keepOpenLine =
      await purchaseOrderService.setPurchaseOrderLineRemainingDecision({
        businessId: business.id,
        purchaseOrderId: purchaseOrder.id,
        purchaseOrderLineId: purchaseOrder.lines[0].id,
        decidedByUserId: business.users[0].id,
        remainingDecision: PurchaseOrderLineRemainingDecision.KEEP_OPEN,
      });

    assert.equal(
      keepOpenLine.remainingDecision,
      PurchaseOrderLineRemainingDecision.KEEP_OPEN
    );
    assert.equal(keepOpenLine.remainingDecisionQty, null);
    assert.equal(keepOpenLine.expectedAt, null);
    assert.equal(keepOpenLine.closedShortQty, 0);
    assert.equal(keepOpenLine.openQty, 15);
    const itemAfterKeepOpen = await prisma.inventoryItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    assert.equal(itemAfterKeepOpen.lastPurchaseCost, 10);
    assert.deepEqual(itemAfterKeepOpen.lastPurchaseCostAt, costAtBeforeDecision);

    await assert.rejects(
      () =>
        purchaseOrderService.setPurchaseOrderLineRemainingDecision({
          businessId: business.id,
          purchaseOrderId: purchaseOrder.id,
          purchaseOrderLineId: purchaseOrder.lines[0].id,
          remainingDecision: PurchaseOrderLineRemainingDecision.CLOSED_SHORT,
          remainingDecisionQty: 16,
        }),
      /cannot exceed/
    );

    const zeroCostPurchaseOrder = await purchaseOrderService.createPurchaseOrder({
      businessId: business.id,
      lines: [
        {
          rawName: "Free sample",
          orderedQty: 1,
          unitCost: 0,
        },
      ],
    });
    assert.equal(zeroCostPurchaseOrder.lines[0].unitCost, 0);

    await assert.rejects(
      () =>
        purchaseOrderService.createPurchaseOrder({
          businessId: business.id,
          lines: [{ rawName: "Bad cost", orderedQty: 1, unitCost: -1 }],
        }),
      /greater than or equal to zero/
    );

    const listed = await purchaseOrderService.listPurchaseOrders({
      businessId: business.id,
      status: PurchaseOrderStatus.DRAFT,
    });
    assert.ok(listed.some((po) => po.id === purchaseOrder.id));

    await assert.rejects(
      () =>
        purchaseOrderService.getPurchaseOrder({
          businessId: otherBusiness.id,
          purchaseOrderId: purchaseOrder.id,
        }),
      /Purchase order not found/
    );

    await assert.rejects(
      () =>
        purchaseOrderService.createPurchaseOrder({
          businessId: business.id,
          lines: [],
        }),
      /at least one line/
    );

    await assert.rejects(
      () =>
        purchaseOrderService.createPurchaseOrder({
          businessId: business.id,
          lines: [{ rawName: "Bad qty", orderedQty: 0 }],
        }),
      /greater than zero/
    );

    await assert.rejects(
      () =>
        purchaseOrderService.createPurchaseOrder({
          businessId: business.id,
          lines: [{ orderedQty: 1 }],
        }),
      /must identify an item/
    );

    await assert.rejects(
      () =>
        purchaseOrderService.createPurchaseOrder({
          businessId: business.id,
          lines: [{ itemId: otherItem.id, orderedQty: 1 }],
        }),
      /Inventory item not found/
    );

    console.log("purchase-order.service.test.ts: ok");
  } finally {
    await prisma.receivingLine.deleteMany({
      where: {
        receivingSession: {
          businessId: { in: [business.id, otherBusiness.id] },
        },
      },
    });
    await prisma.business.deleteMany({
      where: {
        id: { in: [business.id, otherBusiness.id] },
      },
    });
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
