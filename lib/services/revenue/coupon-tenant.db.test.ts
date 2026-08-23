/**
 * Coupons v1 — DB-backed tenant isolation + lifecycle verify:
 *   npx tsx lib/services/revenue/coupon-tenant.db.test.ts
 *
 * Creates two throwaway businesses, proves the invariants against real Prisma
 * queries, and deletes everything it made afterwards.
 *
 * Run (same safety contract as billing-issue.tenant-isolation.test.ts):
 *   TEST_DATABASE_URL="postgres://…<approved dev/test DB>…" \
 *     npx tsx lib/services/revenue/coupon-tenant.db.test.ts
 *
 * WHY THIS IS DB-BACKED AND NOT MOCKED (COUPON-16):
 * The audit's security question — "can Business A touch Business B's coupon?" —
 * is answered by what the database actually does with the `issuingBusinessId`
 * comparison, not by what a stubbed service claims. Client-side guards prove
 * nothing here, so every check below calls the real service against real rows.
 *
 * Proven:
 *   - cross-tenant READ    → foreign coupons never appear in `mine`
 *   - cross-tenant DISABLE → 403
 *   - cross-tenant ENABLE  → 403
 *   - cross-tenant CODE    → 403 (the redemption secret stays with the issuer)
 *   - disable is immediate → redemption blocked, marketplace listing dropped
 *   - redemption: valid → once; second attempt refused
 *   - redeeming a disabled / expired / unknown coupon fails closed
 *   - publish is atomic    → invalid input leaves NO offer and NO coupon
 */

// ---------------------------------------------------------------------------
// Database Safety Guard (fail-closed) — MUST run before any DB import/connect.
//
// This test seeds and deletes REAL rows. To make an accidental production
// DATABASE_URL impossible to hit, it refuses to run unless the operator names
// an approved test/dev database in TEST_DATABASE_URL, and it forces the Prisma
// singleton onto exactly that URL. Same contract as
// lib/services/billing/billing-issue.tenant-isolation.test.ts.
// ---------------------------------------------------------------------------
const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
if (!TEST_DB || !/^postgres(ql)?:\/\//i.test(TEST_DB)) {
  console.error(
    "ABORT (DB safety guard): set TEST_DATABASE_URL to an approved, non-production " +
      "test/dev Postgres URL. Refusing to seed/delete against the ambient DATABASE_URL."
  );
  process.exit(1);
}
process.env.DATABASE_URL = TEST_DB;

import { AppError } from "@/lib/errors";
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

async function expectStatus(name: string, fn: () => Promise<unknown>, statusCode: number) {
  try {
    await fn();
    ok(`${name} (expected ${statusCode}, got success)`, false);
  } catch (err) {
    const actual = err instanceof AppError ? err.statusCode : 0;
    if (actual !== statusCode) {
      console.error(`  ↳ got ${actual}: ${(err as Error).message}`);
    }
    ok(name, actual === statusCode);
  }
}

async function expectRejected(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    ok(`${name} (expected rejection, got success)`, false);
  } catch {
    ok(name, true);
  }
}

const TAG = `qa-coupon-tenant-${Date.now()}`;
const BASE = "https://qa.dubiz.test";

let aId = 0;
let bId = 0;
/** Bound in `main` after the dynamic import, so Prisma constructs against TEST_DATABASE_URL. */
let prisma: typeof import("@/lib/prisma").prisma;

