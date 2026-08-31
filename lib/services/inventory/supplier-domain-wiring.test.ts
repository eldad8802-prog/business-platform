// Supplier domain wiring — regression tests for the four verified blockers.
//
// Each test below pins a failure that was reproduced in production before this
// change, so a future refactor that re-breaks it fails here instead of silently
// emptying a supplier card again.
//
//   1. supplierId was never persisted    → the supplier card found 0 orders
//   2. unitCost was dropped before Prisma → every total/cost read back as 0/null
//   3. an approved order never left "ממתינות" → "היסטוריה" was always empty
//   4. possibleMatches ignored the business identifier
//
// Run: npx tsx --env-file=.env lib/services/inventory/supplier-domain-wiring.test.ts

import assert from "node:assert/strict";
import { PurchaseOrderStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createSupplierPurchaseDraft } from "@/lib/services/inventory/supplier-purchase-intake.service";
import { approveSupplierPurchase } from "@/lib/services/inventory/supplier-purchase-approval.service";
import { purchaseOrderService } from "@/lib/services/inventory/purchase-order.service";
import { receivingService } from "@/lib/services/inventory/receiving.service";
import { supplierService } from "@/lib/services/inventory/supplier.service";
import { getSupplierPurchaseHistory } from "@/lib/services/inventory/supplier-purchase-history.read-model";
import { inventoryService } from "@/lib/services/inventory/inventory.service";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const results: string[] = [];

function ok(name: string) {
  results.push(`PASS  ${name}`);
  console.log(`PASS  ${name}`);
}

