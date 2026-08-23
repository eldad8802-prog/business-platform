/**
 * Orphan-offer audit (audit Phase 17) — REPORT ONLY, deletes nothing.
 *
 * The audit's failed publishes each left an `Offer` with no `Coupon` behind it
 * (it named 6, 7, 8). This lists every such row with enough context to decide,
 * per the instruction not to delete by id without verification.
 *
 *   TEST_DATABASE_URL="postgres://…" npx tsx scripts/audit-coupon-orphans.ts
 */
const DB = process.env.TEST_DATABASE_URL?.trim();
if (!DB || !/^postgres(ql)?:\/\//i.test(DB)) {
  console.error("ABORT: set TEST_DATABASE_URL to the database you want to AUDIT (read-only).");
  process.exit(1);
}
process.env.DATABASE_URL = DB;

async function main() {
  const { prisma } = await import("@/lib/prisma");

  const totals = {
    offers: await prisma.offer.count(),
    coupons: await prisma.coupon.count(),
    redemptions: await prisma.redemptionEvent.count(),
  };
  console.log("totals:", totals);

  const orphans = await prisma.offer.findMany({
    where: { coupons: { none: {} } },
    select: {
      id: true,
      title: true,
      customerBenefitText: true,
      issuingBusinessId: true,
      isActive: true,
      createdAt: true,
      validUntil: true,
      issuingBusiness: { select: { name: true } },
    },
    orderBy: { id: "asc" },
  });

  console.log(`\norphan offers (no coupon): ${orphans.length}`);
  for (const o of orphans) {
    console.log(
      `  #${o.id} · business ${o.issuingBusinessId} (${o.issuingBusiness.name}) · ` +
        `created ${o.createdAt.toISOString()} · active=${o.isActive} · "${o.title}"`
    );
  }

  if (orphans.length === 0) {
    console.log("\nNothing to clean up in this database.");
  } else {
    console.log(
      "\nAn orphan is safe to remove only if it is a failed-publish remnant: no coupon,\n" +
        "and its business/created-at match the failed QA attempts. Offer has no other\n" +
        "inbound relations (only `coupons`), so removal cannot orphan anything else.\n" +
        "Review the list above before deleting anything."
    );
  }

  await prisma.$disconnect();
}

main();