async function main() {
  // Dynamic imports AFTER the guard.
  ({ prisma } = await import("@/lib/prisma"));
  const { publishCoupon } = await import("@/lib/services/revenue/publish-coupon.service");
  const { disableCoupon, enableCoupon, getMyCoupons } = await import(
    "@/lib/services/revenue/my-coupons.service"
  );
  const { getCouponCode } = await import("@/lib/services/revenue/coupon-code.service");
  const { getActiveCoupons } = await import("@/lib/services/revenue/active-coupons.service");
  const { redeemCoupon } = await import("@/lib/services/redeem.service");
  const { createCouponFromOffer } = await import("@/lib/services/coupon.service");

  const a = await prisma.business.create({ data: { name: `${TAG}-A` } });
  const b = await prisma.business.create({ data: { name: `${TAG}-B` } });
  aId = a.id;
  bId = b.id;

  // ── Publish as A ───────────────────────────────────────────────────────────
  const published = await publishCoupon({
    businessId: aId,
    benefitType: "pct",
    value: "20",
    scope: "כל העסק",
    description: "",
    minPurchaseEnabled: true,
    minPurchaseRaw: "100",
    newCustomersOnly: false,
    validUntilDate: dateInDays(14),
    baseUrl: BASE,
  });

  ok("publish: returns a publicId", Boolean(published.publicId));
  ok("publish: composes the canonical sentence", published.benefit === "20% הנחה על כל העסק");
  ok("publish: stores the terms text", published.description === "בקנייה מעל 100₪");
  ok("publish: QR points at the redeem route", published.qrValue === `${BASE}/revenue/redeem?token=${published.token}`);

  const offer = await prisma.offer.findUnique({ where: { id: published.offerId } });
  ok("publish: offer and coupon are both persisted", Boolean(offer));

  // ── Atomicity: an invalid publish writes nothing (COUPON-01) ───────────────
  const offersBefore = await prisma.offer.count({ where: { issuingBusinessId: aId } });
  await expectStatus(
    "publish: 0% is rejected with 400",
    () => publishCoupon({
      businessId: aId, benefitType: "pct", value: "0", scope: "כל העסק",
      validUntilDate: dateInDays(7), baseUrl: BASE,
    }),
    400
  );
  await expectStatus(
    "publish: a past end date is rejected with 400",
    () => publishCoupon({
      businessId: aId, benefitType: "pct", value: "20", scope: "כל העסק",
      validUntilDate: dateInDays(-1), baseUrl: BASE,
    }),
    400
  );
  const offersAfter = await prisma.offer.count({ where: { issuingBusinessId: aId } });
  // The decisive orphan check: the audit's failed publishes each left an Offer
  // behind (6, 7, 8). A rejected publish must leave the table exactly as it was.
  ok("atomicity: rejected publishes created NO orphan offer", offersAfter === offersBefore);

  const orphans = await prisma.offer.count({
    where: { issuingBusinessId: aId, coupons: { none: {} } },
  });
  ok("atomicity: business A has zero offers without a coupon", orphans === 0);

  // ── Cross-tenant READ (COUPON-16) ──────────────────────────────────────────
  const aList = await getMyCoupons(aId);
  const bList = await getMyCoupons(bId);
  ok("tenant: A sees its own coupon", aList.some((c) => c.publicId === published.publicId));
  ok("tenant: B's list is empty", bList.length === 0);
  ok("tenant: B never sees A's coupon", !bList.some((c) => c.publicId === published.publicId));

  // ── Cross-tenant SECRET ────────────────────────────────────────────────────
  const aCode = await getCouponCode(published.publicId, aId);
  ok("tenant: A can read its own redemption code", aCode.token === published.token);
  await expectStatus(
    "tenant: B cannot read A's redemption code → 403",
    () => getCouponCode(published.publicId, bId),
    403
  );

  // ── Cross-tenant MUTATION ──────────────────────────────────────────────────
  await expectStatus(
    "tenant: B cannot disable A's coupon → 403",
    () => disableCoupon(published.publicId, bId),
    403
  );
  await expectStatus(
    "tenant: B cannot enable A's coupon → 403",
    () => enableCoupon(published.publicId, bId),
    403
  );
  const stillActive = await prisma.coupon.findUnique({ where: { publicId: published.publicId } });
  ok("tenant: A's coupon is untouched after B's attempts", stillActive?.status === "ACTIVE");

  // ── Malformed ids fail closed, not with a 500 (the `mine` bug) ─────────────
  await expectStatus(
    "ids: a non-UUID publicId → 404, never a 500",
    () => disableCoupon("mine", aId),
    404
  );
  await expectStatus(
    "ids: an unknown UUID → 404",
    () => disableCoupon("00000000-0000-4000-8000-000000000000", aId),
    404
  );

  // ── Disable is immediate and total (COUPON-02) ─────────────────────────────
  const inMarketBefore = (await getActiveCoupons({ limit: 24 })).some(
    (c) => c.publicId === published.publicId
  );
  ok("marketplace: an active coupon is listed", inMarketBefore);

  const disabled = await disableCoupon(published.publicId, aId);
  ok("disable: state becomes DISABLED", disabled.state === "DISABLED");

  const afterDisable = await getMyCoupons(aId);
  ok(
    "disable: the owner's list reflects it",
    afterDisable.find((c) => c.publicId === published.publicId)?.state === "DISABLED"
  );

  const inMarketAfter = (await getActiveCoupons({ limit: 24 })).some(
    (c) => c.publicId === published.publicId
  );
  ok("disable: the coupon leaves the marketplace immediately", !inMarketAfter);

  await expectRejected(
    "disable: a disabled coupon cannot be redeemed",
    () => redeemCoupon(published.token, bId)
  );
  await expectStatus(
    "disable: the issuer cannot read the code of a disabled coupon",
    () => getCouponCode(published.publicId, aId),
    400
  );
  await expectRejected(
    "disable: disabling twice is refused",
    () => disableCoupon(published.publicId, aId)
  );

  // History survives a disable — the row and its offer are still there.
  const stillThere = await prisma.coupon.findUnique({ where: { publicId: published.publicId } });
  ok("disable: the coupon record is kept, not deleted", Boolean(stillThere));

  // ── Re-enable ──────────────────────────────────────────────────────────────
  const enabled = await enableCoupon(published.publicId, aId);
  ok("enable: state returns to ACTIVE", enabled.state === "ACTIVE");
  await expectRejected(
    "enable: enabling an active coupon is refused",
    () => enableCoupon(published.publicId, aId)
  );

  // ── Redemption (COUPON-03) ─────────────────────────────────────────────────
  await expectRejected(
    "redeem: an unknown token is refused",
    () => redeemCoupon("00000000-0000-4000-8000-000000000000", bId)
  );
  await expectRejected(
    "redeem: an empty token is refused",
    () => redeemCoupon("", bId)
  );

  const redemption = await redeemCoupon(published.token, bId);
  ok("redeem: succeeds for a live coupon", redemption.coupon.status === "REDEEMED");
  ok("redeem: records who redeemed it", redemption.redemptionEvent.redeemingBusinessId === bId);
  ok("redeem: records who issued it", redemption.redemptionEvent.issuingBusinessId === aId);

  await expectRejected(
    "redeem: the same coupon cannot be redeemed twice",
    () => redeemCoupon(published.token, bId)
  );

  const afterRedeem = await getMyCoupons(aId);
  const redeemedRow = afterRedeem.find((c) => c.publicId === published.publicId);
  ok("redeem: the owner's list shows REDEEMED", redeemedRow?.state === "REDEEMED");
  ok("redeem: the owner's list counts the redemption", redeemedRow?.redemptionCount === 1);
  await expectRejected(
    "redeem: a spent coupon can no longer be disabled",
    () => disableCoupon(published.publicId, aId)
  );

  // ── Self-redemption is refused, and refusing it costs nothing ─────────────
  const selfCoupon = await publishCoupon({
    businessId: aId, benefitType: "pct", value: "30", scope: "כל העסק",
    validUntilDate: dateInDays(7), baseUrl: BASE,
  });
  await expectRejected(
    "self-redemption: the issuing business cannot redeem its own coupon",
    () => redeemCoupon(selfCoupon.token, aId)
  );
  const selfAfter = await prisma.coupon.findUnique({ where: { publicId: selfCoupon.publicId } });
  // Critical: the refusal must not consume the coupon the owner was "testing".
  ok("self-redemption: the coupon survives the refused attempt", selfAfter?.status === "ACTIVE");
  const realRedemption = await redeemCoupon(selfCoupon.token, bId);
  ok("self-redemption: a different business can still redeem it", realRedemption.coupon.status === "REDEEMED");

  // ── The kill switch covers EVERY coupon under the offer ───────────────────
  // `Offer → Coupon` is one-to-many and the legacy issue endpoint can mint
  // siblings. Stopping one row while a sibling token stayed live and redeemable
  // was a real defect: the UI said "מושבת" and another business still redeemed.
  const parent = await publishCoupon({
    businessId: aId, benefitType: "amt", value: "50", scope: "כל העסק",
    validUntilDate: dateInDays(7), baseUrl: BASE,
  });
  const sibling = await createCouponFromOffer({
    offerId: parent.offerId, businessId: aId, baseUrl: BASE,
  });
  const stopped = await disableCoupon(parent.publicId, aId);
  ok("kill switch: reports stopping every coupon of the offer", stopped.stoppedCount === 2);
  const siblingRow = await prisma.coupon.findUnique({ where: { id: sibling.id } });
  ok("kill switch: the sibling coupon is CANCELLED too", siblingRow?.status === "CANCELLED");
  await expectRejected(
    "kill switch: the sibling token is no longer redeemable",
    () => redeemCoupon(sibling.token, bId)
  );
  const resumed = await enableCoupon(parent.publicId, aId);
  ok("kill switch: resume restores the whole offer", resumed.resumedCount === 2);

  // ── The endpoint that created the audit's orphaned offers is closed ───────
  const { POST: legacyOfferCreate } = await import("@/app/api/offers/route");
  const legacyStatus = (await legacyOfferCreate()).status;
  ok("orphans: POST /api/offers is retired (410)", legacyStatus === 410);

  // ── Expiry fails closed ────────────────────────────────────────────────────
  const expiring = await publishCoupon({
    businessId: aId, benefitType: "amt", value: "50", scope: "קפה הפוך",
    validUntilDate: dateInDays(1), baseUrl: BASE,
  });
  // Force it into the past to exercise the time check without waiting a day.
  await prisma.coupon.update({
    where: { publicId: expiring.publicId },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });
  await expectRejected(
    "expiry: an expired coupon cannot be redeemed",
    () => redeemCoupon(expiring.token, bId)
  );
  const expiredList = await getMyCoupons(aId);
  ok(
    "expiry: the owner's list derives EXPIRED from the date",
    expiredList.find((c) => c.publicId === expiring.publicId)?.state === "EXPIRED"
  );
  await expectRejected(
    "expiry: an expired coupon cannot be re-enabled",
    () => enableCoupon(expiring.publicId, aId)
  );
}

async function cleanup() {
  // Cascades from Business remove Offer → Coupon → RedemptionEvent.
  for (const id of [aId, bId]) {
    if (id) await prisma.business.delete({ where: { id } }).catch(() => {});
  }
}

main()
  .catch((err) => {
    console.error("FATAL:", err);
    failed += 1;
  })
  .then(cleanup)
  .then(async () => {
    await prisma.$disconnect();
    if (failed > 0) {
      console.error(`\n${failed} check(s) FAILED`);
      process.exit(1);
    }
    console.log("\nAll coupon tenant/lifecycle checks passed.");
  });
