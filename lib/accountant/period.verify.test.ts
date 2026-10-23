/**
 * Accounting periods — boundary proof (run: npx tsx lib/accountant/period.verify.test.ts).
 *
 * Pins the two export defects found in the 2026-10-21 audit (a quarter request widened to "every
 * record", a year request that ignored the year) and the Israeli month boundaries at both DST
 * changes.
 */

import {
  addPeriods,
  currentPeriodKey,
  inRange,
  isPeriodClosed,
  isPeriodKey,
  jerusalemDayOfMonth,
  monthNameHe,
  periodLabelHe,
  periodRange,
  previousPeriodKey,
  resolveExportRequest,
} from "./period";

let failed = 0;
function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}
const iso = (d: Date) => d.toISOString();

// ── keys ──
ok("period key accepts 2026-09", isPeriodKey("2026-09"));
ok("period key refuses 2026-9", !isPeriodKey("2026-9"));
ok("period key refuses 2026-13", !isPeriodKey("2026-13"));
ok("period key refuses 1999-12 (typo guard)", !isPeriodKey("1999-12"));
ok("period key refuses non-string", !isPeriodKey(202609));
ok("addPeriods -1 across a year", addPeriods("2026-01", -1) === "2025-12");
ok("addPeriods +2 across a year", addPeriods("2026-11", 2) === "2027-01");
ok("addPeriods 0", addPeriods("2026-09", 0) === "2026-09");

// ── Israeli month boundaries ──
{
  const sep = periodRange("2026-09"); // IDT (UTC+3) for the whole month
  ok("September 2026 starts 2026-08-31T21:00Z", iso(sep.from) === "2026-08-31T21:00:00.000Z");
  ok("September 2026 ends (excl.) 2026-09-30T21:00Z", iso(sep.toExclusive) === "2026-09-30T21:00:00.000Z");
  const oct = periodRange("2026-10"); // DST ends 2026-10-25 → November starts at UTC+2
  ok("October 2026 starts where September ends", iso(oct.from) === iso(sep.toExclusive));
  ok("October 2026 ends (excl.) 2026-10-31T22:00Z (after DST end)", iso(oct.toExclusive) === "2026-10-31T22:00:00.000Z");
  const mar = periodRange("2026-03"); // DST starts 2026-03-27
  ok("March 2026 starts 2026-02-28T22:00Z", iso(mar.from) === "2026-02-28T22:00:00.000Z");
  ok("March 2026 ends (excl.) 2026-03-31T21:00Z (after DST start)", iso(mar.toExclusive) === "2026-03-31T21:00:00.000Z");

  // A bare calendar day stored at UTC midnight stays in the month it names.
  ok("2026-09-01T00:00Z is in September", inRange(new Date("2026-09-01T00:00:00Z"), sep));
  ok("2026-09-30T00:00Z is in September", inRange(new Date("2026-09-30T00:00:00Z"), sep));
  // Israeli 00:30 on 1 October is October, not September.
  ok("2026-09-30T21:30Z (00:30 IL, 1 Oct) is NOT in September", !inRange(new Date("2026-09-30T21:30:00Z"), sep));
  ok("2026-09-30T20:59Z (23:59 IL, 30 Sep) IS in September", inRange(new Date("2026-09-30T20:59:59Z"), sep));
}

// ── "now" ──
{
  const firstOctIL = new Date("2026-09-30T21:00:00Z"); // 00:00 IL on 1 Oct
  ok("current period at 00:00 IL 1 Oct is 2026-10", currentPeriodKey(firstOctIL) === "2026-10");
  ok("previous period at 00:00 IL 1 Oct is 2026-09", previousPeriodKey(firstOctIL) === "2026-09");
  ok("one ms earlier the previous period is 2026-08", previousPeriodKey(new Date(firstOctIL.getTime() - 1)) === "2026-08");
  ok("September is closed at 00:00 IL 1 Oct", isPeriodClosed("2026-09", firstOctIL));
  ok("September is open one ms earlier", !isPeriodClosed("2026-09", new Date(firstOctIL.getTime() - 1)));
  ok("Jerusalem day of month at 00:00 IL 1 Oct is 1", jerusalemDayOfMonth(firstOctIL) === 1);
  ok("Jerusalem day of month one ms earlier is 30", jerusalemDayOfMonth(new Date(firstOctIL.getTime() - 1)) === 30);
  ok("previous period of 2026-01-15 is 2025-12", previousPeriodKey(new Date("2026-01-15T10:00:00Z")) === "2025-12");
}

// ── labels ──
ok("month name he", monthNameHe("2026-09") === "ספטמבר");
ok("period label he", periodLabelHe("2026-12") === "דצמבר 2026");

// ── export request: the audit defects ──
{
  // The screen used to send exactly this for a quarter — and got every record of the business.
  const q = resolveExportRequest({ type: "quarter", month: "", year: "", quarter: "2026-Q2" });
  ok("quarter 2026-Q2 resolves", q.ok);
  if (q.ok) {
    ok("quarter label", q.label === "2026-Q2");
    ok("Q2 starts at April (IL)", iso(q.range.from) === iso(periodRange("2026-04").from));
    ok("Q2 ends before July (IL)", iso(q.range.toExclusive) === iso(periodRange("2026-06").toExclusive));
  }
  const q2 = resolveExportRequest({ type: "quarter", year: "2026", quarter: "3" });
  ok("quarter as year + 3 resolves to Q3", q2.ok && q2.label === "2026-Q3");
  const q3 = resolveExportRequest({ type: "quarter", year: "2026", quarter: "Q4" });
  ok("quarter as year + Q4 resolves, ends at next year's start", q3.ok && iso(q3.range.toExclusive) === iso(periodRange("2027-01").from));
  const qBad = resolveExportRequest({ type: "quarter", year: "", quarter: "3" });
  ok("quarter without a year is REFUSED, not widened", !qBad.ok && qBad.error === "invalid_quarter");
  const qBad2 = resolveExportRequest({ type: "quarter", quarter: "2026-Q5" });
  ok("quarter Q5 refused", !qBad2.ok);

  // The year request used to ignore the year and always return last year.
  const y = resolveExportRequest({ type: "year", year: "2024" });
  ok("year 2024 resolves to 2024", y.ok && y.label === "2024");
  if (y.ok) {
    ok("2024 starts 1 Jan 2024 (IL)", iso(y.range.from) === iso(periodRange("2024-01").from));
    ok("2024 ends at 1 Jan 2025 (IL)", iso(y.range.toExclusive) === iso(periodRange("2025-01").from));
  }
  ok("year missing refused", !resolveExportRequest({ type: "year", year: "" }).ok);

  const m = resolveExportRequest({ type: "month", month: "2026-09" });
  ok("month 2026-09 resolves to the IL month", m.ok && iso(m.range.from) === "2026-08-31T21:00:00.000Z");
  ok("month 2026-9 refused", !resolveExportRequest({ type: "month", month: "2026-9" }).ok);
  ok("month empty refused (never unbounded)", !resolveExportRequest({ type: "month", month: "" }).ok);
  ok("unknown type refused", !resolveExportRequest({ type: "week" }).ok);
  ok("missing type refused", !resolveExportRequest({}).ok);
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nperiod: all checks passed");
