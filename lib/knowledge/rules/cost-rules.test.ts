/* eslint-disable @typescript-eslint/no-explicit-any -- reads heterogeneous measure-detail JSON in assertions */
/**
 * Business Cost learning, Wave 1 — pure proofs. No database.
 *   node_modules/.bin/tsx lib/knowledge/rules/cost-rules.test.ts
 *
 * Each policy is proven on what it MUST detect and, at least as carefully, on what it must NOT:
 * one-off deviations, variable bills, future changes, backfilled history, continuations, immaterial
 * additions, unreliable prior baselines, records that merely stopped, releases that never took effect.
 */
import fs from "node:fs";
import path from "node:path";
import type { CostCommitment, CostInstallment, CostPayment } from "@/lib/services/business-cost/business-cost-core";
import {
  assessCostCompleteness,
  COST_POLICY_CATALOGUE,
  COST_POLICY_PARAMS,
  deriveCostCompleteness,
  deriveEndedCommitment,
  deriveNewMaterialCommitment,
  deriveRecurringAmountChange,
  type CostAuditEvent,
  type CostLedgerSnapshot,
} from "./cost";
import { catalogueDescriptors } from "../registry";
import { composeCostInsights, money, date } from "../cost-insight-composer";
import { composeInsights, type ComposerInput } from "../insight-composer";
import { isGrounded, ungroundedClaims } from "../insight-grounding";
import type { MeasureResult } from "../measure.contract";

