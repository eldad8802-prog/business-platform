/**
 * Supplier as Party Role — Phase 1 (run manually):
 *   npx tsx lib/services/party/supplier-party-resolution.service.test.ts
 *
 * Real DB + cleanup. Verifies that creating/updating Suppliers feeds Party
 * Resolution exactly per the Supplier Domain Constitution v1.2:
 *   taxId → KNOWN · phone → BELIEVED · neither → SELF_ANCHOR/UNKNOWN
 *   email/name are NEVER signals · convergence only by strong signal ·
 *   re-resolution is corrigible · deactivate never touches claims.
 */
import assert from "node:assert/strict";
import {
  PartyClaimConfidence,
  PartyClaimStatus,
  PartyResolutionMethod,
  PartyRoleType,
  PartySignalType,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { deleteTestBusinesses } from "@/lib/testing/cleanup-test-businesses";
import { supplierService } from "@/lib/services/inventory/supplier.service";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function createBusiness(label: string) {
  const business = await prisma.business.create({
    data: {
      name: `Supplier-PartyRole ${label} ${runId}`,
      users: {
        create: {
          email: `sp-party-${label}-${runId}@example.test`,
          password: "test-password",
          name: "Supplier Party Test User",
        },
      },
    },
  });
  return business.id;
}

function activeSupplierClaims(businessId: number, supplierId: number) {
  return prisma.partyResolutionClaim.findMany({
    where: {
      businessId,
      subjectType: PartyRoleType.SUPPLIER,
      subjectId: supplierId,
      status: PartyClaimStatus.ACTIVE,
    },
    orderBy: { id: "asc" },
  });
}

async function main() {
  const biz = await createBusiness("A");

  try {
    // 1. taxId → KNOWN TAX_ID claim
    const withTax = await supplierService.createSupplier({
      businessId: biz,
      name: "Tax Co",
      taxId: " 514999111 ",
      phone: null,
    });
    {
      const claims = await activeSupplierClaims(biz, withTax.id);
      const taxClaim = claims.find((c) => c.signalType === PartySignalType.TAX_ID);
      assert.ok(taxClaim, "taxId creates a TAX_ID claim");
      assert.equal(taxClaim!.confidence, PartyClaimConfidence.KNOWN, "taxId → KNOWN");
      assert.equal(taxClaim!.signalValue, "514999111", "taxId trimmed + stored");
    }

    // 2. phone only → BELIEVED PHONE claim
    const withPhone = await supplierService.createSupplier({
      businessId: biz,
      name: "Phone Co",
      phone: "050-1112233",
    });
    {
      const claims = await activeSupplierClaims(biz, withPhone.id);
      assert.equal(claims.length, 1, "phone-only: exactly one claim");
      assert.equal(claims[0].signalType, PartySignalType.PHONE, "phone signal");
      assert.equal(claims[0].confidence, PartyClaimConfidence.BELIEVED, "phone → BELIEVED");
    }

    // 3. neither signal → anchor (SELF_ANCHOR / UNKNOWN)
    const bare = await supplierService.createSupplier({ businessId: biz, name: "Bare Co" });
    {
      const claims = await activeSupplierClaims(biz, bare.id);
      assert.equal(claims.length, 1, "bare: one anchor claim");
      assert.equal(claims[0].signalType, null, "anchor has no signal");
      assert.equal(claims[0].confidence, PartyClaimConfidence.UNKNOWN, "anchor → UNKNOWN");
      assert.equal(claims[0].method, PartyResolutionMethod.SELF_ANCHOR, "anchor method");
    }

    // 4. email is NOT a signal
    const withEmail = await supplierService.createSupplier({
      businessId: biz,
      name: "Email Co",
      email: "orders@dist.test",
    });
    {
      const claims = await activeSupplierClaims(biz, withEmail.id);
      assert.equal(claims.length, 1, "email-only: anchor only");
      assert.equal(claims[0].signalType, null, "email is not a signal");
      assert.ok(
        !claims.some((c) => c.signalValue === "orders@dist.test"),
        "email value never stored as a signal"
      );
    }

    // 5. name is NOT a signal
    const named = await supplierService.createSupplier({ businessId: biz, name: "UniqueNameXYZ" });
    {
      const claims = await activeSupplierClaims(biz, named.id);
      assert.equal(claims[0].signalType, null, "name-only → anchor, not a signal");
      assert.ok(
        !claims.some((c) => c.signalValue === "UniqueNameXYZ"),
        "name value never stored as a signal"
      );
    }

    // 6. update adds then changes taxId → corrigible re-resolution
    const evolving = await supplierService.createSupplier({
      businessId: biz,
      name: "Evolve Co",
      phone: "052-7778899",
    });
    await supplierService.updateSupplier({
      businessId: biz,
      supplierId: evolving.id,
      taxId: "515222333",
    });
    {
      const claims = await activeSupplierClaims(biz, evolving.id);
      assert.ok(
        claims.some(
          (c) =>
            c.signalType === PartySignalType.TAX_ID &&
            c.confidence === PartyClaimConfidence.KNOWN
        ),
        "added taxId → KNOWN claim"
      );
      assert.ok(
        claims.some((c) => c.signalType === PartySignalType.PHONE),
        "phone claim retained"
      );
    }
    await supplierService.updateSupplier({
      businessId: biz,
      supplierId: evolving.id,
      taxId: "515444555",
    });
    {
      const active = await activeSupplierClaims(biz, evolving.id);
      assert.ok(
        active.some(
          (c) => c.signalType === PartySignalType.TAX_ID && c.signalValue === "515444555"
        ),
        "new taxId is active"
      );
      assert.ok(
        !active.some((c) => c.signalValue === "515222333"),
        "old taxId no longer active"
      );
      const retracted = await prisma.partyResolutionClaim.findMany({
        where: {
          businessId: biz,
          subjectType: PartyRoleType.SUPPLIER,
          subjectId: evolving.id,
          status: PartyClaimStatus.RETRACTED,
          signalValue: "515222333",
        },
      });
      assert.equal(retracted.length, 1, "old taxId retained as RETRACTED (corrigible, not deleted)");
    }

    // 7. deactivate does NOT touch claims
    const deact = await supplierService.createSupplier({
      businessId: biz,
      name: "Deact Co",
      taxId: "516333444",
    });
    const beforeClaims = await activeSupplierClaims(biz, deact.id);
    await supplierService.deactivateSupplier({ businessId: biz, supplierId: deact.id });
    const afterClaims = await activeSupplierClaims(biz, deact.id);
    assert.deepEqual(
      afterClaims.map((c) => c.id),
      beforeClaims.map((c) => c.id),
      "deactivate keeps the same active claims (none retracted/deleted)"
    );

    // 8a. convergence: same taxId → same Party
    const conv1 = await supplierService.createSupplier({
      businessId: biz,
      name: "Conv One",
      taxId: "999888777",
    });
    const conv2 = await supplierService.createSupplier({
      businessId: biz,
      name: "Conv Two Different Name",
      taxId: "999888777",
    });
    {
      const p1 = (await activeSupplierClaims(biz, conv1.id)).find(
        (c) => c.signalType === PartySignalType.TAX_ID
      )!.partyId;
      const p2 = (await activeSupplierClaims(biz, conv2.id)).find(
        (c) => c.signalType === PartySignalType.TAX_ID
      )!.partyId;
      assert.equal(p1, p2, "same taxId converges to the same Party");
    }

    // 8b. no over-merge: same name only → different Parties
    const n1 = await supplierService.createSupplier({ businessId: biz, name: "Same Name LLC" });
    const n2 = await supplierService.createSupplier({ businessId: biz, name: "Same Name LLC" });
    {
      const p1 = (await activeSupplierClaims(biz, n1.id))[0].partyId;
      const p2 = (await activeSupplierClaims(biz, n2.id))[0].partyId;
      assert.notEqual(p1, p2, "same name does NOT merge");
    }

    // 8c. no over-merge: same email only → different Parties
    const e1 = await supplierService.createSupplier({
      businessId: biz,
      name: "Email A",
      email: "shared@dist.test",
    });
    const e2 = await supplierService.createSupplier({
      businessId: biz,
      name: "Email B",
      email: "shared@dist.test",
    });
    {
      const p1 = (await activeSupplierClaims(biz, e1.id))[0].partyId;
      const p2 = (await activeSupplierClaims(biz, e2.id))[0].partyId;
      assert.notEqual(p1, p2, "same email does NOT merge");
    }

    console.log("supplier-party-resolution.service.test.ts: ok");
  } finally {
    await deleteTestBusinesses([biz]);
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
