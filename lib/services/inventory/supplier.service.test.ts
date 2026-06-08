import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { deleteTestBusinesses } from "@/lib/testing/cleanup-test-businesses";
import { supplierService } from "@/lib/services/inventory/supplier.service";
import {
  InventoryNotFoundError,
  InventoryValidationError,
} from "@/lib/services/inventory/inventory.errors";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function createBusiness(label: string) {
  const business = await prisma.business.create({
    data: {
      name: `Supplier 5A ${label} ${runId}`,
      users: {
        create: {
          email: `supplier-5a-${label}-${runId}@example.test`,
          password: "test-password",
          name: "Supplier Test User",
        },
      },
    },
  });
  return business.id;
}

async function main() {
  const businessA = await createBusiness("A");
  const businessB = await createBusiness("B");

  try {
    // ===== 1. CREATE + GET =====
    const created = await supplierService.createSupplier({
      businessId: businessA,
      name: "  Strauss  ",
      phone: " 03-1234567 ",
      email: " sales@strauss.test ",
      notes: " primary dairy supplier ",
      defaultLeadTimeDays: 7,
    });
    assert.equal(created.name, "Strauss", "name trimmed");
    assert.equal(created.phone, "03-1234567", "phone trimmed");
    assert.equal(created.email, "sales@strauss.test", "email trimmed");
    assert.equal(created.notes, "primary dairy supplier", "notes trimmed");
    assert.equal(created.defaultLeadTimeDays, 7, "lead time stored");
    assert.equal(created.isActive, true, "new supplier is active");

    const fetched = await supplierService.getSupplier({
      businessId: businessA,
      supplierId: created.id,
    });
    assert.equal(fetched.id, created.id, "get returns the created supplier");

    // ===== 2. VALIDATION =====
    await assert.rejects(
      () => supplierService.createSupplier({ businessId: businessA, name: "   " }),
      InventoryValidationError,
      "empty name rejected"
    );
    await assert.rejects(
      () =>
        supplierService.createSupplier({
          businessId: businessA,
          name: "Bad lead",
          defaultLeadTimeDays: -1,
        }),
      InventoryValidationError,
      "negative lead time rejected"
    );

    // ===== 3. DUPLICATE NAMES ALLOWED (no unique, no block, no auto-merge) =====
    const dupExact = await supplierService.createSupplier({
      businessId: businessA,
      name: "Strauss",
      phone: "050-9999999",
    });
    assert.notEqual(dupExact.id, created.id, "duplicate name creates new row");

    const allActive = await supplierService.listSuppliers({
      businessId: businessA,
    });
    assert.equal(
      allActive.filter((s) => s.name === "Strauss").length,
      2,
      "two suppliers named Strauss coexist"
    );

    // Soft duplicate detection surfaces likely matches (advisory only).
    // "Strauss Ltd" must still surface the existing "Strauss" via normalization.
    const matches = await supplierService.findPossibleMatches({
      businessId: businessA,
      name: "Strauss Ltd",
    });
    assert.ok(
      matches.some((m) => m.id === created.id),
      "possible matches include same normalized name"
    );

    const phoneMatch = await supplierService.findPossibleMatches({
      businessId: businessA,
      name: "Totally Different Name",
      phone: "03-1234567",
    });
    assert.ok(
      phoneMatch.some((m) => m.id === created.id),
      "possible matches include same phone"
    );

    // ===== 4. UPDATE =====
    const updated = await supplierService.updateSupplier({
      businessId: businessA,
      supplierId: created.id,
      name: "Strauss Group",
      notes: null,
    });
    assert.equal(updated.name, "Strauss Group", "name updated");
    assert.equal(updated.notes, null, "notes cleared");
    assert.equal(updated.phone, "03-1234567", "untouched field preserved");

    // ===== 5. DEACTIVATE / REACTIVATE =====
    const deactivated = await supplierService.deactivateSupplier({
      businessId: businessA,
      supplierId: created.id,
    });
    assert.equal(deactivated.isActive, false, "deactivated");

    const activeList = await supplierService.listSuppliers({
      businessId: businessA,
      status: "active",
    });
    assert.ok(
      !activeList.some((s) => s.id === created.id),
      "deactivated supplier hidden from active list"
    );

    const inactiveList = await supplierService.listSuppliers({
      businessId: businessA,
      status: "inactive",
    });
    assert.ok(
      inactiveList.some((s) => s.id === created.id),
      "deactivated supplier shows in inactive list"
    );

    const reactivated = await supplierService.updateSupplier({
      businessId: businessA,
      supplierId: created.id,
      isActive: true,
    });
    assert.equal(reactivated.isActive, true, "reactivated");

    // ===== 6. SEARCH FILTER =====
    const searched = await supplierService.listSuppliers({
      businessId: businessA,
      query: "group",
    });
    assert.ok(
      searched.some((s) => s.id === created.id),
      "case-insensitive search by name"
    );

    // ===== 7. TENANT ISOLATION =====
    const bSupplier = await supplierService.createSupplier({
      businessId: businessB,
      name: "Business B Supplier",
    });

    const bList = await supplierService.listSuppliers({ businessId: businessB });
    assert.equal(bList.length, 1, "business B sees only its own supplier");

    await assert.rejects(
      () =>
        supplierService.getSupplier({
          businessId: businessB,
          supplierId: created.id,
        }),
      InventoryNotFoundError,
      "cannot read another business's supplier"
    );

    await assert.rejects(
      () =>
        supplierService.updateSupplier({
          businessId: businessB,
          supplierId: created.id,
          name: "hijack",
        }),
      InventoryNotFoundError,
      "cannot update another business's supplier"
    );

    const matchesIsolated = await supplierService.findPossibleMatches({
      businessId: businessB,
      name: "Strauss",
    });
    assert.equal(
      matchesIsolated.length,
      0,
      "duplicate detection is tenant scoped"
    );
    assert.ok(bSupplier.id, "business B supplier created");

    console.log("supplier.service.test.ts: ok");
  } finally {
    await deleteTestBusinesses([businessA, businessB]);
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
