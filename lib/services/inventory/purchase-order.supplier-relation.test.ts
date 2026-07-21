// S4-P2 write-path tests: PurchaseOrder <-> Supplier Entity-FK (Tier 2).
// Proves supplierId is persisted from a server-verified Supplier, supplierName
// is derived from the entity (not the client), tenant-safety, legacy fallback,
// and that draft-based approval never guesses a supplier.
// Run: npx tsx --env-file=.env lib/services/inventory/purchase-order.supplier-relation.test.ts

import assert from "node:assert/strict";
import { SupplierPurchaseDraftStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { purchaseOrderService } from "@/lib/services/inventory/purchase-order.service";
import { approveSupplierPurchase } from "@/lib/services/inventory/supplier-purchase-approval.service";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const line = () => [{ rawName: "Test Item", orderedQty: 5 }];

async function poCount(businessId: number): Promise<number> {
  return prisma.purchaseOrder.count({ where: { businessId } });
}

async function main() {
  const bizA = await prisma.business.create({
    data: {
      name: `PO-Supplier-Rel A ${runId}`,
      users: { create: { email: `po-rel-a-${runId}@example.test`, password: "x", name: "A" } },
    },
    include: { users: true },
  });
  const bizB = await prisma.business.create({
    data: {
      name: `PO-Supplier-Rel B ${runId}`,
      users: { create: { email: `po-rel-b-${runId}@example.test`, password: "x", name: "B" } },
    },
    include: { users: true },
  });
  const businessId = bizA.id;
  const userId = bizA.users[0].id;

  const supplierA = await prisma.supplier.create({
    data: { businessId, name: "שטראוס עלית", phone: "0501234567" },
  });
  const supplierB = await prisma.supplier.create({
    data: { businessId: bizB.id, name: "Other Tenant Supplier" },
  });

  try {
    // 1) valid supplierId → id saved + supplierName derived from DB entity
    const po1 = await purchaseOrderService.createPurchaseOrder({
      businessId,
      createdByUserId: userId,
      supplierId: supplierA.id,
      lines: line(),
    });
    const row1 = await prisma.purchaseOrder.findUnique({ where: { id: po1.id } });
    assert.equal(row1?.supplierId, supplierA.id, "1: supplierId persisted");
    assert.equal(row1?.supplierName, "שטראוס עלית", "1: supplierName derived from DB");

    // 2) valid supplierId + DIFFERENT supplierName in request → DB name wins
    const po2 = await purchaseOrderService.createPurchaseOrder({
      businessId,
      createdByUserId: userId,
      supplierId: supplierA.id,
      supplierName: "SPOOFED NAME FROM CLIENT",
      lines: line(),
    });
    const row2 = await prisma.purchaseOrder.findUnique({ where: { id: po2.id } });
    assert.equal(row2?.supplierId, supplierA.id, "2: supplierId persisted");
    assert.equal(
      row2?.supplierName,
      "שטראוס עלית",
      "2: server-derived name wins over client-supplied name"
    );

    // 3) non-existent supplierId → throws, no PO created
    const before3 = await poCount(businessId);
    await assert.rejects(
      () =>
        purchaseOrderService.createPurchaseOrder({
          businessId,
          createdByUserId: userId,
          supplierId: 999_999_999,
          lines: line(),
        }),
      /Supplier not found/,
      "3: non-existent supplier must reject"
    );
    assert.equal(await poCount(businessId), before3, "3: no PO created on failure");

    // 4) supplierId of ANOTHER business → tenant-safe reject, no PO created
    const before4 = await poCount(businessId);
    await assert.rejects(
      () =>
        purchaseOrderService.createPurchaseOrder({
          businessId,
          createdByUserId: userId,
          supplierId: supplierB.id, // belongs to bizB
          lines: line(),
        }),
      /Supplier not found/,
      "4: cross-tenant supplier must reject tenant-safely (looks like not-found)"
    );
    assert.equal(await poCount(businessId), before4, "4: no PO created on cross-tenant failure");

    // 5) no supplierId → legacy path, supplierId null, supplierName snapshot kept
    const po5 = await purchaseOrderService.createPurchaseOrder({
      businessId,
      createdByUserId: userId,
      supplierName: "Legacy Free-Text Supplier",
      lines: line(),
    });
    const row5 = await prisma.purchaseOrder.findUnique({ where: { id: po5.id } });
    assert.equal(row5?.supplierId, null, "5: supplierId is null without supplierId input");
    assert.equal(row5?.supplierName, "Legacy Free-Text Supplier", "5: raw snapshot kept");

    // 6) draft-based approval (name only) → PO with supplierId null, name from draft
    const item = await prisma.inventoryItem.create({
      data: { businessId, name: "Approval Item", unitType: "UNIT", currentQuantity: 0 },
    });
    const draft = await prisma.supplierPurchaseDraft.create({
      data: {
        businessId,
        supplierName: "Draft-Only Supplier",
        source: "MANUAL",
        status: SupplierPurchaseDraftStatus.PENDING_REVIEW,
        lines: { create: [{ rawName: "Approval Item", quantity: 3 }] },
      },
      include: { lines: true },
    });
    await approveSupplierPurchase({
      draftId: draft.id,
      businessId,
      userId,
      lines: [{ lineId: draft.lines[0].id, action: "MERGE", itemId: item.id }],
    });
    const approvalPo = await prisma.purchaseOrder.findFirst({
      where: { businessId, sourceSupplierPurchaseDraftId: draft.id },
    });
    assert.ok(approvalPo, "6: approval created a PO");
    assert.equal(approvalPo?.supplierId, null, "6: approval never guesses a supplier (null)");
    assert.equal(approvalPo?.supplierName, "Draft-Only Supplier", "6: name from draft snapshot");

    // 7) existing orders untouched — po1 still linked, po5 still null after later writes
    const row1After = await prisma.purchaseOrder.findUnique({ where: { id: po1.id } });
    const row5After = await prisma.purchaseOrder.findUnique({ where: { id: po5.id } });
    assert.equal(row1After?.supplierId, supplierA.id, "7: earlier linked PO unchanged");
    assert.equal(row5After?.supplierId, null, "7: earlier null PO unchanged");

    console.log("purchase-order.supplier-relation.test.ts: ok");
  } finally {
    await prisma.purchaseOrder.deleteMany({ where: { businessId: { in: [bizA.id, bizB.id] } } });
    await prisma.supplierPurchaseDraft.deleteMany({ where: { businessId: { in: [bizA.id, bizB.id] } } });
    await prisma.inventoryMovement.deleteMany({ where: { businessId: { in: [bizA.id, bizB.id] } } });
    await prisma.inventoryItem.deleteMany({ where: { businessId: { in: [bizA.id, bizB.id] } } });
    await prisma.supplier.deleteMany({ where: { businessId: { in: [bizA.id, bizB.id] } } });
    await prisma.user.deleteMany({ where: { businessId: { in: [bizA.id, bizB.id] } } });
    await prisma.business.deleteMany({ where: { id: { in: [bizA.id, bizB.id] } } });
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
