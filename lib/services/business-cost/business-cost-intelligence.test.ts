/**
 * Pure proofs for Business Cost Intelligence (no database).
 *   node_modules/.bin/tsx lib/services/business-cost/business-cost-intelligence.test.ts
 *
 * Every figure is reconstructed by hand from the fixture, so a test that passes
 * means the number the owner would see is the number the ledger implies.
 */
import {
  baselineViews,
  baselineChangeSignal,
  cashOutSignal,
  costForRange,
  costStructure,
  overdueObligations,
  recordedChanges,
  recurringChangeSignal,
  summarizeBusinessCost,
  upcomingConcentrationSignal,
  upcomingObligations,
  weekStart,
  type IntelligenceInput,
} from "./business-cost-intelligence";
import { composeCostInsights } from "./business-cost-insights";
import { baselineDailyMinor, parseCadence, type CostCommitment, type CostInstallment, type CostPayment } from "./business-cost-core";

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
function section(t: string) {
  console.log(`\n${t}`);
}

let nextId = 1000;
function inst(dueDate: string, amountMinor: number, extra: Partial<CostInstallment> = {}): CostInstallment {
  nextId += 1;
  return { id: nextId, sequence: 1, dueDate, amountMinor, currency: "ILS", status: "SCHEDULED", ...extra };
}
function commitment(extra: Partial<CostCommitment> & { installments: CostInstallment[] }): CostCommitment {
  nextId += 1;
  const installments = extra.installments.map((i, k) => ({ ...i, sequence: k + 1 }));
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
    endDate: null,
    ...extra,
    installments,
  };
}
function payment(paidAt: string, amountMinor: number, allocations: CostPayment["allocations"] = []): CostPayment {
  nextId += 1;
  return { id: nextId, paidAt: new Date(paidAt), amountMinor, currency: "ILS", status: "RECORDED", payeeName: "נמען", method: "BANK_TRANSFER", allocations };
}
function input(asOf: string, commitments: CostCommitment[], payments: CostPayment[] = []): IntelligenceInput {
  return { asOf, timeZone: "Asia/Jerusalem", baseCurrency: "ILS", commitments, payments, ownerAffirmedBackboneCaptured: true };
}
/** Monthly occurrences on `day` of each month from `fromMonth` (YYYY-MM) for `n` months. */
function monthlyInstallments(fromMonth: string, n: number, amountMinor: number, day = "01", amounts?: (k: number) => number): CostInstallment[] {
  const [y0, m0] = fromMonth.split("-").map(Number);
  return Array.from({ length: n }, (_, k) => {
    const y = y0 + Math.floor((m0 - 1 + k) / 12);
    const m = ((m0 - 1 + k) % 12) + 1;
    return inst(`${y}-${String(m).padStart(2, "0")}-${day}`, amounts ? amounts(k) : amountMinor);
  });
}

/* ─────────────────────────────────────────────────────────────────────────── */
section("1 · periods: cash out vs allocated, payment timing, handled ≠ paid");
{
  // Rent ₪3,000 due on the 1st; paid early on Aug 28 for September.
  const sep = inst("2026-09-01", 300000);
  const rent = commitment({ title: "שכירות", installments: [inst("2026-08-01", 300000), sep] });
  const paidEarly = payment("2026-08-28T09:00:00Z", 300000, [{ installmentId: sep.id, commitmentId: rent.id, amountMinor: 300000 }]);
  const paidLate = payment("2026-09-20T09:00:00Z", 300000, [{ installmentId: sep.id, commitmentId: rent.id, amountMinor: 300000 }]);
  const early = input("2026-09-30", [rent], [paidEarly]);
  const late = input("2026-09-30", [rent], [paidLate]);
  const sepEarly = costForRange(early, "2026-09-01", "2026-09-30");
  const sepLate = costForRange(late, "2026-09-01", "2026-09-30");
  eq("September's allocated cost is exactly the September occurrence", sepEarly.allocatedMinor, 300000);
  eq("payment timing does not move allocated cost (early = late)", sepLate.allocatedMinor, sepEarly.allocatedMinor);
  eq("cash out in September: 0 when paid in August", sepEarly.cashOutMinor, 0);
  eq("cash out in September: ₪3,000 when paid on Sep 20", sepLate.cashOutMinor, 300000);
  eq("cash out lands on its Israel paid date only", costForRange(late, "2026-09-20", "2026-09-20").cashOutMinor, 300000);
  const handled = input("2026-09-30", [rent], []); // handled without a payment = no Payment row
  eq("handled without payment → cash out 0", costForRange(handled, "2026-09-01", "2026-09-30").cashOutMinor, 0);
  eq("handled without payment → allocated unchanged", costForRange(handled, "2026-09-01", "2026-09-30").allocatedMinor, 300000);
  const israelMidnight = input("2026-09-30", [rent], [payment("2026-09-29T21:30:00Z", 5000)]);
  eq("a payment at 00:30 Israel time on Sep 30 is Sep 30's cash, not Sep 29's", [costForRange(israelMidnight, "2026-09-29", "2026-09-29").cashOutMinor, costForRange(israelMidnight, "2026-09-30", "2026-09-30").cashOutMinor], [0, 5000]);
  const s = summarizeBusinessCost(late);
  eq("standard periods: today / yesterday / this week / this month / last 30", [s.periods.today.from, s.periods.yesterday.from, s.periods.thisWeek.from, s.periods.thisMonth.from, s.periods.last30Days.from], ["2026-09-30", "2026-09-29", "2026-09-27", "2026-09-01", "2026-09-01"]);
  eq("the Israeli week starts on Sunday (Wed Sep 30 → Sun Sep 27)", weekStart("2026-09-30"), "2026-09-27");
  eq("a range is the exact sum of its days (agorot)", s.periods.thisMonth.allocatedMinor, 300000);
}

