/**
 * ADVERSARIAL pass — tries to BREAK coupons v1. Every check here is a hypothesis
 * that something is wrong; "HOLDS" means the attack failed (good), "BROKEN"
 * means a real defect was found.
 *
 *   TEST_DATABASE_URL=… npx tsx scripts/qa/coupons/coupon-adversarial.ts
 */

// Standalone script: marks the file as a module so its top-level
// declarations do not collide with sibling scripts in global scope.
export {};
const DB = process.env.TEST_DATABASE_URL?.trim();
if (!DB || !/^postgres(ql)?:\/\//i.test(DB)) {
  console.error("ABORT: set TEST_DATABASE_URL.");
  process.exit(1);
}
process.env.DATABASE_URL = DB;

const findings: { id: string; broken: boolean; detail: string }[] = [];
function probe(id: string, broken: boolean, detail: string) {
  findings.push({ id, broken, detail });
  console.log(`${broken ? "BROKEN" : "HOLDS "}  ${id} — ${detail}`);
}

const TAG = `qa-adv-${Date.now()}`;
const BASE = "https://qa.dubiz.test";
let aId = 0, bId = 0;

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { publishCoupon } = await import("@/lib/services/revenue/publish-coupon.service");
  const { disableCoupon, enableCoupon, getMyCoupons } = await import("@/lib/services/revenue/my-coupons.service");
  const { redeemCoupon } = await import("@/lib/services/redeem.service");
  const { createCouponFromOffer } = await import("@/lib/services/coupon.service");
  const { getActiveCoupons } = await import("@/lib/services/revenue/active-coupons.service");
  const { composeBenefitSentence, validateBenefit } = await import("@/lib/revenue/coupon-benefit");
  const { israelEndOfDay, validateValidUntil, maxValidUntilDate } = await import("@/lib/revenue/coupon-terms");
  const { couponTitle, titleInputValue, dateInDays, initialDraft } = await import("@/components/coupon/coupon-model");

  const a = await prisma.business.create({ data: { name: `${TAG}-A` } });
  const b = await prisma.business.create({ data: { name: `${TAG}-B` } });
  aId = a.id; bId = b.id;

  // ══ ATTACK 1: leading zeros in a percentage ════════════════════════════════
  const zeroPad = { benefitType: "pct" as const, value: "007", scope: "כל העסק" };
  const zeroPadValid = validateBenefit(zeroPad).length === 0;
  const zeroPadSentence = composeBenefitSentence(zeroPad);
  const EXPECTED = "7% הנחה על כל העסק";
  probe(
    "ADV-1 pct leading zeros normalized",
    zeroPadSentence !== EXPECTED,
    `"007" accepted=${zeroPadValid} → "${zeroPadSentence}"`
  );

  // ...and does the normalized form actually reach the database?
  if (zeroPadValid) {
    const p = await publishCoupon({
      businessId: aId, benefitType: "pct", value: "007", scope: "כל העסק",
      validUntilDate: dateInDays(7), baseUrl: BASE,
    });
    probe("ADV-1b persisted benefit text", p.benefit !== EXPECTED, `stored: "${p.benefit}"`);
  }

  // ══ ATTACK 2: the maximum date the picker offers ═══════════════════════════
  // The wizard sets max={dateInDays(365)}. Does the server accept its own max?
  // Uses the SAME helper the picker's max attribute uses, so this stays a real
  // test of "can the user pick the last date the calendar offers?".
  const now = new Date();
  const clientMax = maxValidUntilDate();
  const asInstant = israelEndOfDay(clientMax);
  const serverErrs = validateValidUntil(asInstant, now);
  probe(
    "ADV-2 picker max date accepted by server",
    serverErrs.length > 0,
    `client max=${clientMax} → server says: ${serverErrs.map((e) => e.message).join(",") || "ok"}`
  );
  let maxDateRejected = false;
  try {
    await publishCoupon({
      businessId: aId, benefitType: "pct", value: "20", scope: "כל העסק",
      validUntilDate: clientMax, baseUrl: BASE,
    });
  } catch { maxDateRejected = true; }
  probe("ADV-2b publish at picker max", maxDateRejected, `publish rejected=${maxDateRejected}`);

  // ══ ATTACK 3: clearing an edited title ═════════════════════════════════════
  // Requirement: "אם הוא מוחק ידנית, אל תמלא מחדש בכוח."
  const draft = { ...initialDraft(), benefitType: "pct" as const, value: "20", scope: "כל העסק", titleEdited: true, title: "" };
  const shownInField = titleInputValue(draft);       // what the INPUT renders
  const effective = couponTitle(draft);              // what the coupon is called
  probe(
    "ADV-3 cleared title stays cleared in the field",
    shownInField !== "",
    `field shows "${shownInField}"`
  );
  probe(
    "ADV-3b cleared title still yields a real coupon name",
    effective === "",
    `effective title falls back to "${effective}"`
  );

  // ══ ATTACK 4: one Offer, many Coupons — does disable cover them all? ═══════
  const multi = await publishCoupon({
    businessId: aId, benefitType: "amt", value: "50", scope: "כל העסק",
    validUntilDate: dateInDays(7), baseUrl: BASE,
  });
  // The LEGACY endpoint can still mint extra coupons onto the same offer.
  const extra = await createCouponFromOffer({ offerId: multi.offerId, businessId: aId, baseUrl: BASE });
  await disableCoupon(multi.publicId, aId);
  const extraAfter = await prisma.coupon.findUnique({ where: { id: extra.id } });
  probe(
    "ADV-4 disable covers every coupon of the offer",
    extraAfter?.status === "ACTIVE",
    `sibling coupon status after disabling its twin: ${extraAfter?.status}`
  );
  let siblingRedeemed = false;
  try {
    await redeemCoupon(extra.token, bId);
    siblingRedeemed = true;
  } catch { /* blocked */ }
  probe(
    "ADV-4b sibling still redeemable after 'stop'",
    siblingRedeemed,
    siblingRedeemed ? "owner pressed stop, a live token still redeemed" : "blocked"
  );

  // ══ ATTACK 5: can the PRODUCT still create a bare offer? ══════════════════
  // Tests the API surface, not raw Prisma: a direct DB insert always "works"
  // and proves nothing about what a user can reach.
  const { POST: legacyOfferPost } = await import("@/app/api/offers/route");
  const legacyRes = await legacyOfferPost();
  probe(
    "ADV-5 legacy offer-create endpoint is closed",
    legacyRes.status !== 410,
    `POST /api/offers → ${legacyRes.status} (was the orphan factory)`
  );

  // Pre-existing orphans may still sit in older databases. Confirm what they
  // look like to the owner, since that governs the production cleanup call.
  const orphan = await prisma.offer.create({
    data: {
      issuingBusinessId: aId, title: "orphan probe", customerBenefitText: "orphan probe",
      validUntil: new Date(Date.now() + 86_400_000), isActive: true,
    },
  });
  const orphanVisible = (await getMyCoupons(aId)).some((c) => c.offerId === orphan.id);
  const orphanRedeemable = await prisma.coupon.count({ where: { offerId: orphan.id } });
  probe(
    "ADV-5b a legacy orphan is inert (no token, nothing to redeem)",
    orphanRedeemable > 0,
    `coupons under orphan=${orphanRedeemable}, visible to owner=${orphanVisible}`
  );

  // ══ ATTACK 6: re-enable resurrects the offer even if it was never ours ═════
  const reEnableTarget = await publishCoupon({
    businessId: aId, benefitType: "pct", value: "10", scope: "כל העסק",
    validUntilDate: dateInDays(7), baseUrl: BASE,
  });
  await disableCoupon(reEnableTarget.publicId, aId);
  await enableCoupon(reEnableTarget.publicId, aId);
  const backInMarket = (await getActiveCoupons({ limit: 24 })).some((c) => c.publicId === reEnableTarget.publicId);
  probe("ADV-6 re-enable restores marketplace visibility", !backInMarket, `listed again=${backInMarket}`);

  // ══ ATTACK 7: concurrent double redemption ════════════════════════════════
  const racy = await publishCoupon({
    businessId: aId, benefitType: "pct", value: "15", scope: "כל העסק",
    validUntilDate: dateInDays(7), baseUrl: BASE,
  });
  const results = await Promise.allSettled([
    redeemCoupon(racy.token, bId),
    redeemCoupon(racy.token, bId),
  ]);
  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const events = await prisma.redemptionEvent.count({ where: { coupon: { publicId: racy.publicId } } });
  probe("ADV-7 concurrent redeem yields exactly one", succeeded !== 1 || events !== 1, `fulfilled=${succeeded}, events=${events}`);

  // ══ ATTACK 8: concurrent disable + redeem ═════════════════════════════════
  const racy2 = await publishCoupon({
    businessId: aId, benefitType: "pct", value: "15", scope: "כל העסק",
    validUntilDate: dateInDays(7), baseUrl: BASE,
  });
  const [disRes, redRes] = await Promise.allSettled([
    disableCoupon(racy2.publicId, aId),
    redeemCoupon(racy2.token, bId),
  ]);
  const row = await prisma.coupon.findUnique({ where: { publicId: racy2.publicId } });
  const ev = await prisma.redemptionEvent.count({ where: { coupon: { publicId: racy2.publicId } } });
  const coherent =
    (row?.status === "REDEEMED" && ev === 1) || (row?.status === "CANCELLED" && ev === 0);
  probe(
    "ADV-8 disable/redeem race stays coherent",
    !coherent,
    `disable=${disRes.status} redeem=${redRes.status} final=${row?.status} events=${ev}`
  );

  // ══ ATTACK 9: self-redemption (the open question) ═════════════════════════
  const selfC = await publishCoupon({
    businessId: aId, benefitType: "pct", value: "30", scope: "כל העסק",
    validUntilDate: dateInDays(7), baseUrl: BASE,
  });
  let selfOk = false;
  try { await redeemCoupon(selfC.token, aId); selfOk = true; } catch { /* blocked */ }
  probe("ADV-9 issuer cannot redeem its own coupon", selfOk, `self-redemption allowed=${selfOk}`);
  // ...and the block must not have consumed the coupon.
  const afterSelf = await prisma.coupon.findUnique({ where: { publicId: selfC.publicId } });
  probe("ADV-9b blocked self-redemption leaves the coupon usable", afterSelf?.status !== "ACTIVE", `status after attempt: ${afterSelf?.status}`);
  let realRedeem = false;
  try { await redeemCoupon(selfC.token, bId); realRedeem = true; } catch { /* */ }
  probe("ADV-9c a real business can still redeem it afterwards", !realRedeem, `redeemed by other business=${realRedeem}`);

  // ══ ATTACK 13: base URL cannot bake a non-public origin into a QR ═════════
  const { resolveCouponBaseUrl, isPubliclyReachable, CouponBaseUrlError } =
    await import("@/lib/revenue/coupon-base-url");
  const savedEnv = process.env.NODE_ENV;
  const savedBase = process.env.APP_BASE_URL;
  const savedPublic = process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.APP_BASE_URL;
  delete process.env.NEXT_PUBLIC_APP_URL;

  (process.env as Record<string, string>).NODE_ENV = "production";
  let guarded = false;
  try {
    resolveCouponBaseUrl({ nextUrl: { origin: "http://localhost:3000" } });
  } catch (e) { guarded = e instanceof CouponBaseUrlError; }
  probe("ADV-13 production refuses a localhost QR origin", !guarded, `guard fired=${guarded}`);

  process.env.APP_BASE_URL = "https://promaxgroup.co.il";
  const configured = resolveCouponBaseUrl({ nextUrl: { origin: "http://localhost:3000" } });
  probe("ADV-13b configured origin wins in production", configured !== "https://promaxgroup.co.il", `resolved=${configured}`);

  (process.env as Record<string, string>).NODE_ENV = "development";
  delete process.env.APP_BASE_URL;
  const devBase = resolveCouponBaseUrl({ nextUrl: { origin: "http://localhost:3000" } });
  probe("ADV-13c development still works with no env", devBase !== "http://localhost:3000", `resolved=${devBase}`);
  probe("ADV-13d public origin recognised", !isPubliclyReachable("https://promaxgroup.co.il"), "promaxgroup.co.il classified public");

  (process.env as Record<string, string>).NODE_ENV = savedEnv as string;
  if (savedBase) process.env.APP_BASE_URL = savedBase;
  if (savedPublic) process.env.NEXT_PUBLIC_APP_URL = savedPublic;

  // ══ ATTACK 10: whitespace / unicode smuggling into the benefit text ═══════
  const sneaky = { benefitType: "giftProduct" as const, value: "  \n\t x  ", scope: "כל העסק" };
  const sneakyOk = validateBenefit(sneaky).length === 0;
  probe("ADV-10 whitespace-only-ish gift value", sneakyOk, `"  \\n\\t x  " accepted=${sneakyOk} → "${sneakyOk ? composeBenefitSentence(sneaky) : "-"}"`);

  const longScope = { benefitType: "pct" as const, value: "20", scope: "כל העסק" + "\n".repeat(50) };
  probe("ADV-10b newline padding in scope", validateBenefit(longScope).length === 0 && composeBenefitSentence(longScope).includes("\n"), "newlines survive into stored text");

  // ══ ATTACK 11: expired coupon still listed in the marketplace ═════════════
  const exp = await publishCoupon({
    businessId: aId, benefitType: "pct", value: "5", scope: "כל העסק",
    validUntilDate: dateInDays(2), baseUrl: BASE,
  });
  await prisma.coupon.update({ where: { publicId: exp.publicId }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const expListed = (await getActiveCoupons({ limit: 24 })).some((c) => c.publicId === exp.publicId);
  probe("ADV-11 expired coupon leaves the marketplace", expListed, `still listed=${expListed}`);

  // ══ ATTACK 12: DST boundary for the Israeli end-of-day ════════════════════
  // Israel 2026: IDT starts 27 Mar, ends 25 Oct.
  const dstDays = ["2026-03-27", "2026-03-28", "2026-10-24", "2026-10-25", "2026-10-26"];
  const dstBad: string[] = [];
  for (const d of dstDays) {
    const inst = israelEndOfDay(d);
    const localDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", dateStyle: "short" }).format(inst);
    const localHour = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", hour: "2-digit", hour12: false }).format(inst);
    if (localDay !== d || localHour !== "23") dstBad.push(`${d}→${localDay} ${localHour}h`);
  }
  probe("ADV-12 end-of-day correct across DST", dstBad.length > 0, dstBad.length ? dstBad.join(", ") : "all 5 boundary days land at 23:xx local, same day");
}

async function cleanup() {
  const { prisma } = await import("@/lib/prisma");
  for (const id of [aId, bId]) if (id) await prisma.business.delete({ where: { id } }).catch(() => {});
  await prisma.$disconnect();
}

main()
  .catch((e) => { console.error("FATAL", e); process.exitCode = 1; })
  .then(cleanup)
  .then(() => {
    const broken = findings.filter((f) => f.broken);
    console.log(`\n${broken.length} defect(s) found out of ${findings.length} attacks`);
    if (broken.length) console.log(broken.map((f) => ` ✗ ${f.id}: ${f.detail}`).join("\n"));
  });
