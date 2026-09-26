/**
 * Daily Business Cost — pure proofs. Run:
 *   npx tsx lib/services/business-cost/business-cost-core.test.ts
 *
 * Everything here is arithmetic over plain values: allocation, projection,
 * baseline normalisation, cash-out bucketing and the uncertainty rules. The
 * database half (tenant isolation, the legacy-obligation bridge, real rows)
 * lives in `business-cost.db.test.ts`.
 */
import {
  addCadence,
  baselineDailyMinor,
  civilDateInZone,
  dailyShareMinor,
  deriveBusinessCostForDate,
  explainLineHe,
  fromDayNumber,
  parseCadence,
  toDayNumber,
  type BusinessCostDay,
  type CostCommitment,
  type CostInstallment,
  type CostPayment,
  BusinessCostValidationError,
} from "./business-cost-core";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function throws(name: string, fn: () => unknown): void {
  total += 1;
  try {
    fn();
    failures += 1;
    console.log(`  [FAIL] ${name} — did not throw`);
  } catch (e) {
    const ok = e instanceof BusinessCostValidationError;
    if (!ok) failures += 1;
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}`);
  }
}
function section(title: string): void {
  console.log(`\n${title}`);
}

/* ─────────────────────────────── fixtures ────────────────────────────────── */

let nextId = 1000;
function inst(dueDate: string, amountMinor: number, extra: Partial<CostInstallment> = {}): CostInstallment {
  nextId += 1;
  return { id: nextId, sequence: 1, dueDate, amountMinor, currency: "ILS", status: "SCHEDULED", ...extra };
}
function commitment(extra: Partial<CostCommitment> & { installments: CostInstallment[] }): CostCommitment {
  nextId += 1;
  const installments = extra.installments.map((i, k) => ({ ...i, sequence: i.sequence === 1 ? k + 1 : i.sequence }));
  return {
    source: "COMMITMENT",
    id: nextId,
    title: "התחייבות",
    payeeName: "נמען",
    payeeKind: null,
    currency: "ILS",
    scheduleKind: "RECURRING",
    recurrence: "MONTHLY",
    recurrenceSeriesId: null,
    status: "ACTIVE",
    isLegacy: false,
    ...extra,
    installments,
  };
}
function payment(paidAt: string, amountMinor: number, extra: Partial<CostPayment> = {}): CostPayment {
  nextId += 1;
  return {
    id: nextId,
    paidAt: new Date(paidAt),
    amountMinor,
    currency: "ILS",
    status: "RECORDED",
    payeeName: "נמען",
    method: "BANK_TRANSFER",
    allocations: [],
    ...extra,
  };
}
function run(date: string, commitments: CostCommitment[], payments: CostPayment[] = [], affirmed: boolean | null = true): BusinessCostDay {
  return deriveBusinessCostForDate({
    date,
    timeZone: "Asia/Jerusalem",
    baseCurrency: "ILS",
    commitments,
    payments,
    ownerAffirmedBackboneCaptured: affirmed,
  });
}
function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = toDayNumber(from); d <= toDayNumber(to); d += 1) out.push(fromDayNumber(d));
  return out;
}
function sumAllocated(from: string, to: string, commitments: CostCommitment[]): number {
  return eachDay(from, to).reduce((s, d) => s + run(d, commitments).allocatedCost.totalMinor, 0);
}

/* ─────────────────────────────── primitives ──────────────────────────────── */

section("civil dates and cadence arithmetic");
eq("round-trip 2028-02-29", fromDayNumber(toDayNumber("2028-02-29")), "2028-02-29");
throws("2027-02-29 is not a date", () => toDayNumber("2027-02-29"));
throws("garbage is not a date", () => toDayNumber("29/02/2028"));
eq("monthly from Jan 31 → Feb 28 (2027)", fromDayNumber(addCadence(toDayNumber("2027-01-31"), { unit: "MONTH", every: 1 }, 1)), "2027-02-28");
eq("monthly from Jan 31 → Feb 29 (2028 leap)", fromDayNumber(addCadence(toDayNumber("2028-01-31"), { unit: "MONTH", every: 1 }, 1)), "2028-02-29");
eq("anchor 31 survives February: Jan 31 +2 → Mar 31", fromDayNumber(addCadence(toDayNumber("2027-01-31"), { unit: "MONTH", every: 1 }, 2)), "2027-03-31");
eq("yearly from Feb 29 2028 → Feb 28 2029", fromDayNumber(addCadence(toDayNumber("2028-02-29"), { unit: "MONTH", every: 12 }, 1)), "2029-02-28");
eq("weekly +1", fromDayNumber(addCadence(toDayNumber("2026-09-28"), { unit: "WEEK", every: 1 }, 1)), "2026-10-05");
eq("parse MONTHLY", parseCadence("MONTHLY"), { unit: "MONTH", every: 1 });
eq("parse BIMONTHLY", parseCadence("bimonthly"), { unit: "MONTH", every: 2 });
eq("parse QUARTERLY", parseCadence("QUARTERLY"), { unit: "MONTH", every: 3 });
eq("NONE is not a cadence", parseCadence("NONE"), null);
eq("unknown string is not guessed", parseCadence("EVERY_OTHER_TUESDAY"), null);

section("time zone boundaries (Asia/Jerusalem)");
eq("UTC midnight date-picker value keeps its date", civilDateInZone(new Date("2026-09-01T00:00:00Z"), "Asia/Jerusalem"), "2026-09-01");
eq("legacy local-midnight value (21:00Z prev day, IDT) keeps its date", civilDateInZone(new Date("2026-08-31T21:00:00Z"), "Asia/Jerusalem"), "2026-09-01");
eq("00:30 Israel is that local day, not the previous UTC day", civilDateInZone(new Date("2026-09-14T21:30:00Z"), "Asia/Jerusalem"), "2026-09-15");
eq("winter (IST, +2): 22:30Z is the next local day", civilDateInZone(new Date("2026-12-31T22:30:00Z"), "Asia/Jerusalem"), "2027-01-01");
eq("winter (IST, +2): 21:30Z is still the same local day", civilDateInZone(new Date("2026-12-31T21:30:00Z"), "Asia/Jerusalem"), "2026-12-31");

section("integer daily split never loses an agora");
{
  let ok = true;
  for (const [amount, days] of [[900000, 30], [900000, 31], [100, 3], [1, 31], [730000, 366], [420000, 61], [0, 28], [999999, 7]]) {
    let s = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < days; i += 1) {
      const x = dailyShareMinor(amount, days, i);
      s += x;
      min = Math.min(min, x);
      max = Math.max(max, x);
    }
    if (s !== amount || max - min > 1) ok = false;
  }
  check("Σ shares == amount and shares differ by ≤ 1 agora (8 cases)", ok);
  throws("negative amount refused", () => dailyShareMinor(-1, 30, 0));
  throws("index outside its period refused", () => dailyShareMinor(100, 30, 30));
}

section("baseline normalisation");
eq("9,000 monthly → ₪295.69/day (Gregorian mean month)", baselineDailyMinor(900000, { unit: "MONTH", every: 1 }), 29569);
eq("7,300 yearly → ₪19.99/day", baselineDailyMinor(730000, { unit: "MONTH", every: 12 }), 1999);
eq("700 weekly → ₪100.00/day", baselineDailyMinor(70000, { unit: "WEEK", every: 1 }), 10000);
eq("4,200 bimonthly → ₪69.00/day", baselineDailyMinor(420000, { unit: "MONTH", every: 2 }), 6900);

/* ───────────────────────────── allocation rules ──────────────────────────── */

section("monthly rent — 9,000 due on the 1st");
{
  const rent = commitment({ title: "שכירות", payeeKind: "LANDLORD", installments: [inst("2026-09-01", 900000)] });
  const r = run("2026-09-15", [rent]);
  eq("Sep 15 allocated = ₪300.00 (30-day month)", r.allocatedCost.totalMinor, 30000);
  eq("basis RECORDED", r.allocatedCost.lines[0].basis, "RECORDED");
  eq("period Sep 1–30", [r.allocatedCost.lines[0].period.from, r.allocatedCost.lines[0].period.to], ["2026-09-01", "2026-09-30"]);
  eq("baseline = ₪295.69", r.baselineDailyCost.totalMinor, 29569);
  eq("Sep 1 is NOT 9,000 (allocation, not due date)", run("2026-09-01", [rent]).allocatedCost.totalMinor, 30000);
  eq("Σ September = exactly 9,000", sumAllocated("2026-09-01", "2026-09-30", [rent]), 900000);
  const oct = run("2026-10-10", [rent]);
  eq("October (31 days) is PROJECTED from the recorded amount", oct.allocatedCost.lines[0].basis, "PROJECTED");
  eq("Σ October (31 days) = exactly 9,000", sumAllocated("2026-10-01", "2026-10-31", [rent]), 900000);
  eq("Σ February 2027 (28 days) = exactly 9,000", sumAllocated("2027-02-01", "2027-02-28", [rent]), 900000);
  eq("Σ February 2028 (29 days, leap) = exactly 9,000", sumAllocated("2028-02-01", "2028-02-29", [rent]), 900000);
  eq("Feb 2027 daily share ≈ 9,000/28", run("2027-02-10", [rent]).allocatedCost.totalMinor, 32143);
  eq("baseline identical in Feb and in Oct", run("2027-02-10", [rent]).baselineDailyCost.totalMinor, oct.baselineDailyCost.totalMinor);
  const text = explainLineHe(r.allocatedCost.lines[0]);
  check("explanation names the source amount and period", text.includes("₪300.00") && text.includes("₪9,000.00") && text.includes("01/09/2026–30/09/2026"), text);
}

section("annual insurance — 7,300 yearly");
{
  const ins = commitment({ title: "ביטוח עסק", payeeKind: "INSURER", recurrence: "YEARLY", installments: [inst("2026-01-01", 730000)] });
  eq("2026 (365 days): ₪20.00/day", run("2026-06-15", [ins]).allocatedCost.totalMinor, 2000);
  eq("Σ 2026 = exactly 7,300", sumAllocated("2026-01-01", "2026-12-31", [ins]), 730000);
  eq("Σ 2028 (leap, 366 days) = exactly 7,300", sumAllocated("2028-01-01", "2028-12-31", [ins]), 730000);
}

section("bi-monthly Arnona — 4,200 every 2 months (engine-ready; write side cannot yet produce it)");
{
  const arnona = commitment({ title: "ארנונה", payeeKind: "AUTHORITY", recurrence: "BIMONTHLY", installments: [inst("2026-09-01", 420000)] });
  const r = run("2026-10-20", [arnona]);
  eq("period Sep 1 – Oct 31 (61 days)", [r.allocatedCost.lines[0].period.from, r.allocatedCost.lines[0].period.to, r.allocatedCost.lines[0].period.days], ["2026-09-01", "2026-10-31", 61]);
  eq("Σ period = exactly 4,200", sumAllocated("2026-09-01", "2026-10-31", [arnona]), 420000);
}

section("weekly and quarterly");
{
  const weekly = commitment({ title: "ניקיון", recurrence: "WEEKLY", installments: [inst("2026-09-06", 70000)] });
  eq("weekly 700 → ₪100/day", run("2026-09-08", [weekly]).allocatedCost.totalMinor, 10000);
  eq("weekly projected 10 weeks later still ₪100/day", run("2026-11-17", [weekly]).allocatedCost.totalMinor, 10000);
  const q = commitment({ title: "רבעוני", recurrence: "QUARTERLY", installments: [inst("2026-07-01", 92000)] });
  eq("quarterly Jul–Sep (92 days) → ₪10/day", run("2026-08-15", [q]).allocatedCost.totalMinor, 1000);
}

section("one-time, installment plan and missing recurrence are UNCERTAIN, never added");
{
  const oneOff = commitment({ title: "תיקון מזגן", scheduleKind: "ONE_OFF", recurrence: "NONE", installments: [inst("2026-09-20", 300000)] });
  const r = run("2026-09-10", [oneOff]);
  eq("one-off: allocated 0", r.allocatedCost.totalMinor, 0);
  eq("one-off: surfaced as ONE_OFF_COVERAGE_UNKNOWN", r.uncertain.items.map((u) => [u.reason, u.amountMinor]), [["ONE_OFF_COVERAGE_UNKNOWN", 300000]]);
  eq("one-off due in another month is not surfaced", run("2026-10-10", [oneOff]).uncertain.items.length, 0);
  eq("state PARTIAL when something is unallocatable", r.completeness.state, "PARTIAL");

  const plan = commitment({
    title: "מקרר בתשלומים",
    scheduleKind: "INSTALLMENT_PLAN",
    installments: [inst("2026-09-05", 100000), inst("2026-10-05", 100000), inst("2026-11-05", 100000)],
  });
  const p = run("2026-10-15", [plan]);
  eq("installment plan: allocated 0", p.allocatedCost.totalMinor, 0);
  eq("installment plan: this month's payment surfaced as PAYMENT_PLAN_COVERAGE_UNKNOWN", p.uncertain.items.map((u) => u.reason), ["PAYMENT_PLAN_COVERAGE_UNKNOWN"]);

  const noCadence = commitment({ title: "ללא תדירות", recurrence: "NONE", installments: [inst("2026-09-01", 50000)] });
  eq("RECURRING without a cadence → UNKNOWN_CADENCE", run("2026-09-10", [noCadence]).uncertain.items.map((u) => u.reason), ["UNKNOWN_CADENCE"]);
}

section("start, end, future and cancellation");
{
  const mid = commitment({ title: "מחסן", installments: [inst("2026-09-15", 300000)] });
  eq("day before a mid-month start: 0, NOT_STARTED", [run("2026-09-14", [mid]).allocatedCost.totalMinor, run("2026-09-14", [mid]).excluded[0]?.reason], [0, "NOT_STARTED"]);
  const s = run("2026-09-15", [mid]);
  eq("mid-month start covers Sep 15 – Oct 14 (30 days)", [s.allocatedCost.lines[0].period.from, s.allocatedCost.lines[0].period.to], ["2026-09-15", "2026-10-14"]);
  eq("future commitment contributes nothing today", run("2026-09-25", [commitment({ installments: [inst("2027-01-01", 100000)] })]).allocatedCost.totalMinor, 0);

  // Terminated mid-period: the last recorded occurrence still covers its period
  // (the obligation existed), nothing is projected past it.
  const ended = commitment({ title: "חוזה שהסתיים", status: "CLOSED", installments: [inst("2026-08-01", 310000)] });
  eq("closed commitment keeps its recorded August", run("2026-08-20", [ended]).allocatedCost.totalMinor, 10000);
  eq("closed commitment: nothing after its last period", [run("2026-09-02", [ended]).allocatedCost.totalMinor, run("2026-09-02", [ended]).excluded[0]?.reason], [0, "ENDED"]);

  const cancelled = commitment({
    title: "בוטל",
    installments: [inst("2026-08-01", 310000), inst("2026-09-01", 300000, { status: "CANCELLED" })],
  });
  eq("cancelled September contributes 0", run("2026-09-10", [cancelled]).allocatedCost.totalMinor, 0);
  eq("…and says why", run("2026-09-10", [cancelled]).excluded[0]?.reason, "INSTALLMENT_CANCELLED");
  eq("…August is untouched", run("2026-08-10", [cancelled]).allocatedCost.totalMinor, 10000);
  eq("a cancelled latest occurrence is never projected forward", run("2026-11-10", [cancelled]).allocatedCost.totalMinor, 0);

  const released = commitment({ title: "שוחרר", status: "RELEASED", installments: [inst("2026-09-01", 300000)] });
  eq("released commitment contributes 0 in its own period", run("2026-09-10", [released]).allocatedCost.totalMinor, 0);
}

section("amount change keeps history (per-occurrence amounts)");
{
  const rent = commitment({ title: "שכירות", installments: [inst("2026-09-01", 900000), inst("2026-10-01", 950000)] });
  eq("September still 9,000/30", run("2026-09-15", [rent]).allocatedCost.totalMinor, 30000);
  eq("Σ September unchanged = 9,000", sumAllocated("2026-09-01", "2026-09-30", [rent]), 900000);
  eq("Σ October = 9,500", sumAllocated("2026-10-01", "2026-10-31", [rent]), 950000);
  const nov = run("2026-11-10", [rent]);
  eq("November projects the NEW amount", [nov.allocatedCost.lines[0].basis, nov.allocatedCost.lines[0].periodAmountMinor], ["PROJECTED", 950000]);
  eq("baseline tracks the amount in effect on the date", [run("2026-09-15", [rent]).baselineDailyCost.totalMinor, nov.baselineDailyCost.totalMinor], [29569, 31212]);
}

section("legacy recurring series — N rows, ONE economic commitment");
{
  const series = "series-rent-1";
  const legacy = (id: number, due: string, status: CostCommitment["status"], iStatus: CostInstallment["status"], amount: number, source: CostCommitment["source"] = "COMMITMENT"): CostCommitment => ({
    source,
    id,
    title: "בעל הבית",
    payeeName: "בעל הבית",
    payeeKind: null,
    currency: "ILS",
    scheduleKind: "RECURRING",
    recurrence: "MONTHLY",
    recurrenceSeriesId: series,
    status,
    isLegacy: true,
    installments: [{ id: id * 10, sequence: 1, dueDate: due, amountMinor: amount, currency: "ILS", status: iStatus }],
  });
  const rows = [
    legacy(1, "2026-07-01", "CLOSED", "SETTLED_LEGACY", 880000),
    legacy(2, "2026-08-01", "CLOSED", "SETTLED_LEGACY", 900000),
    legacy(3, "2026-09-01", "ACTIVE", "SCHEDULED", 900000, "LEGACY_OBLIGATION"),
  ];
  const r = run("2026-09-15", rows);
  eq("counted ONCE, not once per migrated month", [r.allocatedCost.lines.length, r.allocatedCost.totalMinor], [1, 30000]);
  eq("the open row after the backfill is read from the obligation bridge", r.allocatedCost.lines[0].source, "LEGACY_OBLIGATION");
  eq("July keeps July's amount (8,800/31)", run("2026-07-15", rows).allocatedCost.totalMinor, 28387);
  eq("SETTLED_LEGACY occurrence still counts as cost (it was owed)", run("2026-08-15", rows).allocatedCost.lines[0].basis, "RECORDED");
  eq("October projects from the series head", run("2026-10-15", rows).allocatedCost.lines[0].basis, "PROJECTED");
  const dup = [...rows, legacy(4, "2026-09-01", "ACTIVE", "SCHEDULED", 900000)];
  eq("two live rows for the same period → CONFLICTING_OCCURRENCES, not a guess", run("2026-09-15", dup).uncertain.items.map((u) => u.reason), ["CONFLICTING_OCCURRENCES"]);
}

section("month-end anchor: series born on the 31st");
{
  const c = commitment({ installments: [inst("2027-01-31", 310000), inst("2027-02-28", 280000)] });
  const r = run("2027-03-15", [c]);
  eq("recorded Feb 28 (a clamp) covers Feb 28 – Mar 30, restoring the 31st", [r.allocatedCost.lines[0].basis, r.allocatedCost.lines[0].period.from, r.allocatedCost.lines[0].period.to], ["RECORDED", "2027-02-28", "2027-03-30"]);
  const p = run("2027-04-05", [c]);
  eq("first projected period starts exactly where recorded ended (Mar 31 – Apr 29)", [p.allocatedCost.lines[0].basis, p.allocatedCost.lines[0].period.from, p.allocatedCost.lines[0].period.to], ["PROJECTED", "2027-03-31", "2027-04-29"]);
  let gapless = true;
  for (const d of eachDay("2027-01-31", "2027-12-31")) if (run(d, [c]).allocatedCost.lines.length !== 1) gapless = false;
  check("every day of the year is covered by exactly one period (no gap, no overlap)", gapless);
  const replaced = commitment({ installments: [inst("2026-09-01", 900000, { status: "CANCELLED", sequence: 2 }), inst("2026-09-01", 950000, { sequence: 1 })] });
  eq("a cancelled occurrence replaced on the same date yields to the live one", run("2026-09-10", [replaced]).allocatedCost.lines[0]?.periodAmountMinor, 950000);
}

section("loans are debt service, not operating cost");
{
  const loan = commitment({ title: "הלוואה", payeeKind: "LENDER", installments: [inst("2026-09-10", 240000)] });
  const rent = commitment({ title: "שכירות", installments: [inst("2026-09-01", 900000)] });
  const r = run("2026-09-15", [loan, rent]);
  eq("allocated cost excludes the loan", r.allocatedCost.totalMinor, 30000);
  eq("baseline excludes the loan", r.baselineDailyCost.totalMinor, 29569);
  eq("loan reported apart as debt service", r.debtService.allocatedMinor, 8000);
  check("completeness names the unknown interest share", r.completeness.reasons.includes("DEBT_SERVICE_COST_SHARE_UNKNOWN"));
}

section("amounts: zero, negative, foreign currency");
{
  eq("zero amount is a real, zero line", run("2026-09-15", [commitment({ installments: [inst("2026-09-01", 0)] })]).allocatedCost.lines.map((l) => l.allocatedMinor), [0]);
  eq("negative amount excluded as INVALID_AMOUNT", run("2026-09-15", [commitment({ installments: [inst("2026-09-01", -100)] })]).excluded.map((e) => e.reason), ["INVALID_AMOUNT"]);
  eq("USD commitment never converted", run("2026-09-15", [commitment({ currency: "USD", installments: [inst("2026-09-01", 100000, { currency: "USD" })] })]).excluded.map((e) => e.reason), ["NON_BASE_CURRENCY"]);
}

/* ───────────────────────────── cash vs allocation ────────────────────────── */

section("PAYMENT DATE NEVER REDEFINES ECONOMIC ALLOCATION");
{
  const rent = commitment({ title: "שכירות", installments: [inst("2026-09-01", 900000)] });
  const alloc = (paymentAmount: number) => [{ installmentId: rent.installments[0].id, commitmentId: rent.id, amountMinor: paymentAmount }];
  const scenarios: Record<string, CostPayment[]> = {
    "not yet paid": [],
    "paid early (Aug 25)": [payment("2026-08-25T09:00:00Z", 900000, { allocations: alloc(900000) })],
    "paid on time (Sep 1)": [payment("2026-09-01T09:00:00Z", 900000, { allocations: alloc(900000) })],
    "paid late (Sep 20)": [payment("2026-09-20T09:00:00Z", 900000, { allocations: alloc(900000) })],
    "two partial payments": [
      payment("2026-09-03T09:00:00Z", 400000, { allocations: alloc(400000) }),
      payment("2026-09-17T09:00:00Z", 500000, { allocations: alloc(500000) }),
    ],
  };
  const fingerprint = (payments: CostPayment[]) =>
    eachDay("2026-08-20", "2026-10-05")
      .map((d) => {
        const r = run(d, [rent], payments);
        return `${r.allocatedCost.totalMinor}/${r.baselineDailyCost.totalMinor}`;
      })
      .join(",");
  const reference = fingerprint([]);
  for (const [name, payments] of Object.entries(scenarios)) {
    check(`allocated & baseline identical on every day — ${name}`, fingerprint(payments) === reference);
  }
  const late = scenarios["paid late (Sep 20)"];
  eq("cash out on Sep 20 = 9,000", run("2026-09-20", [rent], late).cashOut.totalMinor, 900000);
  eq("allocated on Sep 20 = 300 — the same day, two different truths", run("2026-09-20", [rent], late).allocatedCost.totalMinor, 30000);
  eq("cash out on Sep 1 when paid late = 0", run("2026-09-01", [rent], late).cashOut.totalMinor, 0);
  const two = scenarios["two partial payments"];
  eq("partial payments land on their own days", [run("2026-09-03", [rent], two).cashOut.totalMinor, run("2026-09-17", [rent], two).cashOut.totalMinor], [400000, 500000]);
  eq("cash-out row says which commitment it settled", run("2026-09-03", [rent], two).cashOut.payments[0].allocations[0].commitmentId, rent.id);
}

section("cash out: status, currency and time zone");
{
  const v = payment("2026-09-15T09:00:00Z", 50000, { status: "VOID" });
  eq("VOID payment is not cash out", run("2026-09-15", [], [v]).cashOut.totalMinor, 0);
  const late = payment("2026-09-14T21:30:00Z", 12000);
  eq("paid 00:30 Israel on Sep 15 counts on Sep 15", [run("2026-09-15", [], [late]).cashOut.totalMinor, run("2026-09-14", [], [late]).cashOut.totalMinor], [12000, 0]);
  const usd = payment("2026-09-15T09:00:00Z", 10000, { currency: "USD" });
  const r = run("2026-09-15", [], [usd]);
  eq("USD payment listed apart, never added", [r.cashOut.totalMinor, r.cashOut.otherCurrency.length], [0, 1]);
  const unalloc = payment("2026-09-15T09:00:00Z", 10000);
  eq("an unallocated payment is still cash out, marked unallocated", run("2026-09-15", [], [unalloc]).cashOut.payments[0].unallocatedMinor, 10000);
}

section("completeness");
{
  eq("nothing known → EMPTY", run("2026-09-15", []).completeness.state, "EMPTY");
  const rent = commitment({ installments: [inst("2026-09-01", 900000)] });
  eq("all recorded, owner affirmed backbone → COMPLETE", run("2026-09-15", [rent]).completeness.state, "COMPLETE");
  eq("owner never affirmed the backbone → PARTIAL", run("2026-09-15", [rent], [], null).completeness.reasons, ["BACKBONE_NOT_AFFIRMED"]);
  eq("a projected occurrence → PARTIAL", run("2026-10-15", [rent]).completeness.reasons, ["PROJECTED_OCCURRENCES"]);
}

section("determinism");
{
  const cs = [
    commitment({ title: "a", installments: [inst("2026-09-01", 900000)] }),
    commitment({ title: "b", recurrence: "YEARLY", installments: [inst("2026-01-01", 730000)] }),
    commitment({ title: "c", scheduleKind: "ONE_OFF", recurrence: "NONE", installments: [inst("2026-09-20", 5000)] }),
  ];
  const a = JSON.stringify(run("2026-09-15", cs));
  const b = JSON.stringify(run("2026-09-15", [...cs].reverse()));
  check("input order does not change the result", a === b);
}

console.log(`\n${total - failures}/${total} passed`);
if (failures > 0) process.exit(1);
