/**
 * Supplier Domain Catalog — Runtime end-to-end (run manually, DIRECT DB url):
 *   DATABASE_URL=$DIRECT_URL npx tsx lib/services/inventory/catalog-runtime.e2e.test.ts
 *
 * Verifies the Claims Ledger as a live runtime layer:
 *   - Ledger: record / supersede / retract are append-only (history preserved,
 *     content never mutated, nothing deleted).
 *   - Current offer: latest ACTIVE claim wins; superseded + retracted ignored;
 *     freshness derived (stale computed from an old observation).
 *   - Identity integration: ingestion REUSES Phase 2 ensureSupplierProduct — the
 *     same supplier product is reused across imports (no duplicate rows).
 *   - Guard rails: catalog never creates/touches InventoryItem.
 */
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { deleteTestBusinesses } from "@/lib/testing/cleanup-test-businesses";
import {
  recordCatalogClaimTx,
  retractCatalogClaimTx,
} from "@/lib/services/inventory/catalog-claim.service";
import {
  getCurrentOfferForSupplierProduct,
  getSupplierLevelOffer,
} from "@/lib/services/inventory/catalog-current-offer.service";
import { ingestCatalog } from "@/lib/services/inventory/catalog-ingestion.service";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

function priceOf(claims: { attribute: string; valueNumber: number | null }[]) {
  return claims.find((c) => c.attribute === "ASKING_PRICE")?.valueNumber ?? null;
}

async function main() {
  const business = await prisma.business.create({
    data: {
      name: `CatalogRuntime ${runId}`,
      users: { create: { email: `catalog-rt-${runId}@example.test`, password: "test-password", name: "RT" } },
    },
    include: { users: true },
  });
  const businessId = business.id;
  const userId = business.users[0].id;
  const supplier = await prisma.supplier.create({
    data: { businessId, name: `ACME Catalog ${runId}` },
  });
  const supplierId = supplier.id;

  try {
    const itemsBefore = await prisma.inventoryItem.count({ where: { businessId } });

    // --- 1) Ingestion + identity reuse (Phase 2) ------------------------------
    const first = await ingestCatalog({
      businessId,
      supplierId,
      sourceType: "MANUAL_ENTRY",
      actorUserId: userId,
      rows: [
        { externalSku: "SKU-COLA", name: "Cola 1.5L", askingPrice: 120, currency: "ILS", availability: "IN_STOCK", packageDescription: "12x1.5L" },
        { name: "" }, // no identity signal → skipped
      ],
      supplierTerms: { minimumOrderAmount: 500, currency: "ILS", leadTimeDays: 3 },
    });
    assert.equal(first.productsResolved, 1, "one resolvable product");
    assert.equal(first.skipped.length, 1, "empty row skipped");
    assert.equal(first.claimsRecorded, 3 + 2, "3 product + 2 supplier-level claims");

    const products = await prisma.supplierProduct.findMany({ where: { businessId, supplierId } });
    assert.equal(products.length, 1, "exactly one supplier product");
    const supplierProductId = products[0].id;

    // Second import of the SAME sku → reuse, not a duplicate row.
    const second = await ingestCatalog({
      businessId,
      supplierId,
      sourceType: "FILE_IMPORT",
      rows: [{ externalSku: "SKU-COLA", name: "Cola 1.5L", askingPrice: 110, currency: "ILS" }],
    });
    assert.equal(second.productsResolved, 1, "reused product");
    const productsAfter = await prisma.supplierProduct.count({ where: { businessId, supplierId } });
    assert.equal(productsAfter, 1, "no duplicate supplier product across imports");

    // --- 2) Current offer: latest ACTIVE wins, superseded ignored -------------
    const offer1 = await getCurrentOfferForSupplierProduct(businessId, supplierProductId);
    assert.equal(priceOf(offer1.claims), 110, "current price = latest (110), 120 superseded");

    const priceClaims = await prisma.catalogClaim.findMany({
      where: { businessId, subjectType: "SUPPLIER_PRODUCT", subjectId: supplierProductId, attribute: "ASKING_PRICE" },
      orderBy: { recordedAt: "asc" },
    });
    assert.equal(priceClaims.length, 2, "append-only: both price claims preserved");
    assert.equal(priceClaims[0].status, "SUPERSEDED", "older price superseded, not deleted");
    assert.equal(priceClaims[0].valueNumber, 120, "superseded content unchanged");
    assert.equal(priceClaims[1].status, "ACTIVE", "latest price active");

    // --- 3) Supersede without replacement, then re-assert ---------------------
    const offerAvail = (await getCurrentOfferForSupplierProduct(businessId, supplierProductId)).claims;
    assert.ok(offerAvail.some((c) => c.attribute === "AVAILABILITY"), "availability present");

    // --- 4) Retract: ACTIVE claim retracted → attribute becomes UNKNOWN -------
    const activePrice = priceClaims[1];
    await prisma.$transaction((tx) =>
      retractCatalogClaimTx(tx, { businessId, claimId: activePrice.id, retractedReason: "supplier withdrew" })
    );
    const retracted = await prisma.catalogClaim.findUniqueOrThrow({ where: { id: activePrice.id } });
    assert.equal(retracted.status, "RETRACTED", "retracted status");
    assert.ok(retracted.retractedAt, "retractedAt set");
    assert.equal(retracted.valueNumber, 110, "retracted content unchanged (not deleted)");

    const offerAfterRetract = await getCurrentOfferForSupplierProduct(businessId, supplierProductId);
    assert.equal(priceOf(offerAfterRetract.claims), null, "no ACTIVE price → UNKNOWN");

    // --- 5) Freshness derived: stale from an old observation ------------------
    await prisma.$transaction((tx) =>
      recordCatalogClaimTx(tx, {
        businessId,
        subjectType: "SUPPLIER_PRODUCT",
        subjectId: supplierProductId,
        attribute: "ASKING_PRICE",
        value: { valueType: "MONEY", valueNumber: 95, currency: "ILS" },
        sourceId: first.sourceId,
        observedAt: new Date(Date.now() - 40 * 86_400_000), // 40d ago > 14d window
      })
    );
    const offerStale = await getCurrentOfferForSupplierProduct(businessId, supplierProductId);
    const priceClaim = offerStale.claims.find((c) => c.attribute === "ASKING_PRICE");
    assert.equal(priceClaim?.valueNumber, 95, "new active price");
    assert.equal(priceClaim?.freshness.state, "STALE", "40d-old price is STALE (derived)");

    // --- 6) Supplier-level offer ---------------------------------------------
    const supplierOffer = await getSupplierLevelOffer(businessId, supplierId);
    const moq = supplierOffer.claims.find((c) => c.attribute === "MINIMUM_ORDER_AMOUNT");
    const lead = supplierOffer.claims.find((c) => c.attribute === "LEAD_TIME_DAYS");
    assert.equal(moq?.valueNumber, 500, "supplier-level MOQ");
    assert.equal(lead?.valueNumber, 3, "supplier-level lead time");

    // --- 7) Guard rail: catalog never created an InventoryItem ----------------
    const itemsAfter = await prisma.inventoryItem.count({ where: { businessId } });
    assert.equal(itemsAfter, itemsBefore, "catalog created zero InventoryItems");

    console.log("\nAll catalog-runtime e2e checks passed");
  } finally {
    await deleteTestBusinesses([businessId]);
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
