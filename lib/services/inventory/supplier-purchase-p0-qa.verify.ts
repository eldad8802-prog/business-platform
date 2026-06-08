/**
 * P0 Procurement Cost Flow — manual QA verifier.
 * Run: npx tsx lib/services/inventory/supplier-purchase-p0-qa.verify.ts
 *
 * Simulates wizard intake → approve/receiving → item display expectations.
 */
import assert from "node:assert/strict";
import { InventoryUnitType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { deleteTestBusinesses } from "@/lib/testing/cleanup-test-businesses";
import { createSupplierPurchaseDraft } from "@/lib/services/inventory/supplier-purchase-intake.service";
import { approveSupplierPurchase } from "@/lib/services/inventory/supplier-purchase-approval.service";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const UNIT_COST = 18.5;
const SELL_PRICE = 42;

function isValidCost(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value);
}

function resolveDisplayCost(item: {
  lastPurchaseCost?: number | null;
  costPerUnit?: number | null;
}) {
  if (isValidCost(item.lastPurchaseCost)) {
    return { value: item.lastPurchaseCost, source: "last_purchase" as const };
  }
  if (isValidCost(item.costPerUnit)) {
    return { value: item.costPerUnit, source: "manual" as const };
  }
  return { value: null, source: null };
}

function grossMarginPercent(
  displayCost: number | null,
  sellPrice: number | null
): number | null {
  if (displayCost == null || sellPrice == null || sellPrice <= 0) return null;
  return Number((((sellPrice - displayCost) / sellPrice) * 100).toFixed(1));
}

async function loadItemTwice(itemId: number) {
  const first = await prisma.inventoryItem.findUniqueOrThrow({
    where: { id: itemId },
  });
  const second = await prisma.inventoryItem.findUniqueOrThrow({
    where: { id: itemId },
  });
  return { first, second };
}

async function main() {
  const business = await prisma.business.create({
    data: {
      name: `P0 QA ${runId}`,
      users: {
        create: {
          email: `p0-qa-${runId}@example.test`,
          password: "test-password",
          name: "P0 QA User",
        },
      },
    },
    include: { users: true },
  });

  const businessId = business.id;
  const userId = business.users[0].id;

  try {
    // --- Scenario A: wizard-like intake with unitCost ---
    const item = await prisma.inventoryItem.create({
      data: {
        businessId,
        name: `P0 QA Item ${runId}`,
        unitType: InventoryUnitType.UNIT,
        currentQuantity: 3,
        minimumQuantity: 0,
        costPerUnit: 9,
        sellPricePerUnit: SELL_PRICE,
      },
    });

    const intake = await createSupplierPurchaseDraft({
      businessId,
      supplierName: "P0 QA Supplier",
      source: "MANUAL",
      createdByUserId: userId,
      lines: [
        {
          rawName: item.name,
          quantity: 4,
          unitCost: UNIT_COST,
          unitType: InventoryUnitType.UNIT,
        },
      ],
    });

    const draftLine = intake.draft.lines[0];
    assert.equal(
      draftLine.unitCost,
      UNIT_COST,
      "draft line must persist wizard unitCost"
    );

    await approveSupplierPurchase({
      draftId: intake.draft.id,
      businessId,
      userId,
      lines: [
        { lineId: draftLine.id, action: "MERGE", itemId: item.id },
      ],
    });

    const { first, second } = await loadItemTwice(item.id);

    assert.equal(first.lastPurchaseCost, UNIT_COST);
    assert.ok(first.lastPurchaseCostAt, "lastPurchaseCostAt must be set");
    assert.deepEqual(
      {
        lastPurchaseCost: second.lastPurchaseCost,
        lastPurchaseCostAt: second.lastPurchaseCostAt?.toISOString(),
      },
      {
        lastPurchaseCost: first.lastPurchaseCost,
        lastPurchaseCostAt: first.lastPurchaseCostAt?.toISOString(),
      },
      "refresh must return identical persisted economics"
    );

    const display = resolveDisplayCost(first);
    assert.equal(display.source, "last_purchase");
    assert.equal(display.value, UNIT_COST);

    const margin = grossMarginPercent(display.value, first.sellPricePerUnit);
    assert.equal(
      margin,
      Number((((SELL_PRICE - UNIT_COST) / SELL_PRICE) * 100).toFixed(1))
    );

    // --- Scenario B: regression without unitCost ---
    const noCostItem = await prisma.inventoryItem.create({
      data: {
        businessId,
        name: `P0 QA No Cost ${runId}`,
        unitType: InventoryUnitType.UNIT,
        currentQuantity: 1,
        minimumQuantity: 0,
      },
    });

    const noCostIntake = await createSupplierPurchaseDraft({
      businessId,
      source: "MANUAL",
      createdByUserId: userId,
      lines: [{ rawName: noCostItem.name, quantity: 2 }],
    });

    await approveSupplierPurchase({
      draftId: noCostIntake.draft.id,
      businessId,
      userId,
      lines: [
        {
          lineId: noCostIntake.draft.lines[0].id,
          action: "MERGE",
          itemId: noCostItem.id,
        },
      ],
    });

    const noCostAfter = await prisma.inventoryItem.findUniqueOrThrow({
      where: { id: noCostItem.id },
    });
    assert.equal(noCostAfter.currentQuantity, 3);
    assert.equal(noCostAfter.lastPurchaseCost, null);
    assert.equal(noCostAfter.lastPurchaseCostAt, null);

    console.log(
      JSON.stringify(
        {
          status: "PASS",
          scenarioA: {
            itemId: item.id,
            unitCostEntered: UNIT_COST,
            lastPurchaseCost: first.lastPurchaseCost,
            lastPurchaseCostAt: first.lastPurchaseCostAt?.toISOString(),
            displayCostSource: display.source,
            displayCostValue: display.value,
            sellPricePerUnit: first.sellPricePerUnit,
            grossMarginPercent: margin,
            refreshStable: true,
          },
          scenarioB: {
            itemId: noCostItem.id,
            currentQuantity: noCostAfter.currentQuantity,
            lastPurchaseCost: noCostAfter.lastPurchaseCost,
            regressionOk: true,
          },
        },
        null,
        2
      )
    );
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
