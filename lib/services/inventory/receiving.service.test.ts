import assert from "node:assert/strict";
import {
  InventoryMovementReason,
  InventoryUnitType,
  PurchaseOrderLineRemainingDecision,
  PurchaseOrderStatus,
  ReceivingSessionStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { deleteTestBusinesses } from "@/lib/testing/cleanup-test-businesses";
import { purchaseOrderService } from "@/lib/services/inventory/purchase-order.service";
import { receivingService } from "@/lib/services/inventory/receiving.service";
import { approveSupplierPurchase } from "@/lib/services/inventory/supplier-purchase-approval.service";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function main() {
  const business = await prisma.business.create({
    data: {
      name: `Receiving Phase 2 Test ${runId}`,
      users: {
        create: {
          email: `receiving-phase-2-${runId}@example.test`,
          password: "test-password",
          name: "Receiving Test User",
        },
      },
    },
    include: { users: true },
  });

  const otherBusiness = await prisma.business.create({
    data: {
      name: `Receiving Phase 2 Other ${runId}`,
      users: {
        create: {
          email: `receiving-phase-2-other-${runId}@example.test`,
          password: "test-password",
          name: "Other Receiving Test User",
        },
      },
    },
    include: { users: true },
  });

  try {
    const item = await prisma.inventoryItem.create({
      data: {
        businessId: business.id,
        name: "Receiving shampoo",
        unitType: InventoryUnitType.UNIT,
        currentQuantity: 7,
        minimumQuantity: 2,
      },
    });

    const purchaseOrder = await purchaseOrderService.createPurchaseOrder({
      businessId: business.id,
      createdByUserId: business.users[0].id,
      supplierName: "Receiving Supplier",
      status: PurchaseOrderStatus.CONFIRMED,
      lines: [
        {
          itemId: item.id,
          orderedQty: 20,
        },
      ],
    });
    const purchaseOrderLine = purchaseOrder.lines[0];

    const itemAfterPurchaseOrder = await prisma.inventoryItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    assert.equal(itemAfterPurchaseOrder.currentQuantity, 7);
    assert.equal(itemAfterPurchaseOrder.lastPurchaseCost, null);
    assert.equal(itemAfterPurchaseOrder.lastPurchaseCostAt, null);

    const movementCountBeforeDraft = await prisma.inventoryMovement.count({
      where: { businessId: business.id },
    });

    const draftSession = await receivingService.createReceivingSession({
      businessId: business.id,
      purchaseOrderId: purchaseOrder.id,
      createdByUserId: business.users[0].id,
      note: " First delivery ",
      lines: [
        {
          purchaseOrderLineId: purchaseOrderLine.id,
          receivedQty: 14,
        },
      ],
    });

    assert.equal(draftSession.status, ReceivingSessionStatus.DRAFT);
    assert.equal(draftSession.note, "First delivery");
    assert.equal(draftSession.lines.length, 1);
    assert.equal(draftSession.lines[0].itemId, item.id);
    assert.equal(draftSession.lines[0].receivedQty, 14);
    assert.equal(draftSession.lines[0].unitCost, null);

    const itemAfterDraft = await prisma.inventoryItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    assert.equal(itemAfterDraft.currentQuantity, 7);
    assert.equal(itemAfterDraft.lastPurchaseCost, null);
    assert.equal(itemAfterDraft.lastPurchaseCostAt, null);

    const movementCountAfterDraft = await prisma.inventoryMovement.count({
      where: { businessId: business.id },
    });
    assert.equal(movementCountAfterDraft, movementCountBeforeDraft);

    const fetchedDraft = await receivingService.getReceivingSession({
      businessId: business.id,
      receivingSessionId: draftSession.id,
    });
    assert.equal(fetchedDraft.id, draftSession.id);
    assert.equal(fetchedDraft.lines.length, 1);

    const listedDrafts = await receivingService.listReceivingSessions({
      businessId: business.id,
      purchaseOrderId: purchaseOrder.id,
    });
    assert.ok(listedDrafts.some((session) => session.id === draftSession.id));

    const posted = await receivingService.postReceivingSession({
      businessId: business.id,
      receivingSessionId: draftSession.id,
      postedByUserId: business.users[0].id,
    });
    assert.equal(
      posted.receivingSession.status,
      ReceivingSessionStatus.POSTED
    );
    assert.equal(posted.movements.length, 1);
    assert.equal(posted.movements[0].itemId, item.id);
    assert.equal(posted.movements[0].receivedQty, 14);

    const movementAfterPost = await prisma.inventoryMovement.findUniqueOrThrow({
      where: { id: posted.movements[0].movementId },
    });
    assert.equal(movementAfterPost.reason, InventoryMovementReason.SUPPLIER_PURCHASE);
    assert.equal(movementAfterPost.quantityDelta, 14);

    const itemAfterPost = await prisma.inventoryItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    assert.equal(itemAfterPost.currentQuantity, 21);
    assert.equal(itemAfterPost.lastPurchaseCost, null);
    assert.equal(itemAfterPost.lastPurchaseCostAt, null);

    await assert.rejects(
      () =>
        receivingService.postReceivingSession({
          businessId: business.id,
          receivingSessionId: draftSession.id,
          postedByUserId: business.users[0].id,
        }),
      /already posted/
    );

    await assert.rejects(
      () =>
        receivingService.createReceivingSession({
          businessId: business.id,
          purchaseOrderId: purchaseOrder.id,
          lines: [
            {
              purchaseOrderLineId: purchaseOrderLine.id,
              receivedQty: 7,
            },
          ],
        }),
      /exceeds open quantity/
    );

    const movementCountBeforeClosedShort =
      await prisma.inventoryMovement.count({
        where: { businessId: business.id },
      });

    const closedShortLine =
      await purchaseOrderService.setPurchaseOrderLineRemainingDecision({
        businessId: business.id,
        purchaseOrderId: purchaseOrder.id,
        purchaseOrderLineId: purchaseOrderLine.id,
        decidedByUserId: business.users[0].id,
        remainingDecision: PurchaseOrderLineRemainingDecision.CLOSED_SHORT,
        remainingDecisionQty: 4,
      });

    assert.equal(closedShortLine.receivedQty, 14);
    assert.equal(closedShortLine.closedShortQty, 4);
    assert.equal(closedShortLine.openQty, 2);

    const movementCountAfterClosedShort = await prisma.inventoryMovement.count({
      where: { businessId: business.id },
    });
    assert.equal(movementCountAfterClosedShort, movementCountBeforeClosedShort);

    await assert.rejects(
      () =>
        receivingService.createReceivingSession({
          businessId: business.id,
          purchaseOrderId: purchaseOrder.id,
          lines: [
            {
              purchaseOrderLineId: purchaseOrderLine.id,
              receivedQty: 3,
            },
          ],
        }),
      /exceeds open quantity/
    );

    const allowedAfterClosedShort =
      await receivingService.createReceivingSession({
        businessId: business.id,
        purchaseOrderId: purchaseOrder.id,
        lines: [
          {
            purchaseOrderLineId: purchaseOrderLine.id,
            receivedQty: 2,
          },
        ],
      });
    assert.equal(allowedAfterClosedShort.lines[0].receivedQty, 2);

    const costItem = await prisma.inventoryItem.create({
      data: {
        businessId: business.id,
        name: "Cost tracked conditioner",
        unitType: InventoryUnitType.UNIT,
        currentQuantity: 0,
        minimumQuantity: 0,
        costPerUnit: 8,
      },
    });
    const costPurchaseOrder = await purchaseOrderService.createPurchaseOrder({
      businessId: business.id,
      lines: [
        {
          itemId: costItem.id,
          orderedQty: 10,
          unitCost: 11,
        },
      ],
    });

    const costItemAfterPurchaseOrder =
      await prisma.inventoryItem.findUniqueOrThrow({
        where: { id: costItem.id },
      });
    assert.equal(costItemAfterPurchaseOrder.costPerUnit, 8);
    assert.equal(costItemAfterPurchaseOrder.lastPurchaseCost, null);
    assert.equal(costItemAfterPurchaseOrder.lastPurchaseCostAt, null);

    const costDraftSession = await receivingService.createReceivingSession({
      businessId: business.id,
      purchaseOrderId: costPurchaseOrder.id,
      lines: [
        {
          purchaseOrderLineId: costPurchaseOrder.lines[0].id,
          receivedQty: 4,
        },
      ],
    });
    assert.equal(costDraftSession.lines[0].unitCost, 11);

    const costItemAfterDraft = await prisma.inventoryItem.findUniqueOrThrow({
      where: { id: costItem.id },
    });
    assert.equal(costItemAfterDraft.currentQuantity, 0);
    assert.equal(costItemAfterDraft.lastPurchaseCost, null);
    assert.equal(costItemAfterDraft.lastPurchaseCostAt, null);

    const postedCostSession = await receivingService.postReceivingSession({
      businessId: business.id,
      receivingSessionId: costDraftSession.id,
      postedByUserId: business.users[0].id,
    });
    assert.equal(postedCostSession.movements.length, 1);

    const costItemAfterPosted = await prisma.inventoryItem.findUniqueOrThrow({
      where: { id: costItem.id },
    });
    assert.equal(costItemAfterPosted.currentQuantity, 4);
    assert.equal(costItemAfterPosted.costPerUnit, 8);
    assert.equal(costItemAfterPosted.lastPurchaseCost, 11);
    assert.ok(costItemAfterPosted.lastPurchaseCostAt);
    const firstCostAt = costItemAfterPosted.lastPurchaseCostAt;

    const laterCostPurchaseOrder = await purchaseOrderService.createPurchaseOrder({
      businessId: business.id,
      lines: [
        {
          itemId: costItem.id,
          orderedQty: 4,
          unitCost: 12,
        },
      ],
    });
    const laterCostSession = await receivingService.createReceivingSession({
      businessId: business.id,
      purchaseOrderId: laterCostPurchaseOrder.id,
      lines: [
        {
          purchaseOrderLineId: laterCostPurchaseOrder.lines[0].id,
          receivedQty: 1,
          unitCost: 12,
        },
      ],
    });
    await receivingService.postReceivingSession({
      businessId: business.id,
      receivingSessionId: laterCostSession.id,
      postedByUserId: business.users[0].id,
    });

    const costItemAfterLaterPosted =
      await prisma.inventoryItem.findUniqueOrThrow({
        where: { id: costItem.id },
      });
    assert.equal(costItemAfterLaterPosted.lastPurchaseCost, 12);
    assert.ok(costItemAfterLaterPosted.lastPurchaseCostAt);
    assert.ok(
      costItemAfterLaterPosted.lastPurchaseCostAt.getTime() >=
        firstCostAt.getTime()
    );

    const nullCostPurchaseOrder = await purchaseOrderService.createPurchaseOrder({
      businessId: business.id,
      lines: [
        {
          itemId: costItem.id,
          orderedQty: 2,
        },
      ],
    });
    const nullCostSession = await receivingService.createReceivingSession({
      businessId: business.id,
      purchaseOrderId: nullCostPurchaseOrder.id,
      lines: [
        {
          purchaseOrderLineId: nullCostPurchaseOrder.lines[0].id,
          receivedQty: 1,
        },
      ],
    });
    assert.equal(nullCostSession.lines[0].unitCost, null);
    await receivingService.postReceivingSession({
      businessId: business.id,
      receivingSessionId: nullCostSession.id,
      postedByUserId: business.users[0].id,
    });

    const costItemAfterNullCostPost =
      await prisma.inventoryItem.findUniqueOrThrow({
        where: { id: costItem.id },
      });
    assert.equal(costItemAfterNullCostPost.lastPurchaseCost, 12);
    assert.deepEqual(
      costItemAfterNullCostPost.lastPurchaseCostAt,
      costItemAfterLaterPosted.lastPurchaseCostAt
    );

    await assert.rejects(
      () =>
        receivingService.createReceivingSession({
          businessId: business.id,
          purchaseOrderId: costPurchaseOrder.id,
          lines: [
            {
              purchaseOrderLineId: costPurchaseOrder.lines[0].id,
              receivedQty: 1,
              unitCost: -1,
            },
          ],
        }),
      /greater than or equal to zero/
    );

    const rawPurchaseOrder = await purchaseOrderService.createPurchaseOrder({
      businessId: business.id,
      lines: [
        {
          rawName: "Unmatched gloves",
          orderedQty: 3,
        },
      ],
    });

    await assert.rejects(
      () =>
        receivingService.createReceivingSession({
          businessId: business.id,
          purchaseOrderId: rawPurchaseOrder.id,
          lines: [
            {
              purchaseOrderLineId: rawPurchaseOrder.lines[0].id,
              receivedQty: 1,
            },
          ],
        }),
      /not linked to an inventory item/
    );

    const otherItem = await prisma.inventoryItem.create({
      data: {
        businessId: otherBusiness.id,
        name: "Other business receiving item",
        unitType: InventoryUnitType.UNIT,
        currentQuantity: 0,
        minimumQuantity: 0,
      },
    });
    const otherPurchaseOrder = await purchaseOrderService.createPurchaseOrder({
      businessId: otherBusiness.id,
      lines: [
        {
          itemId: otherItem.id,
          orderedQty: 2,
        },
      ],
    });

    await assert.rejects(
      () =>
        receivingService.createReceivingSession({
          businessId: business.id,
          purchaseOrderId: purchaseOrder.id,
          lines: [
            {
              purchaseOrderLineId: otherPurchaseOrder.lines[0].id,
              receivedQty: 1,
            },
          ],
        }),
      /belong to the purchase order/
    );

    const supplierDraft = await prisma.supplierPurchaseDraft.create({
      data: {
        businessId: business.id,
        supplierName: "Legacy Supplier",
        lines: {
          create: [
            {
              rawName: "Legacy receiving item",
              quantity: 3,
            },
          ],
        },
      },
      include: { lines: true },
    });

    const movementCountBeforeLegacy = await prisma.inventoryMovement.count({
      where: { businessId: business.id },
    });

    await approveSupplierPurchase({
      draftId: supplierDraft.id,
      businessId: business.id,
      userId: business.users[0].id,
      lines: [
        {
          lineId: supplierDraft.lines[0].id,
          action: "MERGE",
          itemId: item.id,
        },
      ],
    });

    const itemAfterLegacyApproval = await prisma.inventoryItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    assert.equal(itemAfterLegacyApproval.currentQuantity, 24);

    const movementCountAfterLegacy = await prisma.inventoryMovement.count({
      where: { businessId: business.id },
    });
    assert.equal(movementCountAfterLegacy, movementCountBeforeLegacy + 1);

    console.log("receiving.service.test.ts: ok");
  } finally {
    await deleteTestBusinesses([business.id, otherBusiness.id]);
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