let failures = 0;
let total = 0;
function ok(name: string, cond: boolean, extra: unknown = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${cond || extra === "" ? "" : " — " + JSON.stringify(extra)}`);
}
const section = (t: string) => console.log(`\n${t}`);

const BIZ = 7;
const NOW = new Date("2026-10-01T09:00:00Z"); // asOf = 2026-10-01 (Israel)
let id = 100;
const next = () => ++id;

function inst(dueDate: string, amountMinor: number, extra: Partial<CostInstallment> = {}): CostInstallment {
  return { id: next(), sequence: 1, dueDate, amountMinor, currency: "ILS", status: "SCHEDULED", ...extra };
}
function com(extra: Partial<CostCommitment> & { installments: CostInstallment[] }): CostCommitment {
  return {
    source: "COMMITMENT", id: next(), title: "x", payeeName: "x", payeeKind: null, currency: "ILS",
    scheduleKind: "RECURRING", recurrence: "MONTHLY", recurrenceSeriesId: null, status: "ACTIVE",
    isLegacy: false, endDate: null, ...extra,
    installments: extra.installments.map((i, k) => ({ ...i, sequence: k + 1 })),
  };
}
/** Monthly occurrences on `day` from YYYY-MM for n months; those before PAID_BEFORE are fully paid. */
function monthly(from: string, n: number, amount: number | ((k: number) => number), day = "01", paidBefore = "2026-10-01"): CostInstallment[] {
  const [y0, m0] = from.split("-").map(Number);
  return Array.from({ length: n }, (_, k) => {
    const y = y0 + Math.floor((m0 - 1 + k) / 12);
    const m = ((m0 - 1 + k) % 12) + 1;
    const d = `${y}-${String(m).padStart(2, "0")}-${day}`;
    const a = typeof amount === "function" ? amount(k) : amount;
    return inst(d, a, d < paidBefore ? { paidMinor: a } : {});
  });
}
/** A payment for every paid installment, allocated to it, on its due date. */
function paymentsFor(...cs: CostCommitment[]): CostPayment[] {
  return cs.flatMap((c) =>
    c.installments
      .filter((i) => (i.paidMinor ?? 0) > 0)
      .map((i) => ({ id: next(), paidAt: new Date(`${i.dueDate}T09:00:00Z`), amountMinor: i.paidMinor!, currency: "ILS", status: "RECORDED" as const, payeeName: "x", method: "BANK_TRANSFER", allocations: [{ installmentId: i.id, commitmentId: c.id, amountMinor: i.paidMinor! }] })),
  );
}
function snap(commitments: CostCommitment[], opts: { payments?: CostPayment[]; created?: Record<number, string>; audit?: CostAuditEvent[]; affirmed?: boolean | null; businessId?: number } = {}): CostLedgerSnapshot {
  return {
    businessId: opts.businessId ?? BIZ,
    inputs: { timeZone: "Asia/Jerusalem", baseCurrency: "ILS", commitments, payments: opts.payments ?? paymentsFor(...commitments), ownerAffirmedBackboneCaptured: opts.affirmed ?? true },
    commitmentMeta: commitments.map((c) => ({ commitmentId: c.id, createdAt: new Date(`${opts.created?.[c.id] ?? c.installments[0]?.dueDate ?? "2025-01-01"}T08:00:00Z`) })),
    audit: opts.audit ?? [],
  };
}
const detail = (r: MeasureResult) => (r.detail ?? {}) as Record<string, any>;

/* ─────────────────────────────── COST-08 ──────────────────────────────── */
section("COST-08 · completeness is an eligibility gate, not calendar time");
{
  const rent = com({ installments: monthly("2025-09", 14, 300000) }); // Sep 2025 … Oct 2026, paid through Sep
  const full = assessCostCompleteness(snap([rent]), NOW);
  ok("a year of recorded, paid, allocated rent → 360 trustworthy days", full.eligibility.trustworthyHistoryDays === 360, full.eligibility.trustworthyHistoryDays);
  ok("…COST-06/07 would be eligible (180 needed) — they stay inactive", full.eligibility.perPolicy["COST-06"].eligible && full.eligibility.perPolicy["COST-07"].eligible);
  ok("…no gaps", full.eligibility.gaps.length === 0, full.eligibility.gaps);
  const m = deriveCostCompleteness([snap([rent])], NOW)[0];
  ok("measure is ACTIVE, value = trustworthy days, no trend (no 'better/worse')", m.status === "ACTIVE" && m.valueNumeric === 360 && m.trend === null);
  ok("evidence refs = installments + payments, all this business's", m.evidenceSet.refs.length === m.observationCount && m.evidenceSet.refs.every((r) => r.businessId === BIZ));

  // 180 calendar days of commitments in Dubiz, but no payment ever recorded.
  const unpaid = com({ installments: monthly("2026-04", 7, 300000, "01", "1900-01-01") });
  const u = assessCostCompleteness(snap([unpaid], { payments: [] }), NOW);
  ok("180+ calendar days with nothing recorded as paid → 0 trustworthy days", u.eligibility.trustworthyHistoryDays === 0, u.eligibility.trustworthyHistoryDays);
  ok("…COST-06/07 NOT eligible, with the reason", !u.eligibility.perPolicy["COST-06"].eligible && /TRUSTWORTHY_HISTORY_0_OF_180/.test(u.eligibility.perPolicy["COST-06"].reason));
  ok("…gap DUE_WITHOUT_RECORDED_PAYMENT", u.eligibility.gaps.includes("DUE_WITHOUT_RECORDED_PAYMENT"));

  const loose: CostPayment = { id: next(), paidAt: new Date("2026-09-20T09:00:00Z"), amountMinor: 500000, currency: "ILS", status: "RECORDED", payeeName: "x", method: "CASH", allocations: [] };
  const withLoose = assessCostCompleteness(snap([rent], { payments: [...paymentsFor(rent), loose] }), NOW);
  ok("cash not tied to any commitment → gap UNALLOCATED_CASH", withLoose.eligibility.gaps.includes("UNALLOCATED_CASH"), withLoose.components);
  const oneOff = com({ scheduleKind: "ONE_OFF", recurrence: "NONE", installments: [inst("2026-10-10", 120000)] });
  const usd = com({ currency: "USD", installments: monthly("2026-01", 9, 5000).map((i) => ({ ...i, currency: "USD" })) });
  const mixed = assessCostCompleteness(snap([rent, oneOff, usd], { payments: paymentsFor(rent), affirmed: false }), NOW);
  ok("one-off with unknown coverage / foreign currency / backbone not affirmed → each a named gap",
    ["ONE_OFF_COVERAGE_UNKNOWN", "FOREIGN_CURRENCY_EXCLUDED", "BACKBONE_NOT_AFFIRMED"].every((g) => mixed.eligibility.gaps.includes(g)), mixed.eligibility.gaps);
  const empty = deriveCostCompleteness([snap([], { payments: [] })], NOW)[0];
  ok("no cost data → INSUFFICIENT_EVIDENCE, no value", empty.status === "INSUFFICIENT_EVIDENCE" && empty.valueNumeric === null);
  // Quarterly: most 30-day windows have nothing due. They must neither confirm nor break history.
  const quarterly = com({ recurrence: "QUARTERLY", installments: ["2025-10-15", "2026-01-15", "2026-04-15", "2026-07-15"].map((d) => inst(d, 600000, { paidMinor: 600000 })) });
  const q = assessCostCompleteness(snap([quarterly]), NOW);
  ok("windows with nothing due (quarterly) neither confirm nor break trustworthy history",
    q.eligibility.windows.some((w) => w.covered === null) && q.eligibility.trustworthyHistoryDays >= 330, { days: q.eligibility.trustworthyHistoryDays, w: q.eligibility.windows.map((w) => w.covered) });
  const brokenQ = com({ recurrence: "QUARTERLY", installments: [inst("2025-10-15", 600000, { paidMinor: 600000 }), inst("2026-01-15", 600000), inst("2026-04-15", 600000, { paidMinor: 600000 }), inst("2026-07-15", 600000, { paidMinor: 600000 })] });
  const bq = assessCostCompleteness(snap([brokenQ]), NOW);
  ok("…but an unpaid due window ends it (history stops at January's unrecorded payment)", bq.eligibility.trustworthyHistoryDays > 0 && bq.eligibility.trustworthyHistoryDays < 270, bq.eligibility.trustworthyHistoryDays);
}

/* ─────────────────────────────── COST-02 ──────────────────────────────── */
section("COST-02 · a recorded recurring amount change — and everything that is not one");
{
  const rentInst = monthly("2026-03", 8, (k) => (k >= 6 ? 880000 : 800000)); // Mar…Oct; Sep and Oct at 8,800
  const rent = com({ installments: rentInst });
  const sep = rentInst[6];
  const audit: CostAuditEvent[] = [{ id: 9001, eventType: "INSTALLMENT_AMOUNT_CHANGED", commitmentId: rent.id, installmentId: sep.id, occurredAt: new Date("2026-08-20T10:00:00Z"), metadata: { before: "8000", after: "8800.00", effectiveFrom: "2026-09-01T00:00:00.000Z" } }];
  const [m] = deriveRecurringAmountChange([snap([rent], { audit })], NOW);
  ok("explicit amount change → ACTIVE, +800 a month", m?.status === "ACTIVE" && m.valueNumeric === 800, m?.valueNumeric);
  ok("…from 8,000 to 8,800 from 1/9/2026, confirmed explicitly", detail(m).fromMinor === 800000 && detail(m).toMinor === 880000 && detail(m).effectiveDate === "2026-09-01" && detail(m).confirmation === "EXPLICIT_AMOUNT_CHANGE");
  ok("…evidence: before + after occurrences + the audit event", m.evidenceSet.refs.some((r) => r.kind === "payables-audit-event" && r.recordId === 9001) && m.evidenceSet.refs.some((r) => r.recordId === sep.id));
  ok("…attached to the commitment", m.entityType === "commitment" && m.entityId === rent.id);

  const acc = com({ installments: monthly("2026-05", 5, (k) => (k >= 3 ? 135000 : 120000)) }); // Aug, Sep at 1,350
  const [a] = deriveRecurringAmountChange([snap([acc])], NOW);
  ok("two consecutive occurrences at the new amount (no event) → ACTIVE, +150", a?.status === "ACTIVE" && a.valueNumeric === 150 && detail(a).confirmation === "REPEATED_OCCURRENCES");

  const once = com({ installments: monthly("2026-05", 5, (k) => (k === 4 ? 135000 : 120000)) }); // only Sep differs
  ok("one occurrence at a new amount, no event → nothing (not confirmed yet)", deriveRecurringAmountChange([snap([once])], NOW).length === 0);
  const revert = com({ installments: monthly("2026-05", 5, (k) => (k === 2 ? 150000 : 120000)) });
  ok("a one-off deviation that returns to its amount → nothing", deriveRecurringAmountChange([snap([revert])], NOW).length === 0);
  const elec = com({ installments: monthly("2026-04", 6, (k) => [40000, 52000, 38000, 61000, 45000, 47000][k]) });
  ok("a variable bill (electricity) → nothing", deriveRecurringAmountChange([snap([elec])], NOW).length === 0);
  const future = com({ installments: monthly("2026-07", 6, (k) => (k >= 4 ? 990000 : 900000)) }); // change from Nov
  ok("a change that has not taken effect yet → nothing", deriveRecurringAmountChange([snap([future])], NOW).length === 0);
  const old = com({ installments: monthly("2024-06", 28, (k) => (k >= 2 ? 330000 : 300000)) }); // change Aug 2024
  ok("a change older than the 365-day lookback → nothing", deriveRecurringAmountChange([snap([old])], NOW).length === 0);
  const legacy = com({ source: "LEGACY_OBLIGATION", installments: monthly("2026-05", 5, (k) => (k >= 3 ? 135000 : 120000)) });
  ok("legacy-bridge rows → nothing (Wave 1 reads the ledger only)", deriveRecurringAmountChange([snap([legacy])], NOW).length === 0);
  const usd = com({ currency: "USD", installments: monthly("2026-05", 5, (k) => (k >= 3 ? 1350 : 1200)).map((i) => ({ ...i, currency: "USD" })) });
  ok("foreign currency → nothing (never converted)", deriveRecurringAmountChange([snap([usd])], NOW).length === 0);
}

/* ─────────────────────────────── COST-04 ──────────────────────────────── */
section("COST-04 · a genuinely new, material recurring commitment");
{
  const rent = com({ installments: monthly("2025-10", 13, 965000) });
  const leasing = com({ installments: monthly("2026-09", 2, 240000, "15") }); // first due 15/9, created 10/9
  const s = snap([rent, leasing], { created: { [leasing.id]: "2026-09-10" } });
  const [m] = deriveNewMaterialCommitment([s], NOW);
  ok("new leasing 2,400 against 9,650 → ACTIVE, 24.87% (≥ 5%)", m?.status === "ACTIVE" && m.valueNumeric === 2400 && detail(m).shareBp === 2487, m && detail(m));
  ok("…prior baseline and its covered window are recorded", detail(m).priorBaselineMonthlyMinor === 965000 && detail(m).priorWindow.covered === true);

  const exactly = com({ installments: monthly("2026-09", 2, 48250, "15") });
  ok("exactly 5% → material (≥)", deriveNewMaterialCommitment([snap([rent, exactly], { created: { [exactly.id]: "2026-09-10" } })], NOW)[0]?.status === "ACTIVE");
  const small = com({ installments: monthly("2026-09", 2, 40000, "15") });
  ok("4.1% → nothing (not material)", deriveNewMaterialCommitment([snap([rent, small], { created: { [small.id]: "2026-09-10" } })], NOW).length === 0);
  const backfill = com({ installments: monthly("2026-07", 4, 240000, "15") });
  ok("first due 15/7 but recorded 1/10 (78 days later) → nothing: newly RECORDED, not new",
    deriveNewMaterialCommitment([snap([rent, backfill], { created: { [backfill.id]: "2026-10-01" } })], NOW).length === 0);
  const sid = "series-1";
  const contA = com({ recurrenceSeriesId: sid, installments: monthly("2026-05", 3, 240000, "15") });
  const contB = com({ recurrenceSeriesId: sid, installments: monthly("2026-09", 2, 240000, "15") });
  ok("a later row of an existing series → nothing (a continuation)",
    deriveNewMaterialCommitment([snap([rent, contA, contB], { created: { [contB.id]: "2026-09-10" } })], NOW).filter((r) => r.entityId === contB.id).length === 0);
  const firstEver = com({ installments: monthly("2026-09", 2, 240000, "15") });
  const fe = deriveNewMaterialCommitment([snap([firstEver], { created: { [firstEver.id]: "2026-09-10" } })], NOW)[0];
  ok("the business's first commitment → INSUFFICIENT_EVIDENCE: NO_PRIOR_BASELINE (never 'material')", fe?.status === "INSUFFICIENT_EVIDENCE" && detail(fe).reason === "NO_PRIOR_BASELINE");
  const unpaidRent = com({ installments: monthly("2025-10", 13, 965000, "01", "1900-01-01") });
  const nr = deriveNewMaterialCommitment([snap([unpaidRent, leasing], { payments: [], created: { [leasing.id]: "2026-09-10" } })], NOW).find((r) => r.entityId === leasing.id);
  ok("prior baseline exists but its window is not covered → INSUFFICIENT_EVIDENCE: PRIOR_BASELINE_NOT_RELIABLE", nr?.status === "INSUFFICIENT_EVIDENCE" && detail(nr!).reason === "PRIOR_BASELINE_NOT_RELIABLE");
  const loan = com({ payeeKind: "LENDER", installments: monthly("2026-09", 2, 240000, "15") });
  ok("a loan repayment (debt service) → nothing", deriveNewMaterialCommitment([snap([rent, loan], { created: { [loan.id]: "2026-09-10" } })], NOW).length === 0);
  const notYet = com({ installments: monthly("2026-10", 2, 240000, "15") });
  ok("first due after today → nothing yet", deriveNewMaterialCommitment([snap([rent, notYet], { created: { [notYet.id]: "2026-09-30" } })], NOW).length === 0);
}

/* ─────────────────────────────── COST-05 ──────────────────────────────── */
section("COST-05 · explicitly ended — never inferred");
{
  const sw = com({ endDate: "2026-09-30", installments: [...monthly("2026-03", 7, 45000), inst("2026-10-01", 45000, { status: "CANCELLED" })] });
  const end: CostAuditEvent = { id: 9100, eventType: "COMMITMENT_ENDED", commitmentId: sw.id, installmentId: null, occurredAt: new Date("2026-09-25T10:00:00Z"), metadata: { endsOn: "2026-09-30T00:00:00.000Z", endAtBefore: null, cancelledInstallments: [1] } };
  const [m] = deriveEndedCommitment([snap([sw], { audit: [end] })], NOW);
  ok("explicit end on 30/9 → ACTIVE, 450 a month left the fixed cost", m?.status === "ACTIVE" && m.valueNumeric === 450 && detail(m).endsOn === "2026-09-30");
  ok("…evidence: the end event and the last occurrence", m.evidenceSet.refs.some((r) => r.kind === "payables-audit-event" && r.recordId === 9100));
  const stopped = com({ installments: monthly("2026-01", 2, 45000) }); // Jan, Feb, then nothing
  ok("records that simply stopped (no end event) → nothing", deriveEndedCommitment([snap([stopped])], NOW).length === 0);
  const released = com({ status: "RELEASED", endDate: "2026-09-30", installments: [inst("2026-09-15", 45000, { status: "CANCELLED" })] });
  ok("released before anything took effect → nothing", deriveEndedCommitment([snap([released], { audit: [{ ...end, id: 9101, commitmentId: released.id }] })], NOW).length === 0);
  const moved = com({ endDate: "2026-12-31", installments: monthly("2026-03", 7, 45000) });
  ok("an end that was moved since the event → nothing", deriveEndedCommitment([snap([moved], { audit: [{ ...end, id: 9102, commitmentId: moved.id }] })], NOW).length === 0);
  const futureEnd = com({ endDate: "2026-12-31", installments: monthly("2026-03", 7, 45000) });
  ok("an end that has not happened yet → nothing", deriveEndedCommitment([snap([futureEnd], { audit: [{ ...end, id: 9103, commitmentId: futureEnd.id, metadata: { endsOn: "2026-12-31T00:00:00.000Z" } }] })], NOW).length === 0);
  const longAgo = com({ endDate: "2026-02-28", installments: monthly("2025-10", 5, 45000) });
  ok("ended more than 90 days ago → nothing", deriveEndedCommitment([snap([longAgo], { audit: [{ ...end, id: 9104, commitmentId: longAgo.id, metadata: { endsOn: "2026-02-28T00:00:00.000Z" } }] })], NOW).length === 0);
  const neverRan = com({ endDate: "2026-09-10", installments: [inst("2026-09-20", 45000, { status: "CANCELLED" })] });
  ok("ended before its first occurrence → nothing (it never took effect)", deriveEndedCommitment([snap([neverRan], { audit: [{ ...end, id: 9105, commitmentId: neverRan.id, metadata: { endsOn: "2026-09-10T00:00:00.000Z" } }] })], NOW).length === 0);
}

/* ─────────────────────────────── composers ────────────────────────────── */
section("Insights · FACT only, deterministic, every number grounded");
{
  const rentInst = monthly("2026-03", 8, (k) => (k >= 6 ? 880000 : 800000));
  const rent = com({ title: "שכירות", installments: rentInst });
  const leasing = com({ title: "ליסינג", installments: monthly("2026-09", 2, 240000, "15") });
  const sw = com({ title: "תוכנה", endDate: "2026-09-30", installments: monthly("2026-03", 7, 45000) });
  const audit: CostAuditEvent[] = [
    { id: 9201, eventType: "INSTALLMENT_AMOUNT_CHANGED", commitmentId: rent.id, installmentId: rentInst[6].id, occurredAt: NOW, metadata: { after: "8800.00" } },
    { id: 9202, eventType: "COMMITMENT_ENDED", commitmentId: sw.id, installmentId: null, occurredAt: NOW, metadata: { endsOn: "2026-09-30T00:00:00.000Z" } },
  ];
  const s = snap([rent, leasing, sw], { audit, created: { [leasing.id]: "2026-09-10" }, affirmed: false });
  const measures = [
    ...deriveCostCompleteness([s], NOW),
    ...deriveRecurringAmountChange([s], NOW),
    ...deriveNewMaterialCommitment([s], NOW),
    ...deriveEndedCommitment([s], NOW),
  ].filter((m) => m.status === "ACTIVE");
  const input: ComposerInput = {
    businessId: BIZ,
    facts: [],
    activeMeasures: measures.map((m, i) => ({ measureKey: m.measureKey, valueNumeric: m.valueNumeric!, valueUnit: m.valueUnit, observationCount: m.observationCount, trend: m.trend, ruleVersion: "v1", measureId: 500 + i, entityType: m.entityType, entityId: m.entityId, detail: m.detail })),
    entityLabels: { [`commitment:${rent.id}`]: "שכירות", [`commitment:${leasing.id}`]: "ליסינג", [`commitment:${sw.id}`]: "תוכנה" },
  };
  const drafts = composeCostInsights(input);
  const by = (k: string) => drafts.find((d) => d.insightKey === k)!;
  ok("one insight per fact: amount change, new commitment, ended commitment, data completeness",
    ["cost.recurring_amount_changed", "cost.new_material_commitment", "cost.ended_commitment", "cost.data_completeness"].every((k) => !!by(k)), drafts.map((d) => d.insightKey));
  ok("amount change reads from the evidence", by("cost.recurring_amount_changed").factLines[0].text === "הסכום השתנה מ־8,000 ₪ ל־8,800 ₪ החל מ־1/9/2026");
  ok("new commitment reads its size and share", by("cost.new_material_commitment").factLines.map((f) => f.text).join(" | ") === `2,400 ₪ לחודש, החל מ־15/9/2026 | ${by("cost.new_material_commitment").factLines[1].text}`);
  ok("ended commitment reads the recorded end and the monthly amount", by("cost.ended_commitment").factLines[1].text === "450 ₪ לחודש יצאו מהעלות הקבועה");
  ok("FACT only: no interpretation and no suggested action on any cost insight", drafts.every((d) => d.interpretation === null && d.suggestedActions.length === 0));
  ok("every contributing rule is marked FACT", drafts.every((d) => d.contributingRules.every((r) => r.level === "FACT")));
  const FORBIDDEN = /בגלל|כי |טוב|רע|חיסכון|חסכת|רווח|הפסד|מומלץ|כדאי|צמיחה|בעיה|לא תוכל|תזרים|מסוכן|הצלחה|כישלון|כוונה/;
  ok("no cause, judgement, profit, affordability or intent wording anywhere", drafts.every((d) => !FORBIDDEN.test([d.title, ...d.factLines.map((f) => f.text), d.uncertainty ?? ""].join(" "))));
  // Every number and date shown must be one that the measure's evidence carries.
  for (const d of drafts) {
    const m = input.activeMeasures.find((x) => d.contributingRules[0].artifactRef === `knowledge-measure:${x.measureId}`)!;
    const det = (m.detail ?? {}) as Record<string, any>;
    const grounding = Object.entries(det).flatMap(([k, v]) =>
      typeof v === "number" ? [k.endsWith("Minor") ? money(v) : String(v), String(v / 100)] :
      typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? [date(v)] : [],
    );
    const comp = det.components ?? {};
    const extra = [money(comp.recentUnallocatedCashMinor ?? 0), String(comp.recentDays ?? ""), String(comp.uncertainOneOffCount ?? ""), String(comp.foreignCurrencySeries ?? ""), String(det.trustworthyHistoryDays ?? ""), ...((det.windows ?? []).slice(0, 1).flatMap((w: any) => [money(w.paidOfDueMinor), money(w.dueMinor)])), (det.shareBp ? `${(det.shareBp / 100).toLocaleString("he-IL", { maximumFractionDigits: 1 })}%` : ""), "30", "90"];
    const text = [d.title, ...d.factLines.map((f) => f.text)].join("\n");
    const bad = ungroundedClaims(text, [...grounding, ...extra]);
    ok(`${d.insightKey}: every number and date is grounded in its measure`, bad.length === 0, bad);
  }
  ok("data gaps make the fact insights say they rest only on what was recorded", by("cost.recurring_amount_changed").uncertainty?.includes("רק על מה שנרשם") === true);
  const noGate = composeCostInsights({ ...input, activeMeasures: input.activeMeasures.filter((m) => m.measureKey !== "payables.cost_data_completeness") });
  ok("without COST-08 the insight says completeness is unknown", noGate[0]?.uncertainty === "לא ידוע עד כמה נתוני העלות של העסק מלאים.");
  ok("dedupe keys are stable for the same facts", JSON.stringify(composeCostInsights(input).map((d) => d.dedupeKey)) === JSON.stringify(drafts.map((d) => d.dedupeKey)));
  ok("an unnamed commitment is never given a guessed name", composeCostInsights({ ...input, entityLabels: {} }).find((d) => d.insightKey === "cost.ended_commitment")?.title === "התחייבות קבועה הסתיימה: התחייבות");
  ok("the existing composition is unaffected (no facts, no cost measures → no drafts)", composeInsights({ businessId: BIZ, facts: [], activeMeasures: [] }).length === 0);
}

section("AI grounding guard (kept for later waves; unused in Wave 1)");
{
  const facts = ["הסכום השתנה מ־8,000 ₪ ל־8,800 ₪ החל מ־1/9/2026"];
  ok("a faithful rephrasing passes", isGrounded("שכר הדירה עלה ל־8,800 ₪ מ־1/9/2026, לעומת 8,000 ₪", facts));
  ok("an invented amount is caught", ungroundedClaims("עלה ב־900 ₪", facts).some((v) => v.kind === "number" && v.token === "900"));
  ok("an invented date is caught", ungroundedClaims("החל מ־1/10/2026", facts).some((v) => v.kind === "date"));
  ok("another entity's name is caught", ungroundedClaims("הליסינג עלה ל־8,800 ₪", facts, ["ליסינג", "שכירות"]).some((v) => v.kind === "entity"));
}

/* ─────────────────────────── catalogue & purity ────────────────────────── */
section("Catalogue, versions, migration and purity");
{
  const active = COST_POLICY_CATALOGUE.filter((e) => e.status === "ACTIVE");
  ok("Wave 1 = exactly COST-08, COST-02, COST-04, COST-05", JSON.stringify(active.map((e) => e.ruleId).sort()) === JSON.stringify(["COST-02", "COST-04", "COST-05", "COST-08"]));
  const registered = catalogueDescriptors().filter((d) => d.ruleId.startsWith("COST-") || d.ruleId === "T-AP-03");
  ok("only the active ones are in the knowledge catalogue", JSON.stringify(registered.map((d) => d.ruleId).sort()) === JSON.stringify(active.map((e) => e.ruleId).sort()));
  ok("COST-01/03/06/07 and T-AP-03 are defined but INACTIVE", ["COST-01", "COST-03", "COST-06", "COST-07", "T-AP-03"].every((r) => COST_POLICY_CATALOGUE.find((e) => e.ruleId === r)?.status === "INACTIVE"));
  ok("COST-09 blocked, COST-10 deferred, COST-11/12 future", COST_POLICY_CATALOGUE.find((e) => e.ruleId === "COST-09")?.status === "BLOCKED" && COST_POLICY_CATALOGUE.find((e) => e.ruleId === "COST-10")?.status === "DEFERRED" && ["COST-11", "COST-12"].every((r) => COST_POLICY_CATALOGUE.find((e) => e.ruleId === r)?.status === "FUTURE"));
  const sql = fs.readFileSync(path.join(process.cwd(), "prisma/migrations/20261005090000_cost_learning_wave1_policies/migration.sql"), "utf8");
  ok("every active policy has its lineage + v1 in the migration, and no inactive one does",
    active.every((e) => sql.includes(`'${e.policyKey}'`)) && !/baseline-shift|cadence-change|upcoming|cash-out/.test(sql));
  ok("the migration only inserts governance rows (no DDL, no RLS, no grants)", !/(CREATE|ALTER|DROP|GRANT|REVOKE|POLICY|TABLE|INDEX)/i.test(sql.replace(/--.*$/gm, "")));
  ok("every active policy has versioned parameters", active.every((e) => (COST_POLICY_PARAMS as Record<string, { v1: object }>)[e.policyKey!]?.v1));
  ok("COST-04 threshold is the owner's 5% of the previous baseline", COST_POLICY_PARAMS["payables-new-material-commitment"].v1.materialShareOfPriorBaseline === 0.05);
  const code = fs.readFileSync(path.join(__dirname, "cost.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  ok("cost.ts imports no Prisma and opens no transaction", !/@prisma\/client|lib\/prisma|tenantTx/.test(code));
  ok("cost.ts reads no clock and no env", !/Date\.now\(\)|new Date\(\)|process\.env/.test(code));
  ok("cost.ts declares no confidence score", !/confidence\s*[:=]/i.test(code));
}

section("Tenant isolation, by construction");
{
  const a = com({ installments: monthly("2025-10", 13, 965000) });
  const b = com({ installments: monthly("2025-10", 13, (k) => (k >= 11 ? 2000000 : 900000)) });
  const sA = snap([a]);
  const onlyA = [deriveCostCompleteness, deriveRecurringAmountChange, deriveNewMaterialCommitment, deriveEndedCommitment].flatMap((f) => f([sA], NOW));
  ok("A's derivation sees A only: no change where B has one", onlyA.filter((m) => m.measureKey === "payables.recurring_amount_change").length === 0);
  ok("every evidence ref carries A's business id", onlyA.every((m) => m.evidenceSet.refs.every((r) => r.businessId === BIZ)));
  const bOut = deriveRecurringAmountChange([snap([b], { businessId: 8 })], NOW);
  ok("B's own change is B's, tagged with B's id", bOut.length === 1 && bOut[0].evidenceSet.refs.every((r) => r.businessId === 8));
  const again = [deriveCostCompleteness, deriveRecurringAmountChange, deriveNewMaterialCommitment, deriveEndedCommitment].flatMap((f) => f([sA], NOW));
  ok("deterministic: same snapshot, byte-identical measures", JSON.stringify(again) === JSON.stringify(onlyA));
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${total - failures}/${total} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
