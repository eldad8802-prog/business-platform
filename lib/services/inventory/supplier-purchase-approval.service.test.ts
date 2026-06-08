import assert from "node:assert/strict";
import {
  InventoryMovementReason,
  InventoryUnitType,
  PurchaseOrderStatus,
  ReceivingSessionStatus,
  SupplierPurchaseDraftStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { deleteTestBusinesses } from "@/lib/testing/cleanup-test-businesses";
import { approveSupplierPurchase } from "@/lib/services/inventory/supplier-purchase-approval.service";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function createDraft(
  businessId: number,
  lines: Array<{ rawName: string; quantity: number }>
) {
  return prisma.supplierPurchaseDraft.create({
    data: {
      businessId,
      supplierName: "Option C Supplier",
      source: "MANUAL",
      status: SupplierPurchaseDraftStatus.PENDING_REVIEW,
      lines: {
        create: lines.map((line) => ({
          rawName: line.rawName,
          quantity: line.quantity,
        })),
      },
    },
    include: { lines: true },
  });
}

async function main() {
  const business = await prisma.business.create({
    data: {
      name: `Option C Approval Test ${runId}`,
      users: {
        create: {
          email: `option-c-${runId}@example.test`,
          password: "test-password",
          name: "Option C Test User",
        },
      },
    },
    include: { users: true },
  });

  const userId = business.users[0].id;
  const businessId = business.id;

  try {
    // ===== 1. MERGE → PO + POSTED Receiving + exactly one movement =====
    const mergeItem = await prisma.inventoryItem.create({
      data: {
        businessId,
        name: "Merge target item",
        unitType: InventoryUnitType.UNIT,
        currentQuantity: 5,
        minimumQuantity: 0,
      },
    });

    const mergeDraft = await createDraft(businessId, [
      { rawName: "Merge line", quantity: 8 },
    ]);

    const movementsBeforeMerge = await prisma.inventoryMovement.count({
      where: { businessId },
    });

    await approveSupplierPurchase({
      draftId: mergeDraft.id,
      businessId,
      userId,
      lines: [
        { lineId: mergeDraft.lines[0].id, action: "MERGE", itemId: mergeItem.id },
      ],
    });

    const mergeItemAfter = await prisma.inventoryItem.findUniqueOrThrow({
      where: { id: mergeItem.id },
    });
    assert.equal(mergeItemAfter.currentQuantity, 13, "MERGE should add 8 → 13");

    const movementsAfterMerge = await prisma.inventoryMovement.count({
      where: { businessId },
    });
    assert.equal(
      movementsAfterMerge,
      movementsBeforeMerge + 1,
      "MERGE must create exactly one movement"
    );

    const mergeMovement = await prisma.inventoryMovement.findFirstOrThrow({
      where: { businessId, itemId: mergeItem.id },
      orderBy: { id: "desc" },
    });
    assert.equal(
      mergeMovement.reason,
      InventoryMovementReason.SUPPLIER_PURCHASE,
      "movement reason must be SUPPLIER_PURCHASE"
    );

    // PO created with traceability + POSTED receiving session.
    const mergePo = await prisma.purchaseOrder.findFirstOrThrow({
      where: { businessId, sourceSupplierPurchaseDraftId: mergeDraft.id },
      include: { lines: true, receivingSessions: true },
    });
    assert.equal(mergePo.lines.length, 1);
    assert.equal(mergePo.lines[0].itemId, mergeItem.id);
    assert.equal(mergePo.lines[0].orderedQty, 8);
    assert.equal(mergePo.receivingSessions.length, 1);
    assert.equal(
      mergePo.receivingSessions[0].status,
      ReceivingSessionStatus.POSTED,
      "receiving session must be POSTED"
    );

    const mergeDraftAfter = await prisma.supplierPurchaseDraft.findUniqueOrThrow({
      where: { id: mergeDraft.id },
    });
    assert.equal(mergeDraftAfter.status, SupplierPurchaseDraftStatus.APPROVED);
    assert.ok(mergeDraftAfter.approvedAt);

    // ===== 2. CREATE_NEW → item created with 0 stock, no INITIAL_STOCK =====
    const createDraftRecord = await createDraft(businessId, [
      { rawName: "Brand new item", quantity: 6 },
    ]);

    const initialStockBefore = await prisma.inventoryMovement.count({
      where: { businessId, reason: InventoryMovementReason.INITIAL_STOCK },
    });

    await approveSupplierPurchase({
      draftId: createDraftRecord.id,
      businessId,
      userId,
      lines: [
        {
          lineId: createDraftRecord.lines[0].id,
          action: "CREATE_NEW",
          itemData: { name: "Brand new item", unitType: "UNIT" },
        },
      ],
    });

    const createdLine = await prisma.supplierPurchaseDraftLine.findUniqueOrThrow({
      where: { id: createDraftRecord.lines[0].id },
    });
    assert.ok(createdLine.matchedItemId, "CREATE_NEW must link a created item");

    const createdItem = await prisma.inventoryItem.findUniqueOrThrow({
      where: { id: createdLine.matchedItemId! },
    });
    assert.equal(
      createdItem.currentQuantity,
      6,
      "CREATE_NEW quantity must enter only via receiving"
    );

    const initialStockAfter = await prisma.inventoryMovement.count({
      where: { businessId, reason: InventoryMovementReason.INITIAL_STOCK },
    });
    assert.equal(
      initialStockAfter,
      initialStockBefore,
      "CREATE_NEW must NOT create an INITIAL_STOCK movement"
    );

    const createdItemMovements = await prisma.inventoryMovement.findMany({
      where: { businessId, itemId: createdItem.id },
    });
    assert.equal(createdItemMovements.length, 1, "exactly one movement");
    assert.equal(
      createdItemMovements[0].reason,
      InventoryMovementReason.SUPPLIER_PURCHASE
    );

    const createPo = await prisma.purchaseOrder.findFirstOrThrow({
      where: { businessId, sourceSupplierPurchaseDraftId: createDraftRecord.id },
      include: { receivingSessions: true },
    });
    assert.equal(createPo.status, PurchaseOrderStatus.CONFIRMED);
    assert.equal(
      createPo.receivingSessions[0].status,
      ReceivingSessionStatus.POSTED
    );

    // ===== 3. REVIEW / unknown action → throw, no side effects =====
    const reviewDraft = await createDraft(businessId, [
      { rawName: "Review line", quantity: 4 },
    ]);
    const movementsBeforeReview = await prisma.inventoryMovement.count({
      where: { businessId },
    });

    await assert.rejects(
      () =>
        approveSupplierPurchase({
          draftId: reviewDraft.id,
          businessId,
          userId,
          lines: [
            // intentionally invalid action
            { lineId: reviewDraft.lines[0].id, action: "REVIEW" as any },
          ],
        }),
      /action|decision|resolve|REVIEW/i,
      "unknown action must throw"
    );

    const reviewDraftAfter = await prisma.supplierPurchaseDraft.findUniqueOrThrow({
      where: { id: reviewDraft.id },
    });
    assert.equal(
      reviewDraftAfter.status,
      SupplierPurchaseDraftStatus.PENDING_REVIEW,
      "draft must remain PENDING_REVIEW"
    );
    assert.equal(
      await prisma.purchaseOrder.count({
        where: { businessId, sourceSupplierPurchaseDraftId: reviewDraft.id },
      }),
      0,
      "no PO for rejected action"
    );
    assert.equal(
      await prisma.inventoryMovement.count({ where: { businessId } }),
      movementsBeforeReview,
      "no movement for rejected action"
    );

    // ===== 4. MERGE into inactive item → throw + rollback =====
    const inactiveItem = await prisma.inventoryItem.create({
      data: {
        businessId,
        name: "Inactive item",
        unitType: InventoryUnitType.UNIT,
        currentQuantity: 0,
        minimumQuantity: 0,
        isActive: false,
      },
    });
    const inactiveDraft = await createDraft(businessId, [
      { rawName: "Inactive merge", quantity: 2 },
    ]);

    await assert.rejects(
      () =>
        approveSupplierPurchase({
          draftId: inactiveDraft.id,
          businessId,
          userId,
          lines: [
            {
              lineId: inactiveDraft.lines[0].id,
              action: "MERGE",
              itemId: inactiveItem.id,
            },
          ],
        }),
      /not found|inactive|available/i,
      "MERGE into inactive item must throw"
    );

    const inactiveDraftAfter = await prisma.supplierPurchaseDraft.findUniqueOrThrow(
      { where: { id: inactiveDraft.id } }
    );
    assert.equal(
      inactiveDraftAfter.status,
      SupplierPurchaseDraftStatus.PENDING_REVIEW
    );
    const inactiveItemAfter = await prisma.inventoryItem.findUniqueOrThrow({
      where: { id: inactiveItem.id },
    });
    assert.equal(inactiveItemAfter.currentQuantity, 0, "no stock written");

    // ===== 5. Double approval → second fails, no duplicates =====
    const doubleItem = await prisma.inventoryItem.create({
      data: {
        businessId,
        name: "Double approve item",
        unitType: InventoryUnitType.UNIT,
        currentQuantity: 0,
        minimumQuantity: 0,
      },
    });
    const doubleDraft = await createDraft(businessId, [
      { rawName: "Double line", quantity: 3 },
    ]);

    await approveSupplierPurchase({
      draftId: doubleDraft.id,
      businessId,
      userId,
      lines: [
        { lineId: doubleDraft.lines[0].id, action: "MERGE", itemId: doubleItem.id },
      ],
    });

    await assert.rejects(
      () =>
        approveSupplierPurchase({
          draftId: doubleDraft.id,
          businessId,
          userId,
          lines: [
            {
              lineId: doubleDraft.lines[0].id,
              action: "MERGE",
              itemId: doubleItem.id,
            },
          ],
        }),
      /already processed/i,
      "second approval must fail"
    );

    assert.equal(
      await prisma.purchaseOrder.count({
        where: { businessId, sourceSupplierPurchaseDraftId: doubleDraft.id },
      }),
      1,
      "no duplicate PO"
    );
    const doubleItemAfter = await prisma.inventoryItem.findUniqueOrThrow({
      where: { id: doubleItem.id },
    });
    assert.equal(doubleItemAfter.currentQuantity, 3, "no duplicate stock");
    assert.equal(
      await prisma.inventoryMovement.count({
        where: { businessId, itemId: doubleItem.id },
      }),
      1,
      "no duplicate movement"
    );

    console.log("supplier-purchase-approval.service.test.ts: ok");
  } finally {
    await deleteTestBusinesses([businessId]);
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
