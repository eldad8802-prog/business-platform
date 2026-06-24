/**
 * Purchasing Lifecycle Alignment — Phase A end-to-end (run manually, DIRECT url):
 *   DATABASE_URL=$DIRECT_URL npx tsx lib/services/inventory/supplier-purchase-commit-only.e2e.test.ts
 *
 * Proves the Commitment↔Settlement boundary added to approveSupplierPurchase:
 *   - COMMIT_ONLY  → Purchase Order commitment ONLY: no ReceivingSession, no
 *     InventoryMovement, no stock change. Identity (Phase 2) + Measure snapshots
 *     (Phase 3) still persist.
 *   - RECEIVE_NOW (explicit) and default (no mode) → identical historical behavior:
 *     PO + POSTED ReceivingSession + one InventoryMovement + stock updated.
 *   - Inventory still changes ONLY via postReceivingSession.
 */
import assert from "node:assert/strict";
import {
  InventoryMovementReason,
  InventoryUnitType,
  PartyClaimStatus,
  PurchaseOrderStatus,
  ReceivingSessionStatus,
  SupplierPurchaseDraftStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { deleteTestBusinesses } from "@/lib/testing/cleanup-test-businesses";
import { approveSupplierPurchase } from "@/lib/services/inventory/supplier-purchase-approval.service";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const SUPPLIER = "Phase A Supplier";

async function createDraft(
  businessId: number,
  line: { rawName: string; sku?: string; quantity: number }
) {
  return prisma.supplierPurchaseDraft.create({
    data: {
      businessId,
      supplierName: SUPPLIER,
      source: "MANUAL",
      status: SupplierPurchaseDraftStatus.PENDING_REVIEW,
      lines: {
        create: [
          { rawName: line.rawName, sku: line.sku ?? null, quantity: line.quantity },
        ],
      },
    },
    include: { lines: true },
  });
}

async function main() {
  const business = await prisma.business.create({
    data: {
      name: `Phase A ${runId}`,
      users: {
        create: { email: `phase-a-${runId}@example.test`, password: "test-password", name: "Phase A" },
      },
    },
    include: { users: true },
  });
  const businessId = business.id;
  const userId = business.users[0].id;

  try {
    // ===== 1. COMMIT_ONLY → PO only, zero settlement =====
    const itemA = await prisma.inventoryItem.create({
      data: { businessId, name: `Item A ${runId}`, unitType: InventoryUnitType.UNIT, currentQuantity: 5, minimumQuantity: 0 },
    });
    const draftA = await createDraft(businessId, { rawName: "Cola", sku: "SKU-A", quantity: 8 });

    const movementsBefore = await prisma.inventoryMovement.count({ where: { businessId } });

    await approveSupplierPurchase({
      draftId: draftA.id,
      businessId,
      userId,
      settlement: "COMMIT_ONLY",
      lines: [{ lineId: draftA.lines[0].id, action: "MERGE", itemId: itemA.id }],
    });

    // PO created (commitment) — but NO receiving, NO movement, NO stock change.
    const poA = await prisma.purchaseOrder.findFirstOrThrow({
      where: { businessId, sourceSupplierPurchaseDraftId: draftA.id },
      include: { lines: true, receivingSessions: true },
    });
    assert.equal(poA.status, PurchaseOrderStatus.CONFIRMED, "COMMIT_ONLY: PO is CONFIRMED");
    assert.equal(poA.lines.length, 1, "COMMIT_ONLY: PO line created");
    assert.equal(poA.receivingSessions.length, 0, "COMMIT_ONLY: NO ReceivingSession");

    const movementsAfterCommitOnly = await prisma.inventoryMovement.count({ where: { businessId } });
    assert.equal(movementsAfterCommitOnly, movementsBefore, "COMMIT_ONLY: zero InventoryMovements");

    const itemAAfter = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: itemA.id } });
    assert.equal(itemAAfter.currentQuantity, 5, "COMMIT_ONLY: stock unchanged");

    // Phase 2 — identity learning still ran in COMMIT_ONLY.
    const supplierProductA = await prisma.supplierProduct.findFirstOrThrow({
      where: { businessId, externalSku: "SKU-A" },
    });
    const mappingA = await prisma.representationMapping.findFirstOrThrow({
      where: { businessId, supplierProductId: supplierProductA.id, status: PartyClaimStatus.ACTIVE },
    });
    assert.equal(mappingA.inventoryItemId, itemA.id, "COMMIT_ONLY: identity mapping learned");

    // Phase 3 — Measure snapshot persisted on the PO line (1:1 default factor).
    assert.equal(poA.lines[0].purchaseQty, 8, "COMMIT_ONLY: purchaseQty snapshot on PO");
    assert.equal(poA.lines[0].conversionFactor, 1, "COMMIT_ONLY: default 1:1 factor snapshot on PO");
    assert.equal(poA.lines[0].orderedQty, 8, "COMMIT_ONLY: orderedQty in stock units");

    // ===== 2. RECEIVE_NOW (explicit) → PO + POSTED receiving + movement =====
    const itemB = await prisma.inventoryItem.create({
      data: { businessId, name: `Item B ${runId}`, unitType: InventoryUnitType.UNIT, currentQuantity: 0, minimumQuantity: 0 },
    });
    const draftB = await createDraft(businessId, { rawName: "Water", sku: "SKU-B", quantity: 10 });

    await approveSupplierPurchase({
      draftId: draftB.id,
      businessId,
      userId,
      settlement: "RECEIVE_NOW",
      lines: [{ lineId: draftB.lines[0].id, action: "MERGE", itemId: itemB.id }],
    });

    const poB = await prisma.purchaseOrder.findFirstOrThrow({
      where: { businessId, sourceSupplierPurchaseDraftId: draftB.id },
      include: { receivingSessions: true },
    });
    assert.equal(poB.receivingSessions.length, 1, "RECEIVE_NOW: one ReceivingSession");
    assert.equal(poB.receivingSessions[0].status, ReceivingSessionStatus.POSTED, "RECEIVE_NOW: POSTED");

    const itemBAfter = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: itemB.id } });
    assert.equal(itemBAfter.currentQuantity, 10, "RECEIVE_NOW: stock +10");

    // Invariant: the movement originated from a Receiving session (sole entry).
    const movB = await prisma.inventoryMovement.findFirstOrThrow({
      where: { businessId, itemId: itemB.id, reason: InventoryMovementReason.SUPPLIER_PURCHASE },
    });
    assert.ok(movB.note?.startsWith("Receiving session "), "RECEIVE_NOW: movement is via Receiving");

    // ===== 3. default (no mode) === RECEIVE_NOW =====
    const draftC = await createDraft(businessId, { rawName: "Water", sku: "SKU-B", quantity: 4 });
    await approveSupplierPurchase({
      draftId: draftC.id,
      businessId,
      userId,
      // no settlement → default
      lines: [{ lineId: draftC.lines[0].id, action: "MERGE", itemId: itemB.id }],
    });
    const poC = await prisma.purchaseOrder.findFirstOrThrow({
      where: { businessId, sourceSupplierPurchaseDraftId: draftC.id },
      include: { receivingSessions: true },
    });
    assert.equal(poC.receivingSessions.length, 1, "default: behaves as RECEIVE_NOW (one session)");
    const itemBFinal = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: itemB.id } });
    assert.equal(itemBFinal.currentQuantity, 14, "default: stock 10 + 4 → 14");

    console.log("\nAll Phase A (commit-only / receive-now / default) checks passed");
  } finally {
    await deleteTestBusinesses([businessId]);
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
