// S4-P4 read-model tests: supplier purchase history is related by supplierId
// ONLY (never supplierName), double-scoped by businessId, tenant-safe, paginated.
// Run: npx tsx --env-file=.env lib/services/inventory/supplier-purchase-history.read-model.test.ts

import assert from "node:assert/strict";
import { PurchaseOrderStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  getSupplierPurchaseHistory,
} from "@/lib/services/inventory/supplier-purchase-history.read-model";
import { InventoryNotFoundError } from "@/lib/services/inventory/inventory.errors";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function makePO(businessId: number, opts: {
  supplierId: number | null;
  supplierName: string | null;
  status: PurchaseOrderStatus;
  lines?: number;
}) {
  return prisma.purchaseOrder.create({
    data: {
      businessId,
      supplierId: opts.supplierId,
      supplierName: opts.supplierName,
      status: opts.status,
      source: "MANUAL",
      lines: opts.lines
        ? { create: Array.from({ length: opts.lines }, (_, i) => ({ rawName: `line${i}`, orderedQty: 1 })) }
        : undefined,
    },
  });
}

async function main() {
  const bizA = await prisma.business.create({
    data: { name: `PO-Hist A ${runId}`, users: { create: { email: `poh-a-${runId}@example.test`, password: "x", name: "A" } } },
    include: { users: true },
  });
  const bizB = await prisma.business.create({
    data: { name: `PO-Hist B ${runId}`, users: { create: { email: `poh-b-${runId}@example.test`, password: "x", name: "B" } } },
    include: { users: true },
  });
  const A = bizA.id, B = bizB.id;

  const supA1 = await prisma.supplier.create({ data: { businessId: A, name: "שטראוס עלית" } });
  const supA2 = await prisma.supplier.create({ data: { businessId: A, name: "שטראוס עלית" } }); // same name, different entity
  const supAEmpty = await prisma.supplier.create({ data: { businessId: A, name: "ספק ריק" } });
  const supB1 = await prisma.supplier.create({ data: { businessId: B, name: "Other Tenant Supplier" } });

  try {
    // supplierA1: 4 linked POs (2 open: CONFIRMED, SENT ; 2 terminal: CLOSED, CANCELLED)
    const p1 = await makePO(A, { supplierId: supA1.id, supplierName: "שטראוס עלית", status: PurchaseOrderStatus.CONFIRMED, lines: 3 });
    const p2 = await makePO(A, { supplierId: supA1.id, supplierName: "שטראוס עלית", status: PurchaseOrderStatus.SENT });
    const p3 = await makePO(A, { supplierId: supA1.id, supplierName: "שטראוס עלית", status: PurchaseOrderStatus.CLOSED });
    const p4 = await makePO(A, { supplierId: supA1.id, supplierName: "שטראוס עלית", status: PurchaseOrderStatus.CANCELLED });
    // noise that must NOT appear in supA1 history:
    await makePO(A, { supplierId: null, supplierName: "שטראוס עלית", status: PurchaseOrderStatus.CONFIRMED }); // null id, same name
    await makePO(A, { supplierId: supA2.id, supplierName: "שטראוס עלית", status: PurchaseOrderStatus.CONFIRMED }); // other supplier, same name
    await makePO(B, { supplierId: supB1.id, supplierName: "Other Tenant Supplier", status: PurchaseOrderStatus.CONFIRMED }); // other business

    // 1) empty supplier
    const empty = await getSupplierPurchaseHistory({ businessId: A, supplierId: supAEmpty.id });
    assert.equal(empty.summary.purchaseOrderCount, 0, "1: count 0");
    assert.equal(empty.summary.openPurchaseOrderCount, 0, "1: open 0");
    assert.equal(empty.summary.lastPurchaseOrderAt, null, "1: last null");
    assert.deepEqual(empty.items, [], "1: items []");

    // 2)+3)+4)+5)+8) summary: only supA1's 4 linked POs; open=2
    const h = await getSupplierPurchaseHistory({ businessId: A, supplierId: supA1.id, limit: 50 });
    assert.equal(h.summary.purchaseOrderCount, 4, "2: only supplierId-linked counted (4)");
    assert.equal(h.summary.openPurchaseOrderCount, 2, "8: open count = CONFIRMED+SENT (2)");
    const ids = h.items.map((i) => i.id);
    assert.ok(!ids.includes(-1), "sanity");
    assert.equal(new Set(ids).size, 4, "2: exactly 4 items, no noise");
    // noise POs excluded:
    assert.ok(h.items.every((i) => i.supplierId === supA1.id), "3/4/5: every item is linked to supA1 by id");

    // 2) order: newest first (createdAt desc, id desc) => p4,p3,p2,p1
    assert.deepEqual(ids, [p4.id, p3.id, p2.id, p1.id], "2: order newest-first by canonical date + id");

    // 9) lastPurchaseOrderAt == max createdAt (p4)
    assert.equal(h.summary.lastPurchaseOrderAt, p4.createdAt.toISOString(), "9: lastPurchaseOrderAt = max createdAt");

    // lineCount surfaced
    const p1Item = h.items.find((i) => i.id === p1.id);
    assert.equal(p1Item?.lineCount, 3, "lineCount reflects PO lines");

    // 6) tenant-safe: supplier of another business -> not found
    await assert.rejects(
      () => getSupplierPurchaseHistory({ businessId: A, supplierId: supB1.id }),
      (e) => e instanceof InventoryNotFoundError,
      "6: cross-tenant supplier -> tenant-safe not found"
    );

    // 7) pagination: limit + offset, stable order, no overlap / skips
    const page1 = await getSupplierPurchaseHistory({ businessId: A, supplierId: supA1.id, limit: 2, offset: 0 });
    const page2 = await getSupplierPurchaseHistory({ businessId: A, supplierId: supA1.id, limit: 2, offset: 2 });
    assert.deepEqual(page1.items.map((i) => i.id), [p4.id, p3.id], "7: page1");
    assert.deepEqual(page2.items.map((i) => i.id), [p2.id, p1.id], "7: page2");
    assert.equal(page1.pagination.hasMore, true, "7: page1 hasMore");
    assert.equal(page2.pagination.hasMore, false, "7: page2 no more");
    const overlap = page1.items.map((i) => i.id).filter((id) => page2.items.map((j) => j.id).includes(id));
    assert.equal(overlap.length, 0, "7: no overlap between pages");
    // max limit clamp
    const clamped = await getSupplierPurchaseHistory({ businessId: A, supplierId: supA1.id, limit: 9999 });
    assert.ok(clamped.pagination.limit <= 50, "7: limit clamped to max 50");

    console.log("supplier-purchase-history.read-model.test.ts: ok");
  } finally {
    const ids = [A, B];
    await prisma.purchaseOrder.deleteMany({ where: { businessId: { in: ids } } });
    await prisma.supplier.deleteMany({ where: { businessId: { in: ids } } });
    await prisma.user.deleteMany({ where: { businessId: { in: ids } } });
    await prisma.business.deleteMany({ where: { id: { in: ids } } });
  }
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
