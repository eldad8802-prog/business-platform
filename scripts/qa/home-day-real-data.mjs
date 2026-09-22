/**
 * Real-data proof for the Home day read model.
 *
 * READ-ONLY. It never writes, and it never touches a business it was not
 * pointed at. For every business that has verified payments it:
 *
 *   1. asks the service for a day,
 *   2. re-derives the same day with an INDEPENDENT SQL aggregation that does
 *      the Israeli-hour conversion in Postgres rather than in Node. Note the
 *      double cast: the column is `timestamp without time zone` holding UTC,
 *      so a single `AT TIME ZONE 'Asia/Jerusalem'` would read the stored
 *      value AS Israeli local time and convert the wrong way — this script
 *      caught itself making exactly that mistake,
 *   3. fails if the two disagree on any hour, the total or the count.
 *
 * Two implementations agreeing is the only thing that makes "the bar is at the
 * hour the money actually arrived" a proof rather than a claim — a shared
 * helper would agree with itself even when both are wrong.
 *
 * Usage: npx tsx scripts/qa/home-day-real-data.mjs
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const failures = [];
let checks = 0;

function ok(label, condition, detail) {
  checks += 1;
  if (!condition) failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  // Which businesses actually have verified money, newest first.
  const busy = await prisma.$queryRawUnsafe(`
    SELECT r."businessId" AS business_id,
           to_char(t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD') AS day_key,
           count(*)::int AS cnt,
           sum(t.amount)::text AS total
    FROM "PaymentTransaction" t
    JOIN "PaymentRequest" r ON r.id = t."paymentRequestId"
    WHERE t.status = 'PAID' AND t.amount > 0
    GROUP BY 1, 2
    ORDER BY 2 DESC
    LIMIT 12
  `);

  console.log(`days with verified money: ${busy.length}`);
  if (busy.length === 0) {
    console.log("NOTE: this database holds no verified payments, so the hourly proof has nothing to compare.");
  }

  const { loadHomeDay } = await import("../../lib/services/home/home-day.service.ts");
  const { runWithTenantContext } = await import("../../lib/tenant/context.ts");

  for (const row of busy) {
    const businessId = Number(row.business_id);
    const date = row.day_key;

    // Independent derivation: Postgres does the timezone conversion itself.
    const perHour = await prisma.$queryRawUnsafe(
      `
      SELECT extract(hour FROM (t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Jerusalem'))::int AS hour,
             sum(t.amount)::text AS amount
      FROM "PaymentTransaction" t
      JOIN "PaymentRequest" r ON r.id = t."paymentRequestId"
      WHERE t.status = 'PAID' AND t.amount > 0
        AND r."businessId" = $1
        AND to_char(t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD') = $2
      GROUP BY 1
      `,
      businessId,
      date
    );

    const expected = new Array(24).fill(0);
    for (const h of perHour) expected[Number(h.hour)] = Number(h.amount);

    const model = await runWithTenantContext({ businessId }, () =>
      loadHomeDay(businessId, { date, scope: "day" })
    );

    const got = model.day.hours.map(Number);
    const sameHours = got.every((v, i) => Math.abs(v - expected[i]) < 0.005);
    ok(
      `business ${businessId} · ${date}: every payment is in its Israeli hour`,
      sameHours,
      sameHours ? "" : `service=${JSON.stringify(got.filter((v) => v > 0))} sql=${JSON.stringify(expected.filter((v) => v > 0))}`
    );
    ok(
      `business ${businessId} · ${date}: the day total matches the rows`,
      Math.abs(Number(model.day.total) - Number(row.total)) < 0.005,
      `service=${model.day.total} sql=${row.total}`
    );
    ok(
      `business ${businessId} · ${date}: the payment count matches the rows`,
      model.day.count === Number(row.cnt),
      `service=${model.day.count} sql=${row.cnt}`
    );
    console.log(`  ${businessId} ${date}: ₪${model.day.total} in ${model.day.count} payment(s) — hours ${got.map((v, i) => (v > 0 ? i : null)).filter((v) => v !== null).join(",") || "none"}`);
  }

  // Tenant isolation: one business must never see another's money.
  const businesses = [...new Set(busy.map((r) => Number(r.business_id)))];
  if (businesses.length >= 1) {
    const other = await prisma.business.findFirst({
      where: { id: { notIn: businesses } },
      select: { id: true },
    });
    if (other) {
      const date = busy[0].day_key;
      const model = await runWithTenantContext({ businessId: other.id }, () =>
        loadHomeDay(other.id, { date, scope: "day" })
      );
      ok(
        `business ${other.id} cannot see business ${busy[0].business_id}'s day`,
        Number(model.day.total) !== Number(busy[0].total) || Number(busy[0].total) === 0,
        `saw ₪${model.day.total} where the other business collected ₪${busy[0].total}`
      );
      console.log(`  isolation: business ${other.id} sees ₪${model.day.total} on ${date}`);
    } else {
      console.log("  isolation: no second business in this database to compare against");
    }
  }

  // A day that has not happened must be refused rather than answered with zero.
  const anyBusiness = await prisma.business.findFirst({ select: { id: true } });
  if (anyBusiness) {
    const future = new Date();
    future.setDate(future.getDate() + 3);
    const key = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).format(future);
    let refused = false;
    try {
      await runWithTenantContext({ businessId: anyBusiness.id }, () =>
        loadHomeDay(anyBusiness.id, { date: key })
      );
    } catch (error) {
      refused = error?.name === "FutureDayError";
    }
    ok("a future day is refused, not answered with a zero", refused);
  }

  console.log(`\nchecks ${checks}, failures ${failures.length}`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  await prisma.$disconnect();
  if (failures.length) process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
