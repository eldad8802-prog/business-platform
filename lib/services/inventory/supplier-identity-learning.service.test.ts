/**
 * Supplier Domain Phase 2 — Identity Learning (run manually):
 *   npx tsx lib/services/inventory/supplier-identity-learning.service.test.ts
 *
 * End-to-end against the real approval flow. Verifies that approving a supplier
 * purchase draft persists the human MERGE/CREATE_NEW resolution as a corrigible
 * Identity mapping, per Constitution v1.2 / Phase 2 plan:
 *   - SupplierProduct materialized lazily AT approval (Reported Reality ref).
 *   - RepresentationMapping = KNOWN + HUMAN_CONFIRMED, ACTIVE.
 *   - MERGE and CREATE_NEW both learn.
 *   - Revision = retract-then-insert; single ACTIVE; old kept as RETRACTED.
 *   - Idempotent on re-confirmation of the same item.
 *   - Degrade: no supplierName → no learning, approval still succeeds.
 *   - Guard: SupplierProduct never writes the InventoryItem.
 *
 * NOTE: each draft carries a single line so the (heavy, real) approval
 * transaction stays well under its 15s interactive-tx budget on a remote DB.
 */
import assert from "node:assert/strict";
import {
  InventoryUnitType,
  PartyClaimConfidence,
  PartyClaimStatus,
  PartyResolutionMethod,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { deleteTestBusinesses } from "@/lib/testing/cleanup-test-businesses";
import { createSupplierPurchaseDraft } from "@/lib/services/inventory/supplier-purchase-intake.service";
import { approveSupplierPurchase } from "@/lib/services/inventory/supplier-purchase-approval.service";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const SUPPLIER = "ACME Foods";

function activeMappings(businessId: number, supplierProductId: number) {
  return prisma.representationMapping.findMany({
    where: { businessId, supplierProductId, status: PartyClaimStatus.ACTIVE },
    orderBy: { id: "asc" },
  });
}

/** Create a single-line draft and approve it with one decision. */
async function approveSingleLine(
  businessId: number,
  userId: number,
  supplierName: string | null,
  line: { rawName: string; sku: string; quantity: number },
  decision:
    | { action: "MERGE"; itemId: number }
    | { action: "CREATE_NEW"; itemData: { name: string; unitType: string } }
) {
  const draft = await createSupplierPurchaseDraft({
    businessId,
    supplierName,
    source: "MANUAL",
    createdByUserId: userId,
    lines: [
      { rawName: line.rawName, sku: line.sku, quantity: line.quantity, unitType: InventoryUnitType.UNIT },
    ],
  });
  const lineId = draft.draft.lines[0].id;
  await approveSupplierPurchase({
    draftId: draft.draft.id,
    businessId,
    userId,
    lines: [{ lineId, ...decision }],
  });
}

async function main() {
  const business = await prisma.business.create({
    data: {
      name: `SupplierP2 ${runId}`,
      users: {
        create: {
          email: `supplier-p2-${runId}@example.test`,
          password: "test-password",
          name: "Supplier P2 Test User",
        },
      },
    },
    include: { users: true },
  });
  const businessId = business.id;
  const userId = business.users[0].id;

  try {
    const existingItem = await prisma.inventoryItem.create({
      data: {
        businessId,
        name: `Existing Item ${runId}`,
        unitType: InventoryUnitType.UNIT,
        currentQuantity: 5,
        minimumQuantity: 0,
      },
    });
    const existingName = existingItem.name;

    // ===== 1. MERGE learns: SKU-A → existing item =====
    await approveSingleLine(
      businessId,
      userId,
      SUPPLIER,
      { rawName: "Cola 1.5L", sku: "SKU-A", quantity: 3 },
      { action: "MERGE", itemId: existingItem.id }
    );

    const spA = await prisma.supplierProduct.findFirst({ where: { businessId, externalSku: "SKU-A" } });
    assert.ok(spA, "SupplierProduct materialized lazily at approval (MERGE line)");
    const mapA = await activeMappings(businessId, spA!.id);
    assert.equal(mapA.length, 1, "exactly one ACTIVE mapping for SKU-A");
    assert.equal(mapA[0].inventoryItemId, existingItem.id, "MERGE → maps to existing item");
    assert.equal(mapA[0].identityConfidence, PartyClaimConfidence.KNOWN, "mapping is KNOWN");
    assert.equal(mapA[0].method, PartyResolutionMethod.HUMAN_CONFIRMED, "mapping is HUMAN_CONFIRMED");
    assert.equal(mapA[0].status, PartyClaimStatus.ACTIVE, "mapping is ACTIVE");

    // Guard: SupplierProduct never wrote the InventoryItem's identity.
    const existingAfter = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: existingItem.id } });
    assert.equal(existingAfter.name, existingName, "InventoryItem name NOT overwritten by SupplierProduct (no inversion)");

    // ===== 2. CREATE_NEW learns: SKU-B → a newly created item =====
    await approveSingleLine(
      businessId,
      userId,
      SUPPLIER,
      { rawName: "New Snack", sku: "SKU-B", quantity: 2 },
      { action: "CREATE_NEW", itemData: { name: "New Snack", unitType: "UNIT" } }
    );

    const spB = await prisma.supplierProduct.findFirst({ where: { businessId, externalSku: "SKU-B" } });
    assert.ok(spB, "SupplierProduct materialized (CREATE_NEW line)");
    const mapB = await activeMappings(businessId, spB!.id);
    assert.equal(mapB.length, 1, "exactly one ACTIVE mapping for SKU-B");
    assert.notEqual(mapB[0].inventoryItemId, existingItem.id, "CREATE_NEW → maps to a newly created item");

    // ===== 3. Revision: SKU-A re-mapped to a DIFFERENT item =====
    const otherItem = await prisma.inventoryItem.create({
      data: { businessId, name: `Other Item ${runId}`, unitType: InventoryUnitType.UNIT, currentQuantity: 0, minimumQuantity: 0 },
    });
    await approveSingleLine(
      businessId,
      userId,
      SUPPLIER,
      { rawName: "Cola 1.5L", sku: "SKU-A", quantity: 1 },
      { action: "MERGE", itemId: otherItem.id }
    );

    const mapARev = await activeMappings(businessId, spA!.id);
    assert.equal(mapARev.length, 1, "still exactly one ACTIVE after revision");
    assert.equal(mapARev[0].inventoryItemId, otherItem.id, "revision repoints to the new item");
    const retractedA = await prisma.representationMapping.findMany({
      where: { businessId, supplierProductId: spA!.id, status: PartyClaimStatus.RETRACTED },
    });
    assert.ok(
      retractedA.some((m) => m.inventoryItemId === existingItem.id),
      "old mapping kept as RETRACTED (corrigible, never deleted)"
    );

    // ===== 4. Idempotent: re-confirm the SAME item → NOOP =====
    await approveSingleLine(
      businessId,
      userId,
      SUPPLIER,
      { rawName: "Cola 1.5L", sku: "SKU-A", quantity: 1 },
      { action: "MERGE", itemId: otherItem.id }
    );
    const mapANoop = await activeMappings(businessId, spA!.id);
    assert.equal(mapANoop.length, 1, "idempotent: still one ACTIVE");
    assert.equal(mapANoop[0].id, mapARev[0].id, "idempotent: same mapping row (no churn)");

    // ===== 5. Degrade: no supplierName → no learning, approval still succeeds =====
    await approveSingleLine(
      businessId,
      userId,
      null,
      { rawName: "Ghost", sku: "SKU-GHOST", quantity: 1 },
      { action: "CREATE_NEW", itemData: { name: "Ghost", unitType: "UNIT" } }
    );
    const ghostSp = await prisma.supplierProduct.findFirst({ where: { businessId, externalSku: "SKU-GHOST" } });
    assert.equal(ghostSp, null, "no supplierName → no SupplierProduct (degrade); approval still succeeded");

    console.log("supplier-identity-learning.service.test.ts: ok");
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
