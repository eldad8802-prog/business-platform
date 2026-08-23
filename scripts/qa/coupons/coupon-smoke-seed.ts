/**
 * Seeds two throwaway tenants for the coupon browser smoke, prints their
 * credentials, and (with --cleanup) removes them again.
 *
 *   TEST_DATABASE_URL=… npx tsx scripts/qa/coupons/coupon-smoke-seed.ts
 *   TEST_DATABASE_URL=… npx tsx scripts/qa/coupons/coupon-smoke-seed.ts --cleanup
 */
const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
if (!TEST_DB || !/^postgres(ql)?:\/\//i.test(TEST_DB)) {
  console.error("ABORT: set TEST_DATABASE_URL to an approved dev/test Postgres URL.");
  process.exit(1);
}
process.env.DATABASE_URL = TEST_DB;

const PREFIX = "qa-coupon-smoke";
export const ISSUER_EMAIL = `${PREFIX}-issuer@dubiz.test`;
export const REDEEMER_EMAIL = `${PREFIX}-redeemer@dubiz.test`;
export const PASSWORD = "SmokeTest!2026";

/**
 * The dev Neon instance scales to zero, so the first connection after an idle
 * gap fails while the compute wakes. Retry instead of failing the whole run.
 */
async function waitForDb(prisma: { $queryRawUnsafe: (q: string) => Promise<unknown> }) {
  for (let i = 1; i <= 6; i += 1) {
    try {
      await prisma.$queryRawUnsafe("SELECT 1");
      return;
    } catch {
      if (i === 6) throw new Error("database unreachable after 6 attempts");
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
}

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const bcrypt = (await import("bcrypt")).default;
  await waitForDb(prisma);

  if (process.argv.includes("--cleanup")) {
    const gone = await prisma.business.deleteMany({ where: { name: { startsWith: PREFIX } } });
    console.log(`cleanup: removed ${gone.count} business(es)`);
    await prisma.$disconnect();
    return;
  }

  await prisma.business.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const hash = await bcrypt.hash(PASSWORD, 10);

  // The issuing business gets a full, REAL profile so the coupon preview can be
  // checked against actual identity rather than the old hardcoded placeholders.
  const issuer = await prisma.business.create({
    data: {
      name: `${PREFIX} · מאפיית הבוקר`,
      users: { create: { email: ISSUER_EMAIL, password: hash, name: "בעל העסק", role: "USER" } },
      profile: {
        create: {
          category: "food",
          subCategory: "bakery",
          businessModel: "product",
          city: "חיפה",
          openingHours: "א׳–ה׳ 07:00–16:00",
          billingAddress: "הרצל 12, חיפה",
          billingPhone: "0521234567",
        },
      },
    },
  });

  const redeemer = await prisma.business.create({
    data: {
      name: `${PREFIX} · עסק מממש`,
      users: { create: { email: REDEEMER_EMAIL, password: hash, name: "מממש", role: "USER" } },
    },
  });

  console.log(JSON.stringify({ issuerId: issuer.id, redeemerId: redeemer.id, ISSUER_EMAIL, REDEEMER_EMAIL, PASSWORD }, null, 2));
  await prisma.$disconnect();
}

main();