async function main() {
  const biz = await prisma.business.create({
    data: {
      name: `SupplierWiring ${runId}`,
      users: {
        create: {
          email: `sup-wiring-${runId}@example.test`,
          password: "x",
          name: "Owner",
        },
      },
    },
    include: { users: true },
  });
  const businessId = biz.id;
  const userId = biz.users[0].id;

  const otherBiz = await prisma.business.create({
    data: { name: `SupplierWiring Other ${runId}` },
  });

  try {
    const supplier = await supplierService.createSupplier({
      businessId,
      name: "ספק הבדיקה",
      phone: "0501112233",
      taxId: "514123456",
      taxIdType: "LTD_COMPANY",
      paymentTermsDays: 30,
      preferredPaymentMethod: "BANK_TRANSFER",
      contactName: "דנה",
      contactRole: "רכש",
      addressCity: "תל אביב",
    });

    // ── Profile completeness: the whole business slice round-trips ───────────
    {
      const row = await prisma.supplier.findUniqueOrThrow({
        where: { id: supplier.id },
      });
      assert.equal(row.taxId, "514123456", "taxId persisted");
      assert.equal(row.taxIdType, "LTD_COMPANY", "taxIdType persisted");
      assert.equal(row.paymentTermsDays, 30, "paymentTermsDays persisted");
      assert.equal(
        row.preferredPaymentMethod,
        "BANK_TRANSFER",
        "preferredPaymentMethod persisted"
      );
      assert.equal(row.contactName, "דנה", "contactName persisted");
      assert.equal(row.addressCity, "תל אביב", "addressCity persisted");
      ok("supplier business profile persists through create");
    }

    // A tax id is normalized to digits, so formatting can never split identity.
    {
      const dashed = await supplierService.createSupplier({
        businessId,
        name: `מנורמל ${runId}`,
        taxId: "51-412 3457",
      });
      const row = await prisma.supplier.findUniqueOrThrow({
        where: { id: dashed.id },
      });
      assert.equal(row.taxId, "514123457", "taxId stored digits-only");
      ok("tax id is normalized before storage");
    }

    // Malformed values are refused rather than stored.
    for (const [field, value] of [
      ["taxId", "12"],
      ["email", "not-an-email"],
      ["paymentTermsDays", 999],
    ] as const) {
      await assert.rejects(
        () =>
          supplierService.createSupplier({
            businessId,
            name: `bad-${field}-${runId}`,
            [field]: value,
          } as never),
        `${field} is validated`
      );
    }
    ok("malformed profile values are rejected, not stored");

    const item = await inventoryService.createItemWithInitialStock({
      businessId,
      name: `פריט ${runId}`,
      unitType: "UNIT",
      initialQuantity: 0,
      minimumQuantity: 0,
      reorderPoint: 0,
      createdByUserId: userId,
    });

    // ── TEST 1 + 2: draft carries the entity AND the cost ────────────────────
    const draftResult = await createSupplierPurchaseDraft({
      businessId,
      supplierId: supplier.id,
      // Deliberately WRONG name: the server must derive it from the entity.
      supplierName: "שם שהלקוח שלח",
      createdByUserId: userId,
      lines: [{ rawName: item.name, quantity: 1, unitCost: 12 }],
    });

    const draftId = draftResult.draft.id;
    const draftRow = await prisma.supplierPurchaseDraft.findUniqueOrThrow({
      where: { id: draftId },
      include: { lines: true },
    });

    assert.equal(draftRow.supplierId, supplier.id, "draft holds supplierId");
    assert.equal(
      draftRow.supplierName,
      "ספק הבדיקה",
      "draft name derived from the verified entity, not the client"
    );
    assert.equal(draftRow.lines[0].unitCost, 12, "draft line holds unitCost");
    ok("TEST 1/2: draft persists supplierId and unitCost");

    // A supplier from another tenant is indistinguishable from a missing one.
    const foreignSupplier = await prisma.supplier.create({
      data: { businessId: otherBiz.id, name: "ספק של עסק אחר" },
    });
    await assert.rejects(
      () =>
        createSupplierPurchaseDraft({
          businessId,
          supplierId: foreignSupplier.id,
          createdByUserId: userId,
          lines: [{ rawName: "x", quantity: 1 }],
        }),
      /Supplier not found/,
      "cross-tenant supplierId is refused"
    );
    ok("TEST 1: cross-tenant supplierId cannot be attached to a draft");

    // ── Approval carries both onto the PurchaseOrder ─────────────────────────
    await approveSupplierPurchase({
      draftId,
      businessId,
      userId,
      lines: [{ lineId: draftRow.lines[0].id, action: "MERGE", itemId: item.id }],
    });

    const po = await prisma.purchaseOrder.findFirstOrThrow({
      where: { businessId, sourceSupplierPurchaseDraftId: draftId },
      include: { lines: true },
    });

    assert.equal(po.supplierId, supplier.id, "PO holds supplierId");
    assert.equal(po.lines[0].unitCost, 12, "PO line holds unitCost");
    ok("TEST 1/2: approval carries supplierId and unitCost onto the PO");

    // ── TEST 4 (lifecycle): a fully received order leaves "ממתינות" ──────────
    assert.equal(
      po.status,
      PurchaseOrderStatus.CLOSED,
      "a fully received order is CLOSED, not left CONFIRMED"
    );
    ok("TEST 4: full receipt moves the order out of pending into history");

    // Inventory really moved, and the cost landed on the item.
    const itemAfter = await prisma.inventoryItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    assert.equal(itemAfter.currentQuantity, 1, "stock increased by the receipt");
    assert.equal(
      itemAfter.lastPurchaseCost,
      12,
      "lastPurchaseCost follows the received unit cost"
    );
    ok("TEST 2: unitCost reaches inventory as lastPurchaseCost");

    // ── TEST 3: the supplier card finds its own order, with money ────────────
    const history = await getSupplierPurchaseHistory({
      businessId,
      supplierId: supplier.id,
    });

    assert.equal(history.summary.purchaseOrderCount, 1, "card sees the order");
    assert.equal(history.summary.openPurchaseOrderCount, 0, "nothing left open");
    assert.equal(history.summary.orderedValue, 12, "ordered value is ₪12");
    assert.equal(history.summary.receivedValue, 12, "received value is ₪12");
    assert.equal(history.items[0].orderedValue, 12, "row total is ₪12");
    assert.equal(history.purchasedItems.length, 1, "card lists the item bought");
    assert.equal(history.purchasedItems[0].lastUnitCost, 12, "last cost shown");
    ok("TEST 3: supplier card returns its PO, its items and its costs");

    // Renaming the supplier must not detach its history — that is the whole
    // point of relating by id instead of by name.
    await supplierService.updateSupplier({
      businessId,
      supplierId: supplier.id,
      name: "ספק הבדיקה — שם חדש",
    });
    const afterRename = await getSupplierPurchaseHistory({
      businessId,
      supplierId: supplier.id,
    });
    assert.equal(
      afterRename.summary.purchaseOrderCount,
      1,
      "history survives a display-name change"
    );
    ok("renaming a supplier does not break its purchase history");

    // ── Partial receipt lands in "בדרך", not in history ──────────────────────
    {
      const partialPo = await purchaseOrderService.createPurchaseOrder({
        businessId,
        createdByUserId: userId,
        supplierId: supplier.id,
        status: PurchaseOrderStatus.CONFIRMED,
        lines: [{ itemId: item.id, orderedQty: 10, unitCost: 5 }],
      });

      const session = await receivingService.createReceivingSession({
        businessId,
        purchaseOrderId: partialPo.id,
        createdByUserId: userId,
        lines: [
          { purchaseOrderLineId: partialPo.lines[0].id, receivedQty: 4 },
        ],
      });
      await receivingService.postReceivingSession({
        businessId,
        receivingSessionId: session.id,
        postedByUserId: userId,
      });

      const partialAfter = await prisma.purchaseOrder.findUniqueOrThrow({
        where: { id: partialPo.id },
      });
      assert.equal(
        partialAfter.status,
        PurchaseOrderStatus.AWAITING_DELIVERY,
        "a partly received order is awaiting delivery, not closed"
      );

      const rest = await receivingService.createReceivingSession({
        businessId,
        purchaseOrderId: partialPo.id,
        createdByUserId: userId,
        lines: [
          { purchaseOrderLineId: partialPo.lines[0].id, receivedQty: 6 },
        ],
      });
      await receivingService.postReceivingSession({
        businessId,
        receivingSessionId: rest.id,
        postedByUserId: userId,
      });

      const closed = await prisma.purchaseOrder.findUniqueOrThrow({
        where: { id: partialPo.id },
      });
      assert.equal(
        closed.status,
        PurchaseOrderStatus.CLOSED,
        "the order closes once the remainder arrives"
      );
      ok("TEST 4: partial receipt → בדרך, remainder → היסטוריה");
    }

    // ── TEST 5: duplicate detection uses the business identifier ─────────────
    {
      const matches = await supplierService.findPossibleMatches({
        businessId,
        // A completely different NAME — only the identifier ties them together.
        name: `שם אחר לגמרי ${runId}`,
        taxId: "514123456",
      });

      const hit = matches.find((m) => m.id === supplier.id);
      assert.ok(hit, "the same business number surfaces the existing supplier");
      assert.ok(
        hit.reasons.includes("TAX_ID"),
        "the match reports WHY it matched"
      );
      assert.equal(
        matches[0].id,
        supplier.id,
        "identifier matches are ranked first"
      );
      ok("TEST 5: duplicate detection is driven by business identity");
    }

    {
      const byPhone = await supplierService.findPossibleMatches({
        businessId,
        name: "עסק בלי קשר",
        phone: "0501112233",
      });
      assert.ok(
        byPhone.some((m) => m.id === supplier.id),
        "phone still matches"
      );
      ok("TEST 5: phone and name matching still work alongside the identifier");
    }

    console.log(`\n${results.length}/${results.length} checks passed`);
  } finally {
    // ReceivingLine.itemId is onDelete: Restrict by design (stock movements must
    // not vanish under a deleted item), so the fixture is torn down in
    // dependency order rather than by cascading the business away.
    const ids = [businessId, otherBiz.id];
    await prisma.receivingLine.deleteMany({
      where: { receivingSession: { businessId: { in: ids } } },
    });
    await prisma.receivingSession.deleteMany({
      where: { businessId: { in: ids } },
    });
    await prisma.business.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  }
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
