/**
 * Supplier Domain Phase 3 — Measure end-to-end (run manually, DIRECT DB url):
 *   DATABASE_URL=$DIRECT_URL npx tsx lib/services/inventory/supplier-measure.e2e.test.ts
 *
 * Verifies Representation Conversion through the real approval flow:
 *   - First order with no learned factor → 1:1 (qty/cost unchanged), but the
 *     supplier unitCost now flows (cost-per-stock-unit = unitCost).
 *   - After setting factor=12 on the mapping, a later order of the SAME product
 *     converts: 3 cases → 36 bottles, ₪120/case → ₪10/bottle.
 *   - PO + Receiving lines snapshot purchaseUnitName / purchaseQty / factor.
 *   - Inventory moves only by the converted STOCK quantity (via Receiving).
 */
import assert from "node:assert/strict";
import { InventoryUnitType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { deleteTestBusinesses } from "@/lib/testing/cleanup-test-businesses";
import { createSupplierPurchaseDraft } from "@/lib/services/inventory/supplier-purchase-intake.service";
import { approveSupplierPurchase } from "@/lib/services/inventory/supplier-purchase-approval.service";
import { setRepresentationMeasureTx } from "@/lib/services/inventory/supplier-identity-learning.service";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const SUPPLIER = "ACME Measure";
const SKU = "SKU-COLA";

async function orderOneCase(
  businessId: number,
  userId: number,
  itemId: number,
  quantity: number,
  unitCost: number
) {
  const draft = await createSupplierPurchaseDraft({
    businessId,
    supplierName: SUPPLIER,
    source: "MANUAL",
    createdByUserId: userId,
    lines: [{ rawName: "Cola 1.5L", sku: SKU, quantity, unitCost, unitType: InventoryUnitType.UNIT }],
  });
  await approveSupplierPurchase({
    draftId: draft.draft.id,
    businessId,
    userId,
    lines: [{ lineId: draft.draft.lines[0].id, action: "MERGE", itemId }],
  });
}

async function main() {
  const business = await prisma.business.create({
    data: {
      name: `SupplierP3 ${runId}`,
      users: { create: { email: `supplier-p3-${runId}@example.test`, password: "test-password", name: "P3" } },
    },
    include: { users: true },
  });
  const businessId = business.id;
  const userId = business.users[0].id;

  try {
    const item = await prisma.inventoryItem.create({
      data: { businessId, name: `Cola Bottle ${runId}`, unitType: InventoryUnitType.UNIT, currentQuantity: 0, minimumQuantity: 0 },
    });

    // ===== 1. First order — no factor yet → 1:1, cost flows =====
    await orderOneCase(businessId, userId, item.id, 5, 120);

    const afterFirst = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    assert.equal(afterFirst.currentQuantity, 5, "1:1 — 5 units received");
    assert.equal(afterFirst.lastPurchaseCost, 120, "1:1 — cost-per-stock-unit = unitCost (cost now flows)");

    const sp = await prisma.supplierProduct.findFirst({ where: { businessId, externalSku: SKU } });
    assert.ok(sp, "SupplierProduct learned at first approval");

    const poLine1 = await prisma.purchaseOrderLine.findFirst({
      where: { itemId: item.id, conversionFactor: 1 },
      orderBy: { id: "desc" },
    });
    assert.ok(poLine1, "PO line snapshot exists for 1:1 order");
    assert.equal(poLine1!.orderedQty, 5, "1:1 PO orderedQty = 5 stock units");
    assert.equal(poLine1!.purchaseQty, 5, "1:1 PO purchaseQty snapshot = 5");
    assert.equal(poLine1!.unitCost, 120, "1:1 PO unitCost = 120");

    // ===== 2. Set the Measure factor (12 bottles per case) =====
    await prisma.$transaction((tx) =>
      setRepresentationMeasureTx(tx, {
        businessId,
        supplierProductId: sp!.id,
        purchaseUnitName: "CASE",
        factor: 12,
        measureSource: "test:set-measure",
        resolvedByUserId: userId,
      })
    );

    // ===== 3. Second order — factor=12 applies =====
    await orderOneCase(businessId, userId, item.id, 3, 120);

    const afterSecond = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    assert.equal(afterSecond.currentQuantity, 5 + 36, "factor applied: 3 cases × 12 = 36 bottles added (total 41)");
    assert.equal(afterSecond.lastPurchaseCost, 10, "factor applied: ₪120/case ÷ 12 = ₪10/bottle");

    const poLine2 = await prisma.purchaseOrderLine.findFirst({
      where: { itemId: item.id, conversionFactor: 12 },
      orderBy: { id: "desc" },
    });
    assert.ok(poLine2, "PO line snapshot exists for converted order");
    assert.equal(poLine2!.orderedQty, 36, "converted PO orderedQty = 36 stock units");
    assert.equal(poLine2!.purchaseQty, 3, "PO purchaseQty snapshot = 3 cases");
    assert.equal(poLine2!.purchaseUnitName, "CASE", "PO purchaseUnitName snapshot = CASE");
    assert.equal(poLine2!.unitCost, 10, "converted PO unitCost = ₪10/bottle");

    const rcvLine2 = await prisma.receivingLine.findFirst({
      where: { itemId: item.id, conversionFactor: 12 },
      orderBy: { id: "desc" },
    });
    assert.ok(rcvLine2, "Receiving line snapshot exists for converted order");
    assert.equal(rcvLine2!.receivedQty, 36, "Receiving receivedQty = 36 stock units");
    assert.equal(rcvLine2!.receivedPurchaseQty, 3, "Receiving receivedPurchaseQty snapshot = 3 cases");
    assert.equal(rcvLine2!.conversionFactor, 12, "Receiving conversionFactor snapshot = 12");

    console.log("supplier-measure.e2e.test.ts: ok");
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
