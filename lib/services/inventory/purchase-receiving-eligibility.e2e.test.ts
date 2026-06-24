/**
 * Purchasing Phase C — receive eligibility end-to-end (run manually, DIRECT url):
 *   DATABASE_URL=$DIRECT_URL npx tsx lib/services/inventory/purchase-receiving-eligibility.e2e.test.ts
 *
 * Proves the dormant Receiving engine is reconnected to open POs via derived
 * eligibility (openQty), NOT the dead AWAITING_DELIVERY status:
 *   - approve COMMIT_ONLY → PO (CONFIRMED) is receivable; appears in the
 *     receivable list; the existing receive engine settles it (partial → full),
 *     eligibility tracking the ledger the whole way.
 *   - approve RECEIVE_NOW → PO is NOT receivable (openQty 0).
 *   - CLOSED_SHORT (no open remainder) and CANCELLED → NOT receivable.
 */
import assert from "node:assert/strict";
import {
  InventoryUnitType,
  PurchaseOrderLineRemainingDecision,
  PurchaseOrderStatus,
  SupplierPurchaseDraftStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { deleteTestBusinesses } from "@/lib/testing/cleanup-test-businesses";
import { approveSupplierPurchase } from "@/lib/services/inventory/supplier-purchase-approval.service";
import { purchaseOrderService } from "@/lib/services/inventory/purchase-order.service";
import { receivingService } from "@/lib/services/inventory/receiving.service";
import {
  getPurchaseOrderReceiveEligibility,
  listReceivablePurchaseOrders,
} from "@/lib/services/inventory/purchase-receiving-eligibility";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function createDraft(businessId: number, sku: string, quantity: number) {
  return prisma.supplierPurchaseDraft.create({
    data: {
      businessId,
      supplierName: "Phase C Supplier",
      source: "MANUAL",
      status: SupplierPurchaseDraftStatus.PENDING_REVIEW,
      lines: { create: [{ rawName: "Item", sku, quantity }] },
    },
    include: { lines: true },
  });
}

async function poForDraft(businessId: number, draftId: number) {
  return prisma.purchaseOrder.findFirstOrThrow({
    where: { businessId, sourceSupplierPurchaseDraftId: draftId },
    include: { lines: true },
  });
}

async function receive(businessId: number, poId: number, poLineId: number, qty: number) {
  const session = await receivingService.createReceivingSession({
    businessId,
    purchaseOrderId: poId,
    lines: [{ purchaseOrderLineId: poLineId, receivedQty: qty }],
  });
  await receivingService.postReceivingSession({ businessId, receivingSessionId: session.id });
}

async function main() {
  const business = await prisma.business.create({
    data: {
      name: `Phase C ${runId}`,
      users: { create: { email: `phase-c-${runId}@example.test`, password: "test-password", name: "Phase C" } },
    },
    include: { users: true },
  });
  const businessId = business.id;
  const userId = business.users[0].id;

  try {
    const item = await prisma.inventoryItem.create({
      data: { businessId, name: `Item ${runId}`, unitType: InventoryUnitType.UNIT, currentQuantity: 0, minimumQuantity: 0 },
    });

    // ===== COMMIT_ONLY → receivable, then settled via the existing engine =====
    const draftCommit = await createDraft(businessId, "SKU-COMMIT", 10);
    await approveSupplierPurchase({
      draftId: draftCommit.id,
      businessId,
      userId,
      settlement: "COMMIT_ONLY",
      lines: [{ lineId: draftCommit.lines[0].id, action: "MERGE", itemId: item.id }],
    });
    const poCommit = await poForDraft(businessId, draftCommit.id);

    let elig = await getPurchaseOrderReceiveEligibility(businessId, poCommit.id);
    assert.equal(elig.receivable, true, "COMMIT_ONLY PO is receivable");
    assert.equal(elig.fulfillment, "NOT_RECEIVED", "COMMIT_ONLY → NOT_RECEIVED");
    assert.equal(elig.status, PurchaseOrderStatus.CONFIRMED, "receivable WITHOUT AWAITING_DELIVERY (status CONFIRMED)");

    const receivableIds = (await listReceivablePurchaseOrders(businessId)).map((r) => r.purchaseOrderId);
    assert.ok(receivableIds.includes(poCommit.id), "COMMIT_ONLY PO appears in receivable list");

    // Partial receive via the existing engine → still receivable.
    await receive(businessId, poCommit.id, poCommit.lines[0].id, 4);
    elig = await getPurchaseOrderReceiveEligibility(businessId, poCommit.id);
    assert.equal(elig.receivable, true, "after partial → still receivable");
    assert.equal(elig.fulfillment, "PARTIALLY_RECEIVED", "after partial → PARTIALLY_RECEIVED");

    // Receive the rest → no longer receivable.
    await receive(businessId, poCommit.id, poCommit.lines[0].id, 6);
    elig = await getPurchaseOrderReceiveEligibility(businessId, poCommit.id);
    assert.equal(elig.receivable, false, "after full → not receivable");
    assert.equal(elig.fulfillment, "FULLY_RECEIVED", "after full → FULLY_RECEIVED");
    const stillReceivable = (await listReceivablePurchaseOrders(businessId)).map((r) => r.purchaseOrderId);
    assert.ok(!stillReceivable.includes(poCommit.id), "fully received PO drops off receivable list");

    // Item stock reflects the two receivings (4 + 6 = 10) — engine untouched.
    const itemAfter = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    assert.equal(itemAfter.currentQuantity, 10, "stock moved only via Receiving (10)");

    // ===== RECEIVE_NOW → not receivable (openQty 0) =====
    const item2 = await prisma.inventoryItem.create({
      data: { businessId, name: `Item2 ${runId}`, unitType: InventoryUnitType.UNIT, currentQuantity: 0, minimumQuantity: 0 },
    });
    const draftNow = await createDraft(businessId, "SKU-NOW", 5);
    await approveSupplierPurchase({
      draftId: draftNow.id,
      businessId,
      userId,
      settlement: "RECEIVE_NOW",
      lines: [{ lineId: draftNow.lines[0].id, action: "MERGE", itemId: item2.id }],
    });
    const poNow = await poForDraft(businessId, draftNow.id);
    const eligNow = await getPurchaseOrderReceiveEligibility(businessId, poNow.id);
    assert.equal(eligNow.receivable, false, "RECEIVE_NOW PO is NOT receivable");
    assert.equal(eligNow.fulfillment, "FULLY_RECEIVED", "RECEIVE_NOW → FULLY_RECEIVED");

    // ===== CLOSED_SHORT → not receivable =====
    const poShort = await purchaseOrderService.createPurchaseOrder({
      businessId,
      createdByUserId: userId,
      status: PurchaseOrderStatus.CONFIRMED,
      lines: [{ itemId: item.id, orderedQty: 10, unitCost: 5 }],
    });
    await receive(businessId, poShort.id, poShort.lines[0].id, 4);
    await purchaseOrderService.setPurchaseOrderLineRemainingDecision({
      businessId,
      purchaseOrderId: poShort.id,
      purchaseOrderLineId: poShort.lines[0].id,
      decidedByUserId: userId,
      remainingDecision: PurchaseOrderLineRemainingDecision.CLOSED_SHORT,
      remainingDecisionQty: 6,
    });
    const eligShort = await getPurchaseOrderReceiveEligibility(businessId, poShort.id);
    assert.equal(eligShort.receivable, false, "CLOSED_SHORT (no open) → not receivable");
    assert.equal(eligShort.fulfillment, "CLOSED", "→ CLOSED");

    // ===== CANCELLED → not receivable (state constructed for the predicate) =====
    const poCancel = await purchaseOrderService.createPurchaseOrder({
      businessId,
      createdByUserId: userId,
      status: PurchaseOrderStatus.CONFIRMED,
      lines: [{ itemId: item.id, orderedQty: 10, unitCost: 5 }],
    });
    await prisma.purchaseOrder.update({
      where: { id: poCancel.id },
      data: { status: PurchaseOrderStatus.CANCELLED },
    });
    const eligCancel = await getPurchaseOrderReceiveEligibility(businessId, poCancel.id);
    assert.equal(eligCancel.receivable, false, "CANCELLED → not receivable even with open qty");

    console.log("\nAll purchase-receiving-eligibility e2e checks passed");
  } finally {
    await deleteTestBusinesses([businessId]);
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
