/**
 * Verify — what the BoI writer appends (lib/fx/fx-rate-writer.ts planPair / isJump) and the freshness status
 * (lib/fx/fx-rate-status.ts). Pure: no network, no database (the DB behaviour is the lab: fx-boi-rates-lab.yml).
 * Run: npx tsx lib/fx/fx-rate-writer-plan.test.ts
 */
import assert from "node:assert/strict";

import type { BoiObservation } from "@/lib/fx/boi-parser";
import { businessDaysAfter, computePairStatus } from "@/lib/fx/fx-rate-status";
import { changeBasisPoints, isJump, planPair, type StoredRate } from "@/lib/fx/fx-rate-writer";

let checks = 0;
const ok = (label: string, cond: boolean, detail?: unknown) => {
  assert.ok(cond, `${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  checks += 1;
  console.log(`  ok ${label}`);
};
const eq = (label: string, got: unknown, want: unknown) => {
  assert.deepEqual(got, want, label);
  checks += 1;
  console.log(`  ok ${label}`);
};

const obs = (rateDate: string, rate: string): BoiObservation => ({ base: "USD", quote: "ILS", rate, rateDate, obsValue: rate, unitMult: 0, seriesCode: "RER_USD_ILS" });
const st = (rateDate: string, rate: string, fetchedAt = "2026-10-20T13:30:00.000Z", verification: "VERIFIED" | "UNVERIFIED" = "VERIFIED"): StoredRate => ({ rateDate, rate, fetchedAt, verification });

console.log("1. jump threshold (exact, 5%)");
ok("exactly 5.00% is NOT a jump", !isJump("3.15", "3.00"));
ok("5.0001% is a jump", isJump("3.150003", "3.00"));
ok("a fall of more than 5% is a jump", isJump("2.84", "3.00"));
eq("basis points", changeBasisPoints("3.400", "3.107"), 943);

console.log("2. first run, empty table");
{
  const p = planPair("USD", [obs("2026-10-21", "3.091"), obs("2026-10-20", "3.106"), obs("2026-10-22", "3.107")], []);
  eq("all three appended, oldest first", p.inserts.map((i) => i.rateDate), ["2026-10-20", "2026-10-21", "2026-10-22"]);
  eq("the oldest has no baseline → UNVERIFIED, the rest are compared → VERIFIED", p.inserts.map((i) => i.verification), ["UNVERIFIED", "VERIFIED", "VERIFIED"]);
  eq("one NO_BASELINE event", p.events.map((e) => e.event), ["FX_RATE_NO_BASELINE"]);
  eq("canonical scale-10 strings", p.inserts[0].rate, "3.1060000000");
}

console.log("3. idempotency and revisions");
{
  const stored = [st("2026-10-20", "3.1060000000"), st("2026-10-21", "3.0910000000"), st("2026-10-22", "3.1070000000")];
  const same = planPair("USD", [obs("2026-10-20", "3.106"), obs("2026-10-21", "3.091"), obs("2026-10-22", "3.107")], stored);
  eq("identical re-run appends nothing", [same.inserts.length, same.skipped, same.events.length], [0, 3, 0]);

  const rev = planPair("USD", [obs("2026-10-21", "3.093")], stored);
  eq("a changed value for a stored date is ONE new row", rev.inserts.map((i) => [i.rateDate, i.rate, i.verification]), [["2026-10-21", "3.0930000000", "VERIFIED"]]);
  eq("…with a REVISED event naming the stored value", rev.events, [{ event: "FX_RATE_REVISED", base: "USD", rateDate: "2026-10-21", rate: "3.0930000000", storedRate: "3.0910000000" }]);

  // A → B → A: the date's CURRENT value is B (newest fetchedAt), so A again is a new row, not a skip.
  const history = [st("2026-10-21", "3.0910000000", "2026-10-21T13:30:00.000Z"), st("2026-10-21", "3.0930000000", "2026-10-21T15:00:00.000Z")];
  const back = planPair("USD", [obs("2026-10-21", "3.091")], history);
  eq("compared against the NEWEST row of the date (A→B→A appends A)", back.inserts.map((i) => i.rate), ["3.0910000000"]);
  const same2 = planPair("USD", [obs("2026-10-21", "3.093")], history);
  eq("…and the newest value again is skipped", [same2.inserts.length, same2.skipped], [0, 1]);
}

console.log("4. jump vs the previous business day");
{
  const stored = [st("2026-10-22", "3.1070000000")];
  const p = planPair("USD", [obs("2026-10-23", "3.400")], stored);
  eq("+9.43% → UNVERIFIED", p.inserts.map((i) => i.verification), ["UNVERIFIED"]);
  eq("…and an FX_RATE_JUMP alert", p.events, [{ event: "FX_RATE_JUMP", base: "USD", rateDate: "2026-10-23", rate: "3.4000000000", previousDate: "2026-10-22", previousRate: "3.1070000000", changeBp: 943 }]);
  const weekend = planPair("USD", [obs("2026-10-26", "3.110")], [st("2026-10-23", "3.1000000000")]);
  eq("Monday compares with Friday (weekend skipped)", weekend.inserts.map((i) => i.verification), ["VERIFIED"]);
  const stale = planPair("USD", [obs("2026-11-05", "3.110")], [st("2026-10-23", "3.1000000000")]);
  eq("nothing within 10 days → no baseline → UNVERIFIED", [stale.inserts[0].verification, stale.events[0].event], ["UNVERIFIED", "FX_RATE_NO_BASELINE"]);
  const chain = planPair("USD", [obs("2026-10-23", "3.400"), obs("2026-10-26", "3.410")], [st("2026-10-22", "3.1070000000")]);
  eq("the day after a jump is compared with the jumped value (new level, not a second alert)", chain.inserts.map((i) => i.verification), ["UNVERIFIED", "VERIFIED"]);
  ok("a future-dated stored row never serves as a baseline for an earlier date", planPair("USD", [obs("2026-10-22", "3.107")], [st("2026-10-23", "3.0000000000")]).inserts[0].verification === "UNVERIFIED");
  let threw = false;
  try {
    planPair("EUR", [obs("2026-10-22", "3.107")], []);
  } catch {
    threw = true;
  }
  ok("an observation of another pair is refused", threw);
}

console.log("5. status — last date per pair, staleness vs 2 business days");
eq("Tue → Thu = 2 business days", businessDaysAfter("2026-10-20", "2026-10-22"), 2);
eq("Fri → Mon = 1 business day", businessDaysAfter("2026-10-23", "2026-10-26"), 1);
eq("same day = 0", businessDaysAfter("2026-10-22", "2026-10-22"), 0);
{
  const rows = [
    { rateDate: "2026-10-21", fetchedAt: "2026-10-21T13:30:00.000Z", verification: "VERIFIED" },
    { rateDate: "2026-10-22", fetchedAt: "2026-10-22T13:30:00.000Z", verification: "UNVERIFIED" },
  ];
  const s = computePairStatus("USD", rows, "2026-10-22");
  eq("latest any / latest verified", [s.latestRateDate, s.latestVerifiedRateDate, s.latestIsUnverified], ["2026-10-22", "2026-10-21", true]);
  eq("1 business day since the last verified → fresh", [s.businessDaysSinceVerified, s.stale], [1, false]);
  const thu = { rateDate: "2026-10-22", fetchedAt: "2026-10-22T13:30:00.000Z", verification: "VERIFIED" };
  eq("Mon after a Thu verified rate = 2 business days → fresh", computePairStatus("USD", [thu], "2026-10-26").stale, false);
  eq("Tue after a Thu verified rate = 3 business days → STALE", computePairStatus("USD", [thu], "2026-10-27").stale, true);
  eq("no rows → stale, no dates", computePairStatus("EUR", [], "2026-10-22"), { pair: "EUR/ILS", latestRateDate: null, latestVerifiedRateDate: null, latestIsUnverified: false, businessDaysSinceVerified: null, stale: true });
  const corrected = computePairStatus("USD", [...rows, { rateDate: "2026-10-22", fetchedAt: "2026-10-22T15:00:00.000Z", verification: "VERIFIED" }], "2026-10-22");
  eq("a newer VERIFIED row of the same date supersedes the UNVERIFIED one", [corrected.latestVerifiedRateDate, corrected.latestIsUnverified], ["2026-10-22", false]);
  eq("a future-dated row is ignored", computePairStatus("USD", [{ rateDate: "2026-10-30", fetchedAt: "2026-10-22T13:30:00.000Z", verification: "VERIFIED" }], "2026-10-22").latestRateDate, null);
}

console.log(`fx-rate-writer-plan: ${checks} checks passed`);
