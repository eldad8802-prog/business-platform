/**
 * P1 offering foundation — database invariants.
 *   TEST_DATABASE_URL="postgres://…test…" npx tsx lib/services/offering/offering.db.test.ts
 *
 * Refuses Production. Does not infer historical service links.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
if (!TEST_DB || !/^postgres(ql)?:\/\//i.test(TEST_DB)) {
  console.error("ABORT: set TEST_DATABASE_URL to a non-production Postgres URL.");
  process.exit(1);
}
let testHost = "";
try {
  testHost = new URL(TEST_DB).hostname;
} catch {
  testHost = "";
}
if (testHost.includes("ep-flat-brook")) {
  console.error("ABORT: TEST_DATABASE_URL is the Production endpoint.");
  process.exit(1);
}
process.env.DATABASE_URL = TEST_DB;

let failed = 0;
function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

const TAG = `qa-p1-offering-${Date.now()}`;

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { createBusinessService, linkServiceAsset, listOfferings } = await import(
    "./business-service.service"
  );
  const { OfferingNotFoundError } = await import("./business-service.service");
  const { recordOfferingDemand } = await import("./offering-demand");
  const { create } = await import("@/lib/services/appointment/appointment.service");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");

  const a = await prisma.business.create({ data: { name: `${TAG}-A` } });
  const b = await prisma.business.create({ data: { name: `${TAG}-B` } });
  const user = await prisma.user.create({
    data: { email: `${TAG}@example.test`, password: "not-a-real-password", businessId: a.id },
  });

  try {
    await prisma.$executeRaw`
      INSERT INTO "InventoryItem"
        ("businessId", "name", "unitType", "currentQuantity", "minimumQuantity", "isActive", "createdAt", "updatedAt")
      VALUES (${a.id}, 'old item', 'UNIT'::"InventoryUnitType", 4, 0, true, NOW(), NOW())
    `;
    const oldItem = await prisma.inventoryItem.findFirst({ where: { businessId: a.id, name: "old item" } });
    ok("old item insert still succeeds", oldItem !== null);
    ok("old item leaves description unknown", oldItem?.description === null);
    ok("old item is not featured", oldItem?.featuredByOwner === false);

    await prisma.$executeRaw`
      INSERT INTO "Appointment"
        ("businessId", "status", "createdByActor", "sourceChannel", "createdByUserId", "createdAt", "updatedAt")
      VALUES (
        ${a.id},
        'PROPOSED'::"AppointmentStatus",
        'OWNER'::"CreatedByActor",
        'INBOX_WEB'::"SourceChannel",
        ${user.id},
        NOW(),
        NOW()
      )
    `;
    const oldAppointment = await prisma.appointment.findFirst({
      where: { businessId: a.id, createdByUserId: user.id, businessServiceId: null, title: null },
    });
    ok("old appointment insert still succeeds", oldAppointment !== null);
    ok("old appointment has no service", oldAppointment?.businessServiceId === null);

    await prisma.$executeRaw`
      INSERT INTO "BusinessService" ("businessId", "name", "type", "basePrice", "active", "createdAt", "updatedAt")
      VALUES (${a.id}, 'old writer', 'SERVICE'::"BusinessServiceType", 10, true, NOW(), NOW())
    `;
    const oldWriter = await prisma.businessService.findFirst({
      where: { businessId: a.id, name: "old writer" },
    });
    ok("old column list still inserts", oldWriter !== null);
    ok("old writer leaves the price mode unknown", oldWriter?.priceMode === null);
    ok("old writer does not feature the service", oldWriter?.featuredByOwner === false);

    const legacy = await prisma.businessService.create({
      data: {
        businessId: a.id,
        name: "שירות ישן",
        type: "SERVICE",
        basePrice: 180,
      },
    });
    ok("legacy service insert still succeeds", legacy.id > 0);
    ok("legacy base price is not a price mode", legacy.priceMode === null && legacy.priceAmount === null);
    ok("legacy service is not featured", legacy.featuredByOwner === false);

    const quoted = await tenantTx(a.id, (tx) =>
      createBusinessService(
        {
          businessId: a.id,
          name: "ייעוץ",
          description: "שיחת היכרות",
          categoryLabel: "משפט",
          price: { priceMode: "QUOTE_REQUIRED" },
          fulfillment: "ONLINE",
        },
        tx
      )
    );
    ok("quote-required stores no amount", quoted.priceMode === "QUOTE_REQUIRED" && quoted.priceAmount === null);

    const free = await tenantTx(a.id, (tx) =>
      createBusinessService(
        {
          businessId: a.id,
          name: "בדיקה",
          price: { priceMode: "FIXED", priceAmount: 0 },
          durationMinutes: 30,
          featuredByOwner: true,
          fulfillment: "AT_BUSINESS",
        },
        tx
      )
    );
    ok("zero is a real fixed price", free.priceAmount?.toFixed(2) === "0.00");
    ok("duration is stored when supplied", free.durationMinutes === 30);

    let zeroQuote = false;
    try {
      await tenantTx(a.id, (tx) =>
        createBusinessService(
          { businessId: a.id, name: "לא", price: { priceMode: "QUOTE_REQUIRED", priceAmount: 0 } },
          tx
        )
      );
    } catch {
      zeroQuote = true;
    }
    ok("zero is not accepted as ask-for-price", zeroQuote);

    const assetA = await prisma.businessAsset.create({
      data: {
        businessId: a.id,
        origin: "OWNER_UPLOAD",
        storageKey: `${TAG}-a`,
        publicUseApproved: false,
      },
    });
    const assetB = await prisma.businessAsset.create({
      data: {
        businessId: b.id,
        origin: "OWNER_UPLOAD",
        storageKey: `${TAG}-b`,
      },
    });
    const linked = await tenantTx(a.id, (tx) =>
      linkServiceAsset({ businessId: a.id, businessServiceId: free.id, businessAssetId: assetA.id }, tx)
    );
    ok("asset link does not approve public use", linked.publicUseApproved === false);
    const assetAfter = await prisma.businessAsset.findUnique({ where: { id: assetA.id } });
    ok("public approval stays false", assetAfter?.publicUseApproved === false);

    let foreignAsset = false;
    try {
      await tenantTx(a.id, (tx) =>
        linkServiceAsset({ businessId: a.id, businessServiceId: free.id, businessAssetId: assetB.id }, tx)
      );
    } catch (error) {
      foreignAsset = error instanceof OfferingNotFoundError;
    }
    ok("cross-tenant asset link is refused", foreignAsset);

    const serviceB = await prisma.businessService.create({
      data: { businessId: b.id, name: "שירות ב", type: "SERVICE", priceMode: "NO_PUBLIC_PRICE" },
    });
    const booked = await create({
      businessId: a.id,
      actor: { actor: "OWNER", userId: user.id, sourceChannel: "INBOX_WEB" },
      links: { businessServiceId: free.id },
    });
    ok("appointment keeps the selected service", booked.ok && booked.appointment.businessServiceId === free.id);
    const signals = await prisma.offeringDemandSignal.findMany({
      where: { businessId: a.id, businessServiceId: free.id },
    });
    ok("booking writes one demand signal", signals.length === 1 && signals[0]?.signalType === "BOOKING");
    ok("booking key is the appointment", signals[0]?.idempotencyKey === `booking:appointment:${booked.appointment.id}`);
    const bookingAgain = await tenantTx(a.id, (tx) =>
      recordOfferingDemand(tx, {
        businessId: a.id,
        kind: "SERVICE",
        offeringId: free.id,
        signalType: "BOOKING",
        source: "APPOINTMENT",
        appointmentId: booked.appointment.id,
        idempotencyKey: `booking:appointment:${booked.appointment.id}`,
      })
    );
    const bookingCount = await prisma.offeringDemandSignal.count({
      where: { businessId: a.id, appointmentId: booked.appointment.id },
    });
    ok("retrying the same booking does not add a signal", bookingAgain?.id === signals[0]?.id && bookingCount === 1);
    ok("demand signal has no customer fields", !("phone" in signals[0]!) && !("message" in signals[0]!));

    const foreignBooking = await create({
      businessId: a.id,
      actor: { actor: "OWNER", userId: user.id, sourceChannel: "INBOX_WEB" },
      links: { businessServiceId: serviceB.id },
      details: { title: "תיקון מזגן" },
    });
    ok("cross-tenant service link is refused", !foreignBooking.ok && foreignBooking.reason === "service_not_found");
    const untouched = await prisma.appointment.count({
      where: { businessId: a.id, title: "תיקון מזגן" },
    });
    ok("similar free text did not create an appointment", untouched === 0);

    const hinted = await create({
      businessId: a.id,
      actor: { actor: "OWNER", userId: user.id, sourceChannel: "INBOX_WEB" },
      details: { title: "ייעוץ" },
    });
    ok("matching title does not attach a service", hinted.ok && hinted.appointment.businessServiceId === null);
    const hintedSignals = await prisma.offeringDemandSignal.count({
      where: { businessId: a.id, appointmentId: hinted.ok ? hinted.appointment.id : -1 },
    });
    ok("free-text appointment writes no booking signal", hintedSignals === 0);

    const foreignDemand = await tenantTx(a.id, (tx) =>
      recordOfferingDemand(tx, {
        businessId: a.id,
        kind: "SERVICE",
        offeringId: serviceB.id,
        signalType: "PRICE",
        source: "APPOINTMENT",
        idempotencyKey: `${TAG}-foreign-price`,
      })
    );
    ok("cross-tenant demand signal is refused", foreignDemand === null);
    const bSignals = await prisma.offeringDemandSignal.count({ where: { businessId: b.id } });
    ok("the other business has no demand rows", bSignals === 0);

    let foreignFk = false;
    try {
      await prisma.offeringDemandSignal.create({
        data: {
          businessId: a.id,
          offeringKind: "SERVICE",
          businessServiceId: serviceB.id,
          signalType: "PRICE",
          source: "APPOINTMENT",
          idempotencyKey: `${TAG}-foreign-fk`,
        },
      });
    } catch {
      foreignFk = true;
    }
    ok("database rejects a demand row aimed at another tenant's service", foreignFk);

    const fromPrice = await tenantTx(a.id, (tx) =>
      createBusinessService(
        { businessId: a.id, name: "החל מ", price: { priceMode: "FROM", priceAmount: 50 }, fulfillment: "AT_CUSTOMER" },
        tx
      )
    );
    const rangePrice = await tenantTx(a.id, (tx) =>
      createBusinessService(
        {
          businessId: a.id,
          name: "טווח",
          price: { priceMode: "RANGE", priceAmount: 80, priceMax: 120 },
        },
        tx
      )
    );
    const hidden = await tenantTx(a.id, (tx) =>
      createBusinessService(
        { businessId: a.id, name: "בלי מחיר", price: { priceMode: "NO_PUBLIC_PRICE" } },
        tx
      )
    );
    ok("FROM stores the lower amount only", fromPrice.priceMode === "FROM" && fromPrice.priceAmount?.toFixed(2) === "50.00" && fromPrice.priceMax === null);
    ok("RANGE stores both ends", rangePrice.priceAmount?.toFixed(2) === "80.00" && rangePrice.priceMax?.toFixed(2) === "120.00");
    ok("NO_PUBLIC_PRICE stores no amount", hidden.priceMode === "NO_PUBLIC_PRICE" && hidden.priceAmount === null);

    const { recordInventorySale } = await import("@/lib/services/inventory/sale-evidence.service");
    const { linkProductAsset } = await import("./business-service.service");
    const item = await prisma.inventoryItem.create({
      data: {
        businessId: a.id,
        name: "שמפו",
        description: "לשיער צבוע",
        featuredByOwner: true,
        unitType: "UNIT",
        currentQuantity: 5,
        sellPricePerUnit: 0,
      },
    });
    const saleKey = `${TAG}-sale`;
    const firstSale = await recordInventorySale({
      businessId: a.id,
      source: "MANUAL",
      idempotencyKey: saleKey,
      lines: [{ itemId: item.id, quantity: 1, unitPrice: "0.00", lineKey: "1" }],
    });
    const secondSale = await recordInventorySale({
      businessId: a.id,
      source: "MANUAL",
      idempotencyKey: saleKey,
      lines: [{ itemId: item.id, quantity: 1, unitPrice: "0.00", lineKey: "1" }],
    });
    const purchaseSignals = await prisma.offeringDemandSignal.findMany({
      where: { businessId: a.id, inventoryItemId: item.id, signalType: "PURCHASE" },
    });
    ok("one sale writes one purchase signal", firstSale.created && purchaseSignals.length === 1);
    ok("sale retry does not write another purchase signal", secondSale.created === false && purchaseSignals.length === 1);
    ok("purchase key is the sale line", purchaseSignals[0]?.idempotencyKey.startsWith("purchase:sale-line:") === true);
    const separate = await recordInventorySale({
      businessId: a.id,
      source: "MANUAL",
      idempotencyKey: `${saleKey}-2`,
      lines: [{ itemId: item.id, quantity: 1, unitPrice: "0.00", lineKey: "1" }],
    });
    const purchaseCount = await prisma.offeringDemandSignal.count({
      where: { businessId: a.id, inventoryItemId: item.id, signalType: "PURCHASE" },
    });
    ok("a second real sale writes a second purchase signal", separate.created && purchaseCount === 2);

    await prisma.inventorySourceSaleLine.create({
      data: {
        businessId: a.id,
        externalSaleId: `${TAG}-unmatched`,
        lineKey: "loose",
        name: "שמפו",
        quantity: 1,
        unitPrice: "10.00",
      },
    });
    ok("an unmatched source line does not add purchase demand", purchaseCount === 2);

    const productLink = await tenantTx(a.id, (tx) =>
      linkProductAsset({ businessId: a.id, inventoryItemId: item.id, businessAssetId: assetA.id }, tx)
    );
    ok("product asset link does not approve public use", productLink.publicUseApproved === false);
    let foreignProductAsset = false;
    try {
      await tenantTx(a.id, (tx) =>
        linkProductAsset({ businessId: a.id, inventoryItemId: item.id, businessAssetId: assetB.id }, tx)
      );
    } catch (error) {
      foreignProductAsset = error instanceof OfferingNotFoundError;
    }
    ok("cross-tenant product asset link is refused", foreignProductAsset);

    await prisma.businessService.update({ where: { id: free.id }, data: { active: false } });
    const signalsAfterDeactivate = await prisma.offeringDemandSignal.count({
      where: { businessId: a.id, businessServiceId: free.id },
    });
    ok("deactivating a service keeps its booking evidence", signalsAfterDeactivate === 1);

    const offerings = await tenantTx(a.id, (tx) => listOfferings(a.id, tx));
    const projectedLegacy = offerings.find((row) => row.canonicalId === legacy.id && row.kind === "SERVICE");
    ok("projection leaves the legacy price unknown", projectedLegacy?.priceMode === null);
    const projectedFree = offerings.find((row) => row.canonicalId === free.id && row.kind === "SERVICE");
    ok("projection keeps owner emphasis", projectedFree?.featuredByOwner === true);
    ok("projection lists the linked asset", projectedFree?.assetIds.includes(assetA.id) === true);

    const projectedProduct = offerings.find((row) => row.kind === "PRODUCT" && row.canonicalId === item.id);
    ok("hybrid projection keeps the product", projectedProduct?.kind === "PRODUCT");
    ok("product zero price stays FIXED", projectedProduct?.priceMode === "FIXED" && projectedProduct.priceAmount === "0.00");
    ok("product description is kept", projectedProduct?.description === "לשיער צבוע");
    ok("product has no duration or fulfillment", projectedProduct?.durationMinutes === null && projectedProduct.fulfillment === null);
    ok("service projection keeps duration", projectedFree?.durationMinutes === 30 && projectedFree?.fulfillment === "AT_BUSINESS");
    ok("product asset is listed", projectedProduct?.assetIds.includes(assetA.id) === true);

    const bView = await tenantTx(b.id, (tx) => listOfferings(b.id, tx));
    ok(
      "cross-tenant offering read is empty for the other catalog",
      bView.every((row) => row.businessId === b.id) && !bView.some((row) => row.canonicalId === free.id && row.kind === "SERVICE")
    );
  } finally {
    await prisma.offeringDemandSignal.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.appointment.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.businessServiceAsset.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.inventoryItemAsset.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.inventorySaleLine.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.inventorySale.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.inventoryMovement.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.inventorySourceSaleLine.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.inventoryItem.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.businessAsset.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.businessService.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.user.deleteMany({ where: { businessId: a.id } });
    await prisma.business.deleteMany({ where: { id: { in: [a.id, b.id] } } });
    await prisma.$disconnect();
  }

  if (failed > 0) {
    console.error(`P1 offering DB: ${failed} failed`);
    process.exit(1);
  }
  console.log("P1 offering DB: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