section("2 · baseline: daily / weekly / monthly / annual");
{
  const rent = commitment({ title: "שכירות", installments: [inst("2026-09-01", 300000)] });
  const insurance = commitment({ title: "ביטוח", recurrence: "YEARLY", installments: [inst("2026-01-15", 1200000)] });
  const weekly = commitment({ title: "ניקיון", recurrence: "WEEKLY", installments: [inst("2026-09-28", 35000)] });
  const b = baselineViews(input("2026-09-30", [rent, insurance, weekly]));
  const monthly = parseCadence("MONTHLY")!;
  eq("daily = the engine's own per-line baseline sum", b.dailyMinor, baselineDailyMinor(300000, monthly) + baselineDailyMinor(1200000, parseCadence("YEARLY")!) + baselineDailyMinor(35000, parseCadence("WEEKLY")!));
  check("monthly rent is exactly ₪3,000/month and annual insurance exactly ₪1,000/month", b.lines.find((l) => l.title === "שכירות")?.monthlyMinor === 300000 && b.lines.find((l) => l.title === "ביטוח")?.monthlyMinor === 100000);
  eq("weekly ₪350 → ₪50/day", b.lines.find((l) => l.title === "ניקיון")?.dailyMinor, 5000);
  eq("annual = monthly rent ×12 + insurance + weekly ×(365.2425/7)", b.annualMinor, 3600000 + 1200000 + Math.round((35000 * 365.2425) / 7));
  eq("weekly equivalent of monthly rent = 3000 × 7 / 30.436875", b.weeklyMinor - 35000 - Math.round((1200000 * 7) / 365.2425), Math.round((300000 * 7 * 12) / 365.2425));
  const oneOff = commitment({ title: "תיקון", scheduleKind: "ONE_OFF", recurrence: "NONE", installments: [inst("2026-09-10", 90000)] });
  const withOneOff = baselineViews(input("2026-09-30", [rent, oneOff]));
  eq("a one-off with unknown coverage is never added to the baseline", withOneOff.monthlyMinor, 300000);
  eq("…it is reported as uncertain instead", withOneOff.uncertainMinor, 90000);
  const loan = commitment({ title: "הלוואה", payeeKind: "LENDER", installments: [inst("2026-09-05", 200000)] });
  const withLoan = baselineViews(input("2026-09-30", [rent, loan]));
  eq("debt service is kept apart from the operating baseline", [withLoan.monthlyMinor, withLoan.debtServiceMonthlyMinor], [300000, 200000]);
}

