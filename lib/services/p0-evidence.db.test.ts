/**
 * P0 evidence — database invariants.
 *   TEST_DATABASE_URL="postgres://…test…" npx tsx lib/services/p0-evidence.db.test.ts
 *
 * Refuses the ambient DATABASE_URL. Apply
 * prisma/migrations/20260926120000_p0_business_evidence first on that test database.
 * Does not touch production by itself.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
if (!TEST_DB || !/^postgres(ql)?:\/\//i.test(TEST_DB)) {
  console.error(
    "ABORT (DB safety guard): set TEST_DATABASE_URL to an approved, non-production " +
      "test/dev Postgres URL. Refusing to seed/delete against the ambient DATABASE_URL."
  );
  process.exit(1);
}
let testHost = "";
try {
  testHost = new URL(TEST_DB).hostname;
} catch {
  testHost = "";
}
if (testHost.includes("ep-flat-brook")) {
  console.error("ABORT (DB safety guard): TEST_DATABASE_URL is the Production endpoint.");
  process.exit(1);
}
process.env.DATABASE_URL = TEST_DB;

import { Prisma } from "@prisma/client";
import { dateInDays } from "@/components/coupon/coupon-model";

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

const TAG = `qa-p0-evidence-${Date.now()}`;
let aId = 0;
let bId = 0;

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { recordInventorySale } = await import("@/lib/services/inventory/sale-evidence.service");
  const { InventoryUnauthorizedError } = await import("@/lib/services/inventory/inventory.errors");
  const { recordContentDecision, CONTENT_EVENT_VARIANT_SELECTED, CONTENT_EVENT_CONTENT_EDITED, ContentDecisionNotFoundError } =
    await import("@/lib/services/content/content-decision.evidence");
  const { publishCoupon } = await import("@/lib/services/revenue/publish-coupon.service");
  const { getPublicCouponDetails } = await import("@/lib/services/revenue/coupon-details-public.service");
  const { logAuditEvent } = await import("@/lib/services/audit.service");

  const a = await prisma.business.create({ data: { name: `${TAG}-A` } });
  const b = await prisma.business.create({ data: { name: `${TAG}-B` } });
  aId = a.id;
  bId = b.id;
  const user = await prisma.user.create({
    data: {
      email: `${TAG}@example.test`,
      password: "not-a-real-password",
      businessId: aId,
    },
  });

  const itemA = await prisma.inventoryItem.create({
    data: {
      businessId: aId,
      name: "Item A",
      unitType: "UNIT",
      currentQuantity: 10,
      sellPricePerUnit: 999,
    },
  });
  const itemB = await prisma.inventoryItem.create({
    data: {
      businessId: bId,
      name: "Item B",
      unitType: "UNIT",
      currentQuantity: 10,
      sellPricePerUnit: 5,
    },
  });

  const first = await recordInventorySale({
    businessId: aId,
    source: "POS",
    externalSaleId: `${TAG}-ext`,
    lines: [{ itemId: itemA.id, quantity: 2, unitPrice: "59.90", lineKey: "0" }],
  });
  ok("sale: evidence written once", first.created === true && first.movements.length === 1);
  const line = await prisma.inventorySaleLine.findFirst({
    where: { businessId: aId, saleId: first.saleId },
  });
  ok("sale: unit price preserved", line?.unitPrice?.toFixed(2) === "59.90");
  ok("sale: movement linked", line?.movementId === first.movements[0]?.id);
  const sale = await prisma.inventorySale.findUnique({ where: { id: first.saleId } });
  ok("sale: external id preserved", sale?.externalSaleId === `${TAG}-ext`);
  const stockAfter = await prisma.inventoryItem.findUnique({ where: { id: itemA.id } });
  ok("sale: stock decreased by the sold quantity", stockAfter?.currentQuantity === 8);

  const retry = await recordInventorySale({
    businessId: aId,
    source: "POS",
    externalSaleId: `${TAG}-ext`,
    lines: [{ itemId: itemA.id, quantity: 2, unitPrice: "59.90", lineKey: "0" }],
  });
  ok("sale: retry does not create another sale", retry.created === false && retry.saleId === first.saleId);
  const stockAfterRetry = await prisma.inventoryItem.findUnique({ where: { id: itemA.id } });
  ok("sale: retry does not move stock again", stockAfterRetry?.currentQuantity === 8);
  const lineCount = await prisma.inventorySaleLine.count({ where: { businessId: aId } });
  ok("sale: retry does not duplicate lines", lineCount === 1);
  const externalCount = await prisma.inventoryExternalSale.count({
    where: { businessId: aId, externalSaleId: `${TAG}-ext` },
  });
  ok("sale: retry does not duplicate the external sale row", externalCount === 1);

  const unpriced = await recordInventorySale({
    businessId: aId,
    source: "MANUAL",
    idempotencyKey: `${TAG}-manual`,
    lines: [{ itemId: itemA.id, quantity: 1, unitPrice: null, lineKey: "0" }],
  });
  const unpricedLine = await prisma.inventorySaleLine.findFirst({
    where: { saleId: unpriced.saleId },
  });
  ok("sale: missing price stays null", unpricedLine?.unitPrice === null);
  ok("sale: null price is not the catalog price", unpricedLine?.unitPrice?.toNumber() !== 999);

  const manualRetry = await recordInventorySale({
    businessId: aId,
    source: "MANUAL",
    idempotencyKey: `${TAG}-manual`,
    lines: [{ itemId: itemA.id, quantity: 1, unitPrice: null, lineKey: "0" }],
  });
  ok("manual sale: same idempotency key does not sell again", manualRetry.created === false);
  const stockAfterManual = await prisma.inventoryItem.findUnique({ where: { id: itemA.id } });
  ok("manual sale: stock moved only once for that key", stockAfterManual?.currentQuantity === 7);

  const zero = await recordInventorySale({
    businessId: aId,
    source: "MANUAL",
    idempotencyKey: `${TAG}-zero`,
    lines: [{ itemId: itemA.id, quantity: 1, unitPrice: "0.00", lineKey: "0" }],
  });
  const zeroLine = await prisma.inventorySaleLine.findFirst({ where: { saleId: zero.saleId } });
  ok("sale: zero charged price is stored as zero", zeroLine?.unitPrice?.toFixed(2) === "0.00");
  ok("sale: zero is not replaced by the catalog price", zeroLine?.unitPrice?.toNumber() !== 999);

  let crossTenantRefused = false;
  try {
    await recordInventorySale({
      businessId: aId,
      source: "MANUAL",
      lines: [{ itemId: itemB.id, quantity: 1, unitPrice: "1.00", lineKey: "0" }],
    });
  } catch (error) {
    crossTenantRefused = error instanceof InventoryUnauthorizedError;
  }
  ok("sale: cross-tenant item reference is refused", crossTenantRefused);
  const bStock = await prisma.inventoryItem.findUnique({ where: { id: itemB.id } });
  ok("sale: business B stock was not touched", bStock?.currentQuantity === 10);
  const foreignLines = await prisma.inventorySaleLine.count({ where: { businessId: bId } });
  ok("sale: business B has no sale evidence from A's attempt", foreignLines === 0);

  const spareMovement = await prisma.inventoryMovement.create({
    data: {
      businessId: aId,
      itemId: itemA.id,
      movementType: "ADJUSTMENT",
      reason: "INVENTORY_COUNT_CORRECTION",
      quantityDelta: 0.01,
      quantityBefore: 8,
      quantityAfter: 8.01,
    },
  });
  let fkRefused = false;
  try {
    await prisma.inventorySaleLine.create({
      data: {
        businessId: aId,
        saleId: first.saleId,
        itemId: itemB.id,
        movementId: spareMovement.id,
        lineKey: "foreign",
        quantity: 1,
        unitPrice: new Prisma.Decimal("1.00"),
      },
    });
  } catch {
    fkRefused = true;
  }
  ok("sale: database rejects a line that points at another tenant's item", fkRefused);

  const run = await prisma.contentRun.create({
    data: {
      businessId: aId,
      createdByUserId: user.id,
      status: "COMPLETED",
      inputSnapshot: { schemaVersion: 1, generatedAt: new Date().toISOString(), source: "user", data: {} },
    },
  });
  const variant = await prisma.contentVariant.create({
    data: {
      contentRunId: run.id,
      businessId: aId,
      variantKey: "trust",
      status: "READY",
      creativeDna: {},
      creativeBlueprint: {},
      renderBlueprint: {},
      creativeScore: {},
      growthSemantics: {},
    },
  });
  const script = "THIS SCRIPT MUST NOT BE STORED ON THE EVENT";
  const selected = await recordContentDecision({
    businessId: aId,
    actorUserId: user.id,
    contentRunId: run.id,
    variantKey: "trust",
    eventType: CONTENT_EVENT_VARIANT_SELECTED,
  });
  const selectedAgain = await recordContentDecision({
    businessId: aId,
    actorUserId: user.id,
    contentRunId: run.id,
    variantKey: "trust",
    eventType: CONTENT_EVENT_VARIANT_SELECTED,
  });
  ok("content: selection is durable", selected.created === true);
  ok("content: selection retry is the same event", selectedAgain.created === false && selectedAgain.eventId === selected.eventId);

  await prisma.contentVariant.create({
    data: {
      contentRunId: run.id,
      businessId: aId,
      variantKey: "direct",
      status: "READY",
      creativeDna: {},
      creativeBlueprint: {},
      renderBlueprint: {},
      creativeScore: {},
      growthSemantics: {},
    },
  });
  const other = await recordContentDecision({
    businessId: aId,
    actorUserId: user.id,
    contentRunId: run.id,
    variantKey: "direct",
    eventType: CONTENT_EVENT_VARIANT_SELECTED,
  });
  ok("content: a different variant is a distinct event", other.created === true && other.eventId !== selected.eventId);
  const selectionCount = await prisma.contentEvent.count({
    where: { businessId: aId, eventType: CONTENT_EVENT_VARIANT_SELECTED },
  });
  ok("content: retry did not duplicate the decision", selectionCount === 2);
  const stored = await prisma.contentEvent.findUnique({ where: { id: selected.eventId } });
  ok("content: selection payload does not copy script text", !JSON.stringify(stored?.payload).includes(script));

  await recordContentDecision({
    businessId: aId,
    actorUserId: user.id,
    contentRunId: run.id,
    variantKey: "trust",
    eventType: CONTENT_EVENT_CONTENT_EDITED,
  });
  const edited = await prisma.contentEvent.findFirst({
    where: { businessId: aId, eventType: CONTENT_EVENT_CONTENT_EDITED },
  });
  ok("content: edit event exists without the script", edited !== null && !JSON.stringify(edited?.payload).includes(script));

  const runB = await prisma.contentRun.create({
    data: {
      businessId: bId,
      status: "COMPLETED",
      inputSnapshot: { schemaVersion: 1, generatedAt: new Date().toISOString(), source: "user", data: {} },
    },
  });
  await prisma.contentVariant.create({
    data: {
      contentRunId: runB.id,
      businessId: bId,
      variantKey: "direct",
      status: "READY",
      creativeDna: {},
      creativeBlueprint: {},
      renderBlueprint: {},
      creativeScore: {},
      growthSemantics: {},
    },
  });
  let foreignDecision = false;
  try {
    await recordContentDecision({
      businessId: aId,
      actorUserId: user.id,
      contentRunId: runB.id,
      variantKey: "direct",
      eventType: CONTENT_EVENT_VARIANT_SELECTED,
    });
  } catch (error) {
    foreignDecision = error instanceof ContentDecisionNotFoundError;
  }
  ok("content: business A cannot record a decision on business B's run", foreignDecision);
  const bEvents = await prisma.contentEvent.count({ where: { businessId: bId } });
  ok("content: business B has no decision events", bEvents === 0);

  let triggerRefused = false;
  try {
    await prisma.contentEvent.create({
      data: {
        businessId: aId,
        contentRunId: runB.id,
        eventType: CONTENT_EVENT_VARIANT_SELECTED,
        idempotencyKey: `${TAG}-cross`,
        payload: { schemaVersion: 1, source: "user", data: { variantKey: "direct" } },
      },
    });
  } catch {
    triggerRefused = true;
  }
  ok("content: database rejects an event that references another tenant's run", triggerRefused);

  const legacyRows = await prisma.$queryRawUnsafe<{ id: number; businessId: number }[]>(
    `INSERT INTO "ContentVariant" (
       "contentRunId", "variantKey", "status",
       "creativeDna", "creativeBlueprint", "renderBlueprint",
       "creativeScore", "growthSemantics", "updatedAt"
     ) VALUES (
       $1, $2, 'READY'::"ContentVariantStatus",
       '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
       '{}'::jsonb, '{}'::jsonb, NOW()
     ) RETURNING "id", "businessId"`,
    run.id,
    `${TAG}-legacy-variant`
  );
  ok(
    "content: old writer omits businessId and inherits the run",
    legacyRows[0]?.businessId === aId
  );
  let legacyMismatch = false;
  try {
    await prisma.$queryRawUnsafe(
      `INSERT INTO "ContentVariant" (
         "contentRunId", "businessId", "variantKey", "status",
         "creativeDna", "creativeBlueprint", "renderBlueprint",
         "creativeScore", "growthSemantics", "updatedAt"
       ) VALUES (
         $1, $2, $3, 'READY'::"ContentVariantStatus",
         '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
         '{}'::jsonb, '{}'::jsonb, NOW()
       )`,
      run.id,
      bId,
      `${TAG}-mismatch`
    );
  } catch {
    legacyMismatch = true;
  }
  ok("content: supplied foreign businessId is refused", legacyMismatch);
  let relinkRefused = false;
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE "ContentVariant" SET "contentRunId" = $1 WHERE "id" = $2`,
      runB.id,
      legacyRows[0].id
    );
  } catch {
    relinkRefused = true;
  }
  ok("content: variant cannot move onto another tenant's run", relinkRefused);
  let reassignRefused = false;
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE "ContentVariant" SET "businessId" = $1 WHERE "id" = $2`,
      bId,
      legacyRows[0].id
    );
  } catch {
    reassignRefused = true;
  }
  ok("content: variant tenant cannot be reassigned", reassignRefused);
  const legacyUntil = new Date(dateInDays(7) + "T00:00:00.000Z");
  const legacyOffer = await prisma.offer.create({
    data: {
      issuingBusinessId: aId,
      title: `${TAG}-legacy-offer`,
      customerBenefitText: "legacy benefit",
      validUntil: legacyUntil,
      coupons: {
        create: {
          issuingBusinessId: aId,
          token: `${TAG}-legacy-token`,
          qrValue: `${TAG}-legacy-qr`,
          expiresAt: legacyUntil,
          status: "ACTIVE",
        },
      },
    },
  });
  ok("coupon: old writer leaves structured benefit fields null", legacyOffer.benefitType === null);
  const legacyItem = await prisma.inventoryItem.findUnique({ where: { id: itemA.id } });
  ok("inventory: existing item remains readable", legacyItem?.businessId === aId && legacyItem.currentQuantity === 6);

  const published = await publishCoupon({
    businessId: aId,
    benefitType: "pct",
    value: "20",
    scope: "כל העסק",
    minPurchaseEnabled: true,
    minPurchaseRaw: "100",
    newCustomersOnly: true,
    validUntilDate: dateInDays(14),
    baseUrl: "https://qa.dubiz.test",
  });
  await prisma.learningEvent.deleteMany({ where: { businessId: aId } });
  const offer = await prisma.offer.findUnique({ where: { id: published.offerId } });
  ok("coupon: benefit type survives without the audit row", offer?.benefitType === "pct");
  ok("coupon: benefit value survives without the audit row", offer?.benefitValue === "20");
  ok("coupon: scope survives without the audit row", offer?.benefitScope === "כל העסק");
  ok("coupon: minimum survives without the audit row", offer?.minPurchaseAmount?.toFixed(2) === "100.00");
  ok("coupon: new-customers flag survives without the audit row", offer?.newCustomersOnly === true);

  await logAuditEvent({
    businessId: aId,
    eventType: "REVENUE_COUPON_PUBLISHED",
    entityType: "COUPON",
    payload: { benefitType: "amt" },
  });
  const offerAfterAudit = await prisma.offer.findUnique({ where: { id: published.offerId } });
  ok("coupon: a later audit payload does not rewrite canonical semantics", offerAfterAudit?.benefitType === "pct");

  const viewsBeforeServe = await prisma.couponSurfaceEvent.count({
    where: { issuingBusinessId: aId, eventType: "COUPON_PUBLIC_DETAIL_SERVED" },
  });
  ok("coupon: publishing the offer does not invent a serve", viewsBeforeServe === 0);
  await getPublicCouponDetails(published.publicId);
  const views = await prisma.couponSurfaceEvent.count({
    where: { issuingBusinessId: aId, eventType: "COUPON_PUBLIC_DETAIL_SERVED" },
  });
  ok("coupon: a served public detail records one view", views === 1);
  const clicks = await prisma.couponSurfaceEvent.count({
    where: { issuingBusinessId: aId, eventType: { not: "COUPON_PUBLIC_DETAIL_SERVED" } },
  });
  ok("coupon: no click event is invented", clicks === 0);

  let couponFk = false;
  try {
    await prisma.couponSurfaceEvent.create({
      data: {
        issuingBusinessId: bId,
        couponId: (await prisma.coupon.findUniqueOrThrow({ where: { publicId: published.publicId } })).id,
        offerId: published.offerId,
        eventType: "COUPON_PUBLIC_DETAIL_SERVED",
      },
    });
  } catch {
    couponFk = true;
  }
  ok("coupon: business B cannot attach evidence to business A's coupon", couponFk);
  const bViews = await prisma.couponSurfaceEvent.count({ where: { issuingBusinessId: bId } });
  ok("coupon: business B has no surface events", bViews === 0);

  const { persistContentPlanV1 } = await import("@/lib/services/content-plan-persistence-v1.service");
  const insightText = "לקוחות מהססים בגלל המחיר";
  const persistedPlan = await persistContentPlanV1({
    user: { id: user.id, businessId: aId },
    body: {
      contentInsightAnswers: [
        {
          questionFamily: "hesitation",
          text: insightText,
          questionVariantId: "hesitation-1",
          chipsUsed: [],
          recordedAtIso: new Date().toISOString(),
        },
      ],
    },
    resolvedBusinessType: "retail_store",
    profileCategory: "Retail",
    profileSubCategory: "Fashion",
    selectedPlatform: "instagram",
    variants: [0, 1, 2].map((index) => ({
      id: `${TAG}-variant-${index}`,
      variantBlueprint: {
        visual_strategy: "product",
        visual_energy: "calm",
        pacing_curve: "steady",
        subtitle_behavior: "phrase",
        cta_psychology: "trust",
        narration_tone: "warm",
        attention_strategy: "direct",
      },
      renderBlueprint: { shots: [] },
      creativeScore: { total: 1 },
      growthSemantics: { intent: "trust" },
    })) as never,
  });
  const persistedRun = persistedPlan
    ? await prisma.contentRun.findFirst({
        where: { id: persistedPlan.contentRunId, businessId: aId },
      })
    : null;
  const snapshotData = (persistedRun?.inputSnapshot as { data?: { contentInsightAnswers?: { text?: string }[] } } | null)?.data;
  ok("content: insight answers are stored on the business run", snapshotData?.contentInsightAnswers?.[0]?.text === insightText);
  const foreignInsight = await prisma.contentRun.findFirst({
    where: { id: persistedPlan?.contentRunId ?? -1, businessId: bId },
  });
  ok("content: business B cannot read business A's run", foreignInsight === null);

  const { createPendingMatch, resolvePendingMatchWithExistingItem } = await import(
    "@/lib/services/inventory/pending-match.service"
  );
  const pendingExternal = `${TAG}-pending-multi`;
  await createPendingMatch({
    businessId: aId,
    externalSaleId: pendingExternal,
    sourceLines: [
      { lineKey: "0", sku: "A", barcode: null, name: "Line A", quantity: 1, unitPrice: "10.00", recognizedItemId: null },
      { lineKey: "1", sku: "B", barcode: null, name: "Line B", quantity: 2, unitPrice: "20.50", recognizedItemId: null },
    ],
    metadata: {
      externalSaleId: pendingExternal,
      sku: "A",
      barcode: null,
      name: "Line A",
      quantity: 3,
      source: "POS",
      allItems: [
        { sku: "A", barcode: null, name: "Line A", quantity: 1, unitPrice: "10.00" },
        { sku: "B", barcode: null, name: "Line B", quantity: 2, unitPrice: "20.50" },
      ],
    },
  });
  const stockBeforeResolve = (await prisma.inventoryItem.findUnique({ where: { id: itemA.id } }))?.currentQuantity;
  await resolvePendingMatchWithExistingItem({
    pendingMatchId: (await prisma.inventoryPendingMatch.findUniqueOrThrow({
      where: { businessId_externalSaleId: { businessId: aId, externalSaleId: pendingExternal } },
    })).id,
    businessId: aId,
    userId: user.id,
    itemId: itemA.id,
  });
  const sourceLines = await prisma.inventorySourceSaleLine.findMany({
    where: { businessId: aId, externalSaleId: pendingExternal },
    orderBy: { lineKey: "asc" },
  });
  ok("pos: both upstream lines are stored", sourceLines.length === 2);
  ok("pos: first line keeps its price", sourceLines[0]?.unitPrice?.toFixed(2) === "10.00");
  ok("pos: second line keeps its price", sourceLines[1]?.unitPrice?.toFixed(2) === "20.50");
  ok("pos: multi-line resolve does not attach those lines to one item movement", sourceLines.every((line) => line.saleLineId === null));
  const collapsedSale = await prisma.inventorySale.findUnique({
    where: { businessId_externalSaleId: { businessId: aId, externalSaleId: pendingExternal } },
  });
  ok("pos: multi-line resolve does not invent one sale for every source line", collapsedSale === null);
  const stockAfterResolve = (await prisma.inventoryItem.findUnique({ where: { id: itemA.id } }))?.currentQuantity;
  ok("pos: resolving still deducts the pending quantity once", stockAfterResolve === (stockBeforeResolve ?? 0) - 3);
  await resolvePendingMatchWithExistingItem({
    pendingMatchId: (await prisma.inventoryPendingMatch.findUniqueOrThrow({
      where: { businessId_externalSaleId: { businessId: aId, externalSaleId: pendingExternal } },
    })).id,
    businessId: aId,
    userId: user.id,
    itemId: itemA.id,
  }).catch(() => {});
  const stockAfterResolveRetry = (await prisma.inventoryItem.findUnique({ where: { id: itemA.id } }))?.currentQuantity;
  ok("pos: resolving the same pending sale does not deduct again", stockAfterResolveRetry === stockAfterResolve);

  let foreignSource = false;
  try {
    await prisma.inventorySourceSaleLine.create({
      data: {
        businessId: aId,
        externalSaleId: `${TAG}-foreign-source`,
        lineKey: "0",
        quantity: 1,
        recognizedItemId: itemB.id,
      },
    });
  } catch {
    foreignSource = true;
  }
  ok("pos: a source line cannot point at another tenant's item", foreignSource);

  const { recordBusinessAsset, getBusinessAsset } = await import("@/lib/services/content/business-asset.service");
  const uploaded = await recordBusinessAsset({
    businessId: aId,
    origin: "OWNER_UPLOAD",
    storageKey: `biz/${aId}/content/${TAG}.jpg`,
    assetRef: `https://assets.test/${TAG}.jpg`,
    contentRunId: run.id,
    idempotencyKey: `${TAG}-upload`,
  });
  const uploadedAgain = await recordBusinessAsset({
    businessId: aId,
    origin: "OWNER_UPLOAD",
    storageKey: `biz/${aId}/content/${TAG}-other.jpg`,
    assetRef: `https://assets.test/${TAG}-other.jpg`,
    contentRunId: run.id,
    idempotencyKey: `${TAG}-upload`,
  });
  ok("asset: owner upload is stored once", uploaded.created === true && uploadedAgain.created === false && uploadedAgain.id === uploaded.id);
  ok("asset: public reuse stays unapproved", uploaded.publicUseApproved === false && uploadedAgain.publicUseApproved === false);
  const generated = await recordBusinessAsset({
    businessId: aId,
    origin: "GENERATED",
    assetRef: `https://stock.test/${TAG}.mp4`,
    contentRunId: run.id,
    idempotencyKey: `${TAG}-generated`,
  });
  ok("asset: generated origin stays generated", generated.origin === "GENERATED");
  ok("asset: owner upload origin stays owner upload", uploaded.origin === "OWNER_UPLOAD");
  const hidden = await getBusinessAsset(bId, uploaded.id);
  ok("asset: business B cannot read business A's asset", hidden === null);
  let foreignAsset = false;
  try {
    await recordBusinessAsset({
      businessId: bId,
      origin: "GENERATED",
      assetRef: `https://stock.test/${TAG}-b.mp4`,
      contentRunId: run.id,
      idempotencyKey: `${TAG}-b-on-a-run`,
    });
  } catch {
    foreignAsset = true;
  }
  ok("asset: business B cannot attach an asset to business A's run", foreignAsset);
  let foreignAssetRow = false;
  try {
    await prisma.businessAsset.create({
      data: {
        businessId: bId,
        origin: "OWNER_UPLOAD",
        storageKey: `biz/${bId}/content/${TAG}-cross.jpg`,
        contentRunId: run.id,
        publicUseApproved: false,
      },
    });
  } catch {
    foreignAssetRow = true;
  }
  ok("asset: database rejects a cross-tenant content run", foreignAssetRow);
  const bAssets = await prisma.businessAsset.count({ where: { businessId: bId } });
  ok("asset: business B has no asset rows", bAssets === 0);

  await prisma.$disconnect();
}

main()
  .catch((error) => {
    console.error("FATAL:", error);
    failed += 1;
  })
  .then(async () => {
    const { prisma } = await import("@/lib/prisma");
    for (const id of [aId, bId]) {
      if (id) await prisma.business.delete({ where: { id } }).catch(() => {});
    }
    await prisma.$disconnect();
    if (failed > 0) {
      console.error(`\n${failed} check(s) FAILED`);
      process.exit(1);
    }
    console.log("\nP0 evidence DB: all checks passed");
  });
