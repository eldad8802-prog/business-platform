/**
 * Supplier Domain Catalog — Freshness (pure, no DB):
 *   npx tsx lib/services/inventory/catalog-freshness.test.ts
 */
import {
  attributeFreshnessWindowDays,
  computeFreshness,
} from "@/lib/services/inventory/catalog-freshness";

let failed = 0;
function ok(name: string, cond: boolean) {
  if (!cond) {
    console.error("FAIL:", name);
    failed += 1;
  } else {
    console.log("OK:", name);
  }
}

const now = new Date("2026-06-24T12:00:00.000Z");
function daysAgo(d: number): Date {
  return new Date(now.getTime() - d * 86_400_000);
}

// Attribute windows reflect volatility.
ok("availability window = 1d", attributeFreshnessWindowDays("AVAILABILITY") === 1);
ok("asking price window = 14d", attributeFreshnessWindowDays("ASKING_PRICE") === 14);
ok("MOQ window = 14d", attributeFreshnessWindowDays("MINIMUM_ORDER_AMOUNT") === 14);
ok("package window = 180d", attributeFreshnessWindowDays("PACKAGE_DESCRIPTION") === 180);
ok("lead-time window = 180d", attributeFreshnessWindowDays("LEAD_TIME_DAYS") === 180);

// Fresh just-asserted.
const f0 = computeFreshness("ASKING_PRICE", now, now);
ok("just-asserted is FRESH", f0.state === "FRESH");
ok("just-asserted ratio = 1", f0.freshnessRatio === 1);
ok("just-asserted age = 0", f0.ageDays === 0);

// Price still fresh within window, stale past it.
ok("price @7d FRESH", computeFreshness("ASKING_PRICE", daysAgo(7), now).state === "FRESH");
ok("price @14d FRESH (boundary)", computeFreshness("ASKING_PRICE", daysAgo(14), now).state === "FRESH");
ok("price @15d STALE", computeFreshness("ASKING_PRICE", daysAgo(15), now).state === "STALE");

// Availability decays fast.
ok("availability @2d STALE", computeFreshness("AVAILABILITY", daysAgo(2), now).state === "STALE");

// Ratio decays toward 0 and clamps.
const f7 = computeFreshness("ASKING_PRICE", daysAgo(7), now);
ok("price @7d ratio = 0.5", Math.abs(f7.freshnessRatio - 0.5) < 1e-9);
ok("stale ratio clamps to 0", computeFreshness("ASKING_PRICE", daysAgo(100), now).freshnessRatio === 0);

// Future as-of never produces negative age (clamped).
ok("future as-of age = 0", computeFreshness("ASKING_PRICE", daysAgo(-5), now).ageDays === 0);

if (failed > 0) {
  console.error(`\n${failed} freshness check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll catalog-freshness checks passed");