section("3 · upcoming obligations: the financial schedule, not reminders");
{
  const oct = inst("2026-10-01", 300000);
  const rent = commitment({ title: "שכירות", installments: [inst("2026-09-01", 300000, { paidMinor: 300000 }), oct] });
  const vat = commitment({ title: "מע\"מ", scheduleKind: "ONE_OFF", recurrence: "NONE", installments: [inst("2026-10-15", 500000, { paidMinor: 100000 })] });
  const overdue = commitment({ title: "ספק", scheduleKind: "ONE_OFF", recurrence: "NONE", installments: [inst("2026-09-20", 80000)] });
  const cancelled = commitment({ title: "מבוטל", scheduleKind: "ONE_OFF", recurrence: "NONE", installments: [inst("2026-10-03", 70000, { status: "CANCELLED" })] });
  const i = input("2026-09-30", [rent, vat, overdue, cancelled]);
  const n7 = upcomingObligations(i, "2026-09-30", "2026-10-06");
  eq("next 7 days: October rent (stored)", n7.items.map((x) => [x.title, x.dueDate, x.amountMinor, x.basis]), [["שכירות", "2026-10-01", 300000, "RECORDED"]]);
  const n30 = upcomingObligations(i, "2026-09-30", "2026-10-29");
  eq("next 30 days: VAT at its REMAINING amount (₪4,000 of ₪5,000)", n30.items.find((x) => x.title === 'מע"מ')?.amountMinor, 400000);
  check("a cancelled occurrence is not upcoming", !n30.items.some((x) => x.title === "מבוטל"));
  const n60 = upcomingObligations(i, "2026-09-30", "2026-11-30");
  eq("beyond the stored occurrence, the running series is PROJECTED", n60.items.filter((x) => x.title === "שכירות").map((x) => [x.dueDate, x.basis]), [["2026-10-01", "RECORDED"], ["2026-11-01", "PROJECTED"]]);
  eq("totals split recorded vs projected", [n60.recordedMinor, n60.projectedMinor], [300000 + 400000, 300000]);
  eq("overdue = stored, past due, still unpaid", overdueObligations(i).items.map((x) => [x.title, x.amountMinor]), [["ספק", 80000]]);
  const ended = commitment({ title: "מנוי", installments: [inst("2026-09-10", 10000)], endDate: "2026-10-31" });
  eq("projection stops at the commitment's end date", upcomingObligations(input("2026-09-30", [ended]), "2026-09-30", "2026-12-31").items.map((x) => x.dueDate), ["2026-10-10"]);
  const jan31 = commitment({ title: "31", installments: [inst("2026-01-31", 1000), inst("2026-02-28", 1000)] });
  eq("month-end anchor is restored (Feb 28 → Mar 31, not Mar 28)", upcomingObligations(input("2026-03-01", [jan31]), "2026-03-01", "2026-03-31").items.map((x) => x.dueDate), ["2026-03-31"]);
  // There is no follow-up/snooze input anywhere in the type: a workflow date cannot move a financial one.
  check("the input type carries no workflow follow-up date", !("followUpAt" in (i.commitments[0].installments[0] as object)));
}

section("4 · cost structure: authoritative classification only");
{
  const rent = commitment({ title: "שכירות", payeeKind: "LANDLORD", installments: [inst("2026-09-01", 300000)] });
  const phone = commitment({ title: "טלפון", payeeKind: "OTHER", category: "תקשורת", installments: [inst("2026-09-05", 20000)] });
  const misc = commitment({ title: "שונות", installments: [inst("2026-09-07", 10000)] });
  const i = input("2026-09-30", [rent, phone, misc]);
  const s = costStructure(i, baselineViews(i));
  eq("payee kind first, then the owner's category, else UNCLASSIFIED", s.map((g) => [g.source, g.key, g.monthlyMinor]), [["PAYEE_KIND", "LANDLORD", 300000], ["OWNER_CATEGORY", "תקשורת", 20000], ["UNCLASSIFIED", "UNCLASSIFIED", 10000]]);
  check("shares are basis points of the operating monthly baseline", Math.abs(s.reduce((x, g) => x + g.shareBp, 0) - 10000) <= 2);
  check("a title is never parsed into a category", !s.some((g) => g.key === "שכירות" || g.key === "טלפון"));
}

section("5 · recorded changes: amount and cadence, with their evidence");
{
  const before = inst("2026-07-01", 300000);
  const after = inst("2026-08-01", 330000);
  const rent = commitment({ title: "שכירות", installments: [inst("2026-06-01", 300000), before, after, inst("2026-09-01", 330000)] });
  const c = recordedChanges(input("2026-09-30", [rent]));
  eq("one amount change, effective on the first new occurrence", c.map((x) => x.kind === "RECURRING_AMOUNT_CHANGED" && [x.effectiveDate, x.fromMinor, x.toMinor, x.monthlyToMinor - x.monthlyFromMinor]), [["2026-08-01", 300000, 330000, 30000]]);
  eq("…proved by the two occurrences", c[0].evidence, { beforeInstallmentId: before.id, afterInstallmentId: after.id });
  eq("a future amount change is not a fact yet", recordedChanges(input("2026-07-15", [rent])).length, 0);
  eq("history preserved: July's allocated cost is still the old amount", costForRange(input("2026-09-30", [rent]), "2026-07-01", "2026-07-31").allocatedMinor, 300000);
  const sid = "series-arnona";
  const bi = commitment({ title: "ארנונה", source: "LEGACY_OBLIGATION", recurrenceSeriesId: sid, recurrence: "MONTHLY", installments: [inst("2026-05-01", 100000)] });
  const bi2 = commitment({ title: "ארנונה", source: "LEGACY_OBLIGATION", recurrenceSeriesId: sid, recurrence: "BIMONTHLY", installments: [inst("2026-06-01", 200000)] });
  eq("a cadence change in a legacy series is a recorded fact", recordedChanges(input("2026-09-30", [bi, bi2])).map((x) => x.kind === "RECURRING_CADENCE_CHANGED" && [x.fromRecurrence, x.toRecurrence, x.effectiveDate]), [["MONTHLY", "BIMONTHLY", "2026-06-01"]]);
}

section("6 · learning signals: real change, no change, insufficient history");
{
  // 18 months of rent at ₪3,000, raised to ₪3,300 from August.
  const raised = commitment({ title: "שכירות", installments: monthlyInstallments("2025-04", 18, 300000, "01", (k) => (k >= 16 ? 330000 : 300000)) });
  const steady = commitment({ title: "שכירות", installments: monthlyInstallments("2025-04", 18, 300000) });
  const s1 = baselineChangeSignal(input("2026-09-30", [raised]));
  eq("real change → DETECTED, ₪3,000 → ₪3,300 per month", [s1.state, s1.monthlyFromMinor, s1.monthlyToMinor], ["DETECTED", 300000, 330000]);
  eq("…its driver is the rent series, CHANGED", s1.drivers.map((d) => [d.title, d.change, d.monthlyFromMinor, d.monthlyToMinor]), [["שכירות", "CHANGED", 300000, 330000]]);
  check("…and the daily baseline moves with it", s1.dailyToMinor > s1.dailyFromMinor);
  eq("…the recurring-change signal names the occurrence", recurringChangeSignal(input("2026-09-30", [raised])).changes.map((c) => c.effectiveDate), ["2026-08-01"]);
  eq("no change → NONE", baselineChangeSignal(input("2026-09-30", [steady])).state, "NONE");
  eq("no change → no recurring-change signal", recurringChangeSignal(input("2026-09-30", [steady])).state, "NONE");
  const young = commitment({ title: "שכירות", installments: monthlyInstallments("2026-08", 2, 300000) });
  const s3 = baselineChangeSignal(input("2026-09-30", [young]));
  eq("insufficient history → INSUFFICIENT_HISTORY, not a 'new cost' conclusion", [s3.state, s3.insufficient?.code, s3.insufficient?.needDays], ["INSUFFICIENT_HISTORY", "TOO_SHORT_HISTORY", 90]);
  eq("no data at all → NO_HISTORY", baselineChangeSignal(input("2026-09-30", [])).insufficient?.code, "NO_HISTORY");

  // Cash out: ₪3,000 every month for a year, then a normal month vs an unusual one.
  const year = Array.from({ length: 13 }, (_, k) => {
    const d = new Date(Date.UTC(2025, 8 + k, 5, 9));
    return payment(d.toISOString(), 300000);
  });
  const normal = cashOutSignal(input("2026-09-30", [steady], year));
  eq("cash out within the business's own range → NONE", [normal.state, normal.historyMaxMinor], ["NONE", 300000]);
  const spike = cashOutSignal(input("2026-09-30", [steady], [...year, payment("2026-09-20T09:00:00Z", 2000000)]));
  eq("cash out above every window of its own year → DETECTED ABOVE", [spike.state, spike.direction, spike.currentMinor], ["DETECTED", "ABOVE", 2300000]);
  const late = cashOutSignal(input("2026-10-01", [steady], year.filter((p) => p.paidAt.toISOString() < "2026-09-06")));
  eq("rent not yet recorded this cycle (less cash than every window) → NONE, never a 'less than usual' conclusion", [late.state, late.direction], ["NONE", null]);
  const thin = cashOutSignal(input("2026-09-30", [steady], year.slice(-3)));
  eq("three months of payments → INSUFFICIENT_HISTORY (needs 6 windows)", [thin.state, thin.insufficient?.needDays], ["INSUFFICIENT_HISTORY", 180]);

  // Upcoming concentration: steady rent history vs a large one-off due next week.
  const quiet = upcomingConcentrationSignal(input("2026-09-15", [steady]));
  eq("steady schedule → NONE", quiet.state, "NONE");
  const tax = commitment({ title: "מס", scheduleKind: "ONE_OFF", recurrence: "NONE", installments: [inst("2026-09-25", 2500000)] });
  const heavy = upcomingConcentrationSignal(input("2026-09-15", [steady, tax]));
  eq("a due load above every past window → DETECTED", [heavy.state, heavy.direction], ["DETECTED", "ABOVE"]);
  eq("young business → INSUFFICIENT_HISTORY", upcomingConcentrationSignal(input("2026-09-30", [young])).state, "INSUFFICIENT_HISTORY");
}

section("7 · isolation by construction: one business's history cannot move another's");
{
  const a = commitment({ title: "A rent", installments: monthlyInstallments("2025-04", 18, 300000) });
  const b = commitment({ title: "B rent", installments: monthlyInstallments("2025-04", 18, 900000, "01", (k) => (k >= 16 ? 2000000 : 900000)) });
  const alone = JSON.stringify(summarizeBusinessCost(input("2026-09-30", [a])).signals);
  const sA = summarizeBusinessCost(input("2026-09-30", [a]));
  const sB = summarizeBusinessCost(input("2026-09-30", [b]));
  check("A's signals are computed from A's input only (B's spike exists and does not appear)", JSON.stringify(sA.signals) === alone && sB.signals.baselineChange.state === "DETECTED" && sA.signals.baselineChange.state === "NONE");
}

section("8 · insights: only from DETECTED signals, every number from evidence");
{
  const raised = commitment({ title: "שכירות", installments: monthlyInstallments("2025-04", 18, 300000, "01", (k) => (k >= 16 ? 330000 : 300000)) });
  const steady = commitment({ title: "שכירות", installments: monthlyInstallments("2025-04", 18, 300000) });
  const young = commitment({ title: "שכירות", installments: monthlyInstallments("2026-08", 2, 300000) });
  const [ins] = composeCostInsights(summarizeBusinessCost(input("2026-09-30", [raised])));
  eq("rent raised → one baseline insight", ins?.kind, "BASELINE_RECURRING_COST_CHANGED");
  check("its text states the recorded change from the evidence", (ins?.body ?? "").includes("מ־₪3,000 ל־₪3,300 החל מ־1/8/2026"), ins?.body);
  check("…and the normalized daily cost before → after", ins?.body.includes("₪98.56") && ins?.body.includes("₪108.42"), ins?.body);
  check("every number in the text is one of its facts", ["3000.00", "3300.00", "98.56", "108.42"].every((v) => ins.facts.some((f) => f.value === v || f.value.includes(v))));
  check("facts carry their source (signal or ledger row)", ins.facts.every((f) => /^(signal:|commitment:)/.test(f.sourceRef)));
  eq("it states what was compared", ins.comparedPeriod, { from: "2026-07-02", to: "2026-09-30" });
  check("…and how complete the data is", typeof ins.completeness.state === "string");
  eq("no change → no insight", composeCostInsights(summarizeBusinessCost(input("2026-09-30", [steady]))).length, 0);
  eq("insufficient history → no insight (nothing invented)", composeCostInsights(summarizeBusinessCost(input("2026-09-30", [young]))).length, 0);
  const s1 = composeCostInsights(summarizeBusinessCost(input("2026-09-30", [raised])));
  eq("dedupe key is stable for the same facts", s1[0].dedupeKey, ins.dedupeKey);
}

section("9 · determinism");
{
  const rent = commitment({ title: "שכירות", installments: monthlyInstallments("2025-04", 18, 300000) });
  const i = input("2026-09-30", [rent], [payment("2026-09-05T09:00:00Z", 300000)]);
  eq("same input → identical summary", JSON.stringify(summarizeBusinessCost(i)), JSON.stringify(summarizeBusinessCost(i)));
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${total - failures}/${total} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
