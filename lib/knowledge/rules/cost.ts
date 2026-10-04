/**
 * Business Cost learning — Wave 1. PURE: rows and a clock reading in, measures out.
 *
 *   Ledger truth ─► Business Cost engine (deterministic) ─► these rules (deterministic, versioned)
 *                ─► KnowledgeMeasure ─► cost composers (deterministic Hebrew, FACT only) ─► BusinessInsight
 *
 * Every figure here comes from the SAME engine as /api/business-cost: coverage, baseline and
 * normalisation are never computed a second way.
 *
 * ACTIVE IN WAVE 1
 *   COST-08  payables.cost_data_completeness   how far this business's cost data can be relied on — an
 *                                              ELIGIBILITY GATE, not a disclaimer
 *   COST-02  payables.recurring_amount_change  a recorded recurring cost changed amount
 *   COST-04  payables.new_material_commitment  a genuinely new recurring commitment, material against
 *                                              the business's own previous baseline
 *   COST-05  payables.ended_commitment         a recurring commitment that was EXPLICITLY ended
 *
 * WAVE 2 — PATTERN (comparison with THIS business's own history only; gated by COST-08):
 *   COST-01  payables.baseline_shift            a sustained change in the recorded monthly baseline
 *   COST-06  payables.upcoming_concentration    what falls due in the next 30 days vs every covered
 *                                               historical 30-day window
 *   COST-07  payables.cash_out_above_range      recorded cash out in the last 30 days ABOVE every covered
 *                                               historical window (never "below": an unrecorded payment
 *                                               and lower spend are indistinguishable)
 * A PATTERN measure is ACTIVE when the business is eligible and the comparison was made — with
 * `detail.detected` saying whether the pattern holds — and INSUFFICIENT_EVIDENCE when COST-08 says
 * the history cannot carry the comparison. History is the COVERED windows only: calendar time is not.
 *
 * DEFINED, NOT ACTIVE (`COST_POLICY_CATALOGUE`): COST-03, and the blocked / deferred / future ones.
 * T-AP-03 is BLOCKED: see its catalogue note.
 *
 * FACT ≠ PATTERN ≠ MEANING
 *   Wave-1 measures are FACTS: a recorded change, a recorded new commitment and its size relative to
 *   the business's own previous baseline, a recorded end. None of them says why, whether it is good or
 *   bad, what it does to profit, or whether the business can afford it. Nothing here produces MEANING.
 *
 * WHAT IS DELIBERATELY NOT CONCLUDED
 *   - an end from records that stopped appearing (only an explicit COMMITMENT_ENDED counts);
 *   - a "new" cost from a commitment recorded long after it started (backfill is not news);
 *   - a "change" from a single edited occurrence that returns to its amount (a one-off deviation);
 *   - a change in a series whose amount moves all the time (variable bills — COST-02 stays silent);
 *   - anything about the legacy bridge's BusinessObligation rows (Wave 1 reads ledger Commitments).
 */
import {
  civilDateInZone,
  fromDayNumber,
  natureOf,
  normalizedEquivalentMinor,
  parseCadence,
  seriesKeyOf,
  toDayNumber,
  deriveBusinessCostForDate,
  type BusinessCostInput,
  type CostCommitment,
  type CostInstallment,
} from "@/lib/services/business-cost/business-cost-core";
import { baselineViews, upcomingObligations } from "@/lib/services/business-cost/business-cost-intelligence";
import type { EvidenceSource, KnowledgeRule, RuleDescriptor } from "../rule.contract";
import type { MeasureEvidenceRef, MeasureResult } from "../measure.contract";
import { measureFingerprint } from "../measure.contract";

/* ─────────────────────────────── observation ──────────────────────────────── */

export type CostAuditEvent = {
  readonly id: number;
  readonly eventType: "INSTALLMENT_AMOUNT_CHANGED" | "COMMITMENT_ENDED";
  readonly commitmentId: number | null;
  readonly installmentId: number | null;
  readonly occurredAt: Date;
  readonly metadata: Record<string, unknown> | null;
};

/**
 * One business's cost ledger, loaded once per derivation: the Business Cost engine's own inputs plus
 * what the engine does not need — when each commitment was RECORDED, and the audit events that make
 * a change or an end explicit. One observation per business; every rule reads the same one.
 */
export type CostLedgerSnapshot = {
  readonly businessId: number;
  readonly inputs: Omit<BusinessCostInput, "date">;
  readonly commitmentMeta: readonly { readonly commitmentId: number; readonly createdAt: Date }[];
  readonly audit: readonly CostAuditEvent[];
};

/** Payments the source must load: 13 completed 30-day windows plus the current one. */
export const COST_SOURCE_WINDOW_DAYS = 400;

export function makeCostLedgerSource(
  load: EvidenceSource<CostLedgerSnapshot>["load"],
): EvidenceSource<CostLedgerSnapshot> {
  return { key: "payables.cost_ledger", windowDays: COST_SOURCE_WINDOW_DAYS, load };
}

/* ─────────────────────────── versioned parameters ─────────────────────────── */

/**
 * Detection parameters, versioned WITH the policy lineage they belong to. A different threshold is a
 * new version label and a new lineage row — never an edit of v1 — so every stored measure states the
 * exact parameters it was derived under (`detail.params`). They are detection parameters, not
 * business truth.
 */
export const COST_POLICY_PARAMS = {
  "payables-cost-data-completeness": {
    v1: {
      /** One comparable window. */
      windowDays: 30,
      /** Completed windows examined, newest first. */
      completedWindows: 12,
      /** A window is covered when at least this share of what fell due in it is recorded as paid… */
      minPaidShareOfDue: 0.8,
      /** …and at least this share of the cash recorded in it is tied to a recorded commitment. */
      minAllocatedShareOfCash: 0.8,
      /** The recent span the cash-allocation gap is reported over. */
      recentDays: 90,
    },
  },
  "payables-recurring-amount-change": {
    v1: {
      lookbackDays: 365,
      /** Without an explicit amount-change event, the new amount must hold this many occurrences. */
      minOccurrencesAtNewAmount: 2,
      /** A series with this many amount changes among its last N occurrences is variable, not changed. */
      variableLookbackOccurrences: 6,
      variableMinChanges: 3,
    },
  },
  "payables-new-material-commitment": {
    v1: {
      lookbackDays: 90,
      /** Owner decision: 5% of the previous known monthly baseline. */
      materialShareOfPriorBaseline: 0.05,
      /** Recorded more than this long after its first due date = newly RECORDED, not new. */
      backfillGraceDays: 60,
    },
  },
  "payables-ended-commitment": { v1: { lookbackDays: 90 } },
  "payables-baseline-shift": {
    v1: {
      /** Compare the monthly baseline now with this many days ago. */
      lookbackDays: 90,
      /** Sustained: the new level must already have held, unchanged, for this many days. */
      sustainedDays: 30,
      /** Owner-approved detection parameter: |Δ| ≥ max(3% of the previous monthly baseline, one previous daily baseline). */
      minShareOfPriorMonthly: 0.03,
      minPriorDailyBaselines: 1,
      minTrustworthyHistoryDays: 90,
    },
  },
  "payables-upcoming-concentration": {
    v1: { horizonDays: 30, minCoveredWindows: 6, minTrustworthyHistoryDays: 180 },
  },
  "payables-cash-out-above-range": {
    v1: { windowDays: 30, minCoveredWindows: 6, minTrustworthyHistoryDays: 180 },
  },
} as const;

const P08 = COST_POLICY_PARAMS["payables-cost-data-completeness"].v1;
const P02 = COST_POLICY_PARAMS["payables-recurring-amount-change"].v1;
const P04 = COST_POLICY_PARAMS["payables-new-material-commitment"].v1;
const P05 = COST_POLICY_PARAMS["payables-ended-commitment"].v1;
const P01 = COST_POLICY_PARAMS["payables-baseline-shift"].v1;
const P06 = COST_POLICY_PARAMS["payables-upcoming-concentration"].v1;
const P07 = COST_POLICY_PARAMS["payables-cash-out-above-range"].v1;

/* ─────────────────────────────── the catalogue ────────────────────────────── */

export type CostPolicyLevel = "FACT" | "PATTERN";
export type CostPolicyEntry = {
  readonly ruleId: string;
  readonly measureKey: string | null;
  readonly policyKey: string | null;
  readonly level: CostPolicyLevel;
  readonly status: "ACTIVE" | "INACTIVE" | "BLOCKED" | "DEFERRED" | "FUTURE";
  /** Days of TRUSTWORTHY cost history (COST-08) required before the policy may conclude anything. */
  readonly minTrustworthyHistoryDays: number;
  readonly note: string;
};

/**
 * Every Business Cost policy, active or not. Only ACTIVE entries have a rule in the knowledge
 * catalogue and a lineage row in the database. The rest are here so eligibility is computed for them
 * today and Wave 2 is an addition, not a redesign.
 */
export const COST_POLICY_CATALOGUE: readonly CostPolicyEntry[] = [
  { ruleId: "COST-08", measureKey: "payables.cost_data_completeness", policyKey: "payables-cost-data-completeness", level: "FACT", status: "ACTIVE", minTrustworthyHistoryDays: 0, note: "eligibility gate" },
  { ruleId: "COST-02", measureKey: "payables.recurring_amount_change", policyKey: "payables-recurring-amount-change", level: "FACT", status: "ACTIVE", minTrustworthyHistoryDays: 0, note: "recorded fact" },
  { ruleId: "COST-04", measureKey: "payables.new_material_commitment", policyKey: "payables-new-material-commitment", level: "FACT", status: "ACTIVE", minTrustworthyHistoryDays: 0, note: "needs a covered window before the commitment started (checked per commitment)" },
  { ruleId: "COST-05", measureKey: "payables.ended_commitment", policyKey: "payables-ended-commitment", level: "FACT", status: "ACTIVE", minTrustworthyHistoryDays: 0, note: "explicit end only" },
  { ruleId: "COST-01", measureKey: "payables.baseline_shift", policyKey: "payables-baseline-shift", level: "PATTERN", status: "ACTIVE", minTrustworthyHistoryDays: 90, note: "v1: |Δ| ≥ max(3% of the previous monthly baseline, one previous daily baseline), held 30 days" },
  { ruleId: "COST-03", measureKey: null, policyKey: null, level: "FACT", status: "INACTIVE", minTrustworthyHistoryDays: 0, note: "cadence change" },
  { ruleId: "COST-06", measureKey: "payables.upcoming_concentration", policyKey: "payables-upcoming-concentration", level: "PATTERN", status: "ACTIVE", minTrustworthyHistoryDays: 180, note: "above every COVERED historical window (≥ 6)" },
  { ruleId: "COST-07", measureKey: "payables.cash_out_above_range", policyKey: "payables-cash-out-above-range", level: "PATTERN", status: "ACTIVE", minTrustworthyHistoryDays: 180, note: "above every COVERED historical window (≥ 6); never below" },
  { ruleId: "T-AP-03", measureKey: null, policyKey: null, level: "PATTERN", status: "BLOCKED", minTrustworthyHistoryDays: 180, note: "the Secretary's paid form defaults the payment date to the day it is recorded, so a MANUAL payment's paidAt can be the recording date: lateness over time would partly measure late recording. Needs paid-date provenance (owner-edited vs default) or externally-backed settlements before it may learn" },
  { ruleId: "COST-09", measureKey: null, policyKey: null, level: "PATTERN", status: "BLOCKED", minTrustworthyHistoryDays: 180, note: "needs classification history; 70% coverage is a proposal" },
  { ruleId: "COST-10", measureKey: null, policyKey: null, level: "FACT", status: "DEFERRED", minTrustworthyHistoryDays: 90, note: "descriptive only, after append-only behavioural history exists" },
  { ruleId: "COST-11", measureKey: null, policyKey: null, level: "PATTERN", status: "FUTURE", minTrustworthyHistoryDays: 730, note: "seasonality" },
  { ruleId: "COST-12", measureKey: null, policyKey: null, level: "FACT", status: "FUTURE", minTrustworthyHistoryDays: 0, note: "needs payee ↔ supplier identity" },
];

const SHARED: Pick<RuleDescriptor, "domain" | "versionLabel" | "valueUnit"> = {
  domain: "payables",
  versionLabel: "v1",
  valueUnit: "currency",
};

export const COST08: RuleDescriptor = {
  ...SHARED,
  ruleId: "COST-08",
  measureKey: "payables.cost_data_completeness",
  policyKey: "payables-cost-data-completeness",
  entityType: null,
  minSupport: 1,
  windowDays: P08.windowDays * P08.completedWindows,
  valueUnit: "days",
  freshness: ["NEW_EVIDENCE", "WINDOW_ROLLED", "EVIDENCE_REVERSED", "RULE_VERSION_CHANGED"],
  question: "How many days of this business's cost history can be relied on, and what is missing?",
};
export const COST02: RuleDescriptor = {
  ...SHARED,
  ruleId: "COST-02",
  measureKey: "payables.recurring_amount_change",
  policyKey: "payables-recurring-amount-change",
  entityType: "commitment",
  minSupport: 2,
  windowDays: P02.lookbackDays,
  freshness: ["NEW_EVIDENCE", "WINDOW_ROLLED", "EVIDENCE_REVERSED", "RULE_VERSION_CHANGED"],
  question: "Did a recorded recurring cost of this business change amount, from what to what, and from when?",
};
export const COST04: RuleDescriptor = {
  ...SHARED,
  ruleId: "COST-04",
  measureKey: "payables.new_material_commitment",
  policyKey: "payables-new-material-commitment",
  entityType: "commitment",
  minSupport: 1,
  windowDays: P04.lookbackDays,
  freshness: ["NEW_EVIDENCE", "WINDOW_ROLLED", "EVIDENCE_REVERSED", "RULE_VERSION_CHANGED"],
  question: "Did a genuinely new recurring commitment start that is material against this business's previous baseline?",
};
export const COST05: RuleDescriptor = {
  ...SHARED,
  ruleId: "COST-05",
  measureKey: "payables.ended_commitment",
  policyKey: "payables-ended-commitment",
  entityType: "commitment",
  minSupport: 2,
  windowDays: P05.lookbackDays,
  freshness: ["NEW_EVIDENCE", "WINDOW_ROLLED", "EVIDENCE_REVERSED", "RULE_VERSION_CHANGED"],
  question: "Was a recurring commitment of this business explicitly ended, and how much monthly cost left with it?",
};

/* ─────────────────────────────── shared helpers ───────────────────────────── */

type Occ = { inst: CostInstallment; c: CostCommitment; day: number };

const ref = (kind: string, businessId: number, recordId: number): MeasureEvidenceRef => ({ kind, businessId, recordId });
const toMajor = (minor: number) => Math.round(minor) / 100;

function sortRefs(refs: MeasureEvidenceRef[]): MeasureEvidenceRef[] {
  const seen = new Set<string>();
  return refs
    .filter((r) => {
      const k = `${r.kind}:${r.recordId}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.recordId - b.recordId));
}

function result(
  d: RuleDescriptor,
  businessId: number,
  entityId: number | null,
  status: "ACTIVE" | "INSUFFICIENT_EVIDENCE",
  valueMinorOrNumber: number | null,
  detail: Record<string, unknown>,
  refs: MeasureEvidenceRef[],
  windowStartDay: number,
  windowEndDay: number,
): MeasureResult {
  const sorted = sortRefs(refs);
  return {
    measureKey: d.measureKey,
    entityType: d.entityType,
    entityId,
    status,
    valueNumeric: status === "ACTIVE" ? valueMinorOrNumber : null,
    valueUnit: d.valueUnit,
    detail: { ruleId: d.ruleId, policy: { key: d.policyKey, version: d.versionLabel }, ...detail },
    observationCount: sorted.length,
    windowStart: new Date(windowStartDay * 86_400_000),
    windowEnd: new Date((windowEndDay + 1) * 86_400_000 - 1),
    // Cost measures never carry a direction of "better" or "worse": that would be MEANING.
    trend: null,
    evidenceSet: { businessId, refs: sorted, fingerprint: measureFingerprint(sorted) },
  };
}

function asOfOf(s: CostLedgerSnapshot, now: Date): number {
  return toDayNumber(civilDateInZone(now, s.inputs.timeZone));
}

/** Ledger commitments only (Wave 1 does not reason over legacy-bridge rows), grouped by series. */
function ledgerSeries(s: CostLedgerSnapshot): Array<{ key: string; members: CostCommitment[]; occ: Occ[] }> {
  const map = new Map<string, CostCommitment[]>();
  for (const c of s.inputs.commitments) {
    const k = seriesKeyOf(c);
    map.set(k, [...(map.get(k) ?? []), c]);
  }
  const out = [];
  for (const [key, members] of map) {
    if (members.some((m) => m.source !== "COMMITMENT")) continue;
    if (members.some((m) => m.currency !== s.inputs.baseCurrency)) continue;
    const occ = members
      .flatMap((c) => c.installments.filter((i) => i.status !== "CANCELLED").map((inst) => ({ inst, c, day: toDayNumber(inst.dueDate) })))
      .sort((a, b) => a.day - b.day || a.inst.sequence - b.inst.sequence || a.inst.id - b.inst.id);
    out.push({ key, members, occ });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/* ───────────────────── COST-08 · completeness / eligibility ───────────────── */

export type WindowCoverage = {
  readonly from: string;
  readonly to: string;
  readonly dueMinor: number;
  readonly paidOfDueMinor: number;
  readonly cashOutMinor: number;
  readonly allocatedCashMinor: number;
  /** null = nothing fell due, so there is nothing to judge the window by. */
  readonly covered: boolean | null;
};

/**
 * Is one window's cost record trustworthy? Two independent tests, both on recorded truth:
 *   what fell due in it was recorded as paid (allocations, or a legacy settlement), and
 *   the cash recorded in it is tied to recorded commitments.
 * Calendar time in Dubiz proves neither — a business can be here 180 days and have recorded nothing.
 */
export function windowCoverage(s: CostLedgerSnapshot, fromDay: number, toDay: number): WindowCoverage & { refs: MeasureEvidenceRef[] } {
  const p = P08;
  const refs: MeasureEvidenceRef[] = [];
  let due = 0;
  let paid = 0;
  for (const c of s.inputs.commitments) {
    if (c.currency !== s.inputs.baseCurrency || c.status === "RELEASED") continue;
    for (const i of c.installments) {
      if (i.status === "CANCELLED" || i.currency !== s.inputs.baseCurrency) continue;
      const d = toDayNumber(i.dueDate);
      if (d < fromDay || d > toDay) continue;
      due += i.amountMinor;
      paid += i.status === "SETTLED_LEGACY" ? i.amountMinor : Math.min(i.paidMinor ?? 0, i.amountMinor);
      if (c.source === "COMMITMENT") refs.push(ref("installment", s.businessId, i.id));
    }
  }
  let cash = 0;
  let allocated = 0;
  for (const pay of s.inputs.payments) {
    if (pay.status !== "RECORDED" || pay.currency !== s.inputs.baseCurrency) continue;
    const d = toDayNumber(civilDateInZone(pay.paidAt, s.inputs.timeZone));
    if (d < fromDay || d > toDay) continue;
    cash += pay.amountMinor;
    allocated += pay.allocations.reduce((x, a) => x + a.amountMinor, 0);
  }
  const covered =
    due === 0
      ? null
      : paid * 1 >= due * p.minPaidShareOfDue && (cash === 0 || allocated >= cash * p.minAllocatedShareOfCash);
  return { from: fromDayNumber(fromDay), to: fromDayNumber(toDay), dueMinor: due, paidOfDueMinor: paid, cashOutMinor: cash, allocatedCashMinor: allocated, covered, refs };
}

export type CostEligibility = {
  readonly trustworthyHistoryDays: number;
  readonly windows: readonly WindowCoverage[];
  readonly gaps: readonly string[];
  readonly perPolicy: Record<string, { readonly eligible: boolean; readonly reason: string }>;
};

/** The completed windows, newest first: [asOf−30k−29, asOf−30k], k = 1..N. The running window is not history yet. */
export function assessCostCompleteness(s: CostLedgerSnapshot, now: Date) {
  const p = P08;
  const asOf = asOfOf(s, now);
  const windows = [];
  const refs: MeasureEvidenceRef[] = [];
  for (let k = 1; k <= p.completedWindows; k++) {
    const to = asOf - p.windowDays * k;
    const w = windowCoverage(s, to - p.windowDays + 1, to);
    refs.push(...w.refs);
    windows.push({ from: w.from, to: w.to, dueMinor: w.dueMinor, paidOfDueMinor: w.paidOfDueMinor, cashOutMinor: w.cashOutMinor, allocatedCashMinor: w.allocatedCashMinor, covered: w.covered });
  }
  // Newest first. A covered window extends trustworthy history to its start; an UNCOVERED one ends
  // it; a window in which nothing fell due (between quarterly payments, or between two 1sts around a
  // 31-day month) is neither — it neither confirms nor refutes, so it is passed over.
  let lastCovered = 0;
  for (let k = 0; k < windows.length; k++) {
    if (windows[k].covered === false) break;
    if (windows[k].covered === true) lastCovered = k + 1;
  }
  const trustworthyHistoryDays = lastCovered * p.windowDays;

  // Recent cash and its tie to commitments.
  const recentFrom = asOf - p.recentDays + 1;
  let recentCash = 0;
  let recentAllocated = 0;
  for (const pay of s.inputs.payments) {
    if (pay.status !== "RECORDED" || pay.currency !== s.inputs.baseCurrency) continue;
    const d = toDayNumber(civilDateInZone(pay.paidAt, s.inputs.timeZone));
    if (d < recentFrom || d > asOf) continue;
    recentCash += pay.amountMinor;
    recentAllocated += pay.allocations.reduce((x, a) => x + a.amountMinor, 0);
    refs.push(ref("payment", s.businessId, pay.id));
  }
  const day = deriveBusinessCostForDate({ ...s.inputs, date: fromDayNumber(asOf) });
  const uncertainCount = day.uncertain.items.length;
  const foreignSeries = new Set(day.excluded.filter((e) => e.reason === "NON_BASE_CURRENCY").map((e) => `${e.source}:${e.commitmentId}`)).size;
  const legacySeries = new Set(s.inputs.commitments.filter((c) => c.source === "LEGACY_OBLIGATION").map((c) => seriesKeyOf(c))).size;
  const lastCompleted = windows[0];

  const gaps: string[] = [];
  if (recentCash > 0 && recentAllocated < recentCash * p.minAllocatedShareOfCash) gaps.push("UNALLOCATED_CASH");
  if (lastCompleted && lastCompleted.dueMinor > 0 && lastCompleted.paidOfDueMinor < lastCompleted.dueMinor * p.minPaidShareOfDue) gaps.push("DUE_WITHOUT_RECORDED_PAYMENT");
  if (uncertainCount > 0) gaps.push("ONE_OFF_COVERAGE_UNKNOWN");
  if (foreignSeries > 0) gaps.push("FOREIGN_CURRENCY_EXCLUDED");
  if (s.inputs.ownerAffirmedBackboneCaptured !== true) gaps.push("BACKBONE_NOT_AFFIRMED");

  const hasData = s.inputs.commitments.length > 0 || s.inputs.payments.length > 0;
  const perPolicy: Record<string, { eligible: boolean; reason: string }> = {};
  for (const e of COST_POLICY_CATALOGUE) {
    if (!hasData) perPolicy[e.ruleId] = { eligible: false, reason: "NO_COST_DATA" };
    else if (e.ruleId === "COST-04") perPolicy[e.ruleId] = { eligible: true, reason: "PER_COMMITMENT_PRIOR_WINDOW" };
    else if (trustworthyHistoryDays < e.minTrustworthyHistoryDays) perPolicy[e.ruleId] = { eligible: false, reason: `TRUSTWORTHY_HISTORY_${trustworthyHistoryDays}_OF_${e.minTrustworthyHistoryDays}_DAYS` };
    else perPolicy[e.ruleId] = { eligible: true, reason: "OK" };
  }

  return {
    asOf,
    hasData,
    refs,
    eligibility: { trustworthyHistoryDays, windows, gaps, perPolicy } as CostEligibility,
    components: {
      recentDays: p.recentDays,
      recentCashOutMinor: recentCash,
      recentAllocatedCashMinor: recentAllocated,
      recentUnallocatedCashMinor: recentCash - recentAllocated,
      uncertainOneOffCount: uncertainCount,
      uncertainOneOffMinor: day.uncertain.totalMinor,
      foreignCurrencySeries: foreignSeries,
      legacyBridgeSeries: legacySeries,
      ownerAffirmedBackbone: s.inputs.ownerAffirmedBackboneCaptured,
      engineCompleteness: day.completeness,
    },
  };
}

export function deriveCostCompleteness(observations: readonly CostLedgerSnapshot[], now: Date): MeasureResult[] {
  const s = observations[0];
  if (!s) return [];
  const a = assessCostCompleteness(s, now);
  const p = P08;
  const start = a.asOf - p.windowDays * p.completedWindows + 1;
  const detail = { params: p, trustworthyHistoryDays: a.eligibility.trustworthyHistoryDays, windows: a.eligibility.windows, gaps: a.eligibility.gaps, eligibility: a.eligibility.perPolicy, components: a.components };
  if (!a.hasData || a.refs.length === 0) {
    return [result(COST08, s.businessId, null, "INSUFFICIENT_EVIDENCE", null, { ...detail, minSupport: COST08.minSupport, have: a.refs.length }, a.refs, start, a.asOf)];
  }
  return [result(COST08, s.businessId, null, "ACTIVE", a.eligibility.trustworthyHistoryDays, detail, a.refs, start, a.asOf)];
}

/* ──────────────────── COST-02 · recurring amount changed ──────────────────── */

export function deriveRecurringAmountChange(observations: readonly CostLedgerSnapshot[], now: Date): MeasureResult[] {
  const s = observations[0];
  if (!s) return [];
  const p = P02;
  const asOf = asOfOf(s, now);
  const from = asOf - p.lookbackDays;
  const explicit = new Map<number, CostAuditEvent>();
  for (const e of s.audit) if (e.eventType === "INSTALLMENT_AMOUNT_CHANGED" && e.installmentId != null) explicit.set(e.installmentId, e);

  const out: MeasureResult[] = [];
  for (const g of ledgerSeries(s)) {
    if (g.members.some((m) => m.scheduleKind !== "RECURRING")) continue;
    const elapsed = g.occ.filter((o) => o.day <= asOf);
    if (elapsed.length < 2) continue;
    // Variable bills (electricity, water) move every time; a "change" there is noise, not news.
    const tail = elapsed.slice(-p.variableLookbackOccurrences);
    let moves = 0;
    for (let k = 1; k < tail.length; k++) if (tail[k].inst.amountMinor !== tail[k - 1].inst.amountMinor) moves += 1;
    const variable = moves >= p.variableMinChanges;

    for (let k = elapsed.length - 1; k >= 1; k--) {
      const before = elapsed[k - 1];
      const at = elapsed[k];
      if (at.inst.amountMinor === before.inst.amountMinor) continue;
      if (at.day < from) break;
      if (before.c.recurrence !== at.c.recurrence) break; // a cadence change is COST-03's, not this
      const event = explicit.get(at.inst.id);
      const confirmedExplicitly = !!event && String(event.metadata?.after ?? "") !== "" &&
        Math.round(Number(event.metadata?.after) * 100) === at.inst.amountMinor;
      let run = 0;
      while (k + run < elapsed.length && elapsed[k + run].inst.amountMinor === at.inst.amountMinor) run += 1;
      const reverted = k + run < elapsed.length; // a later elapsed occurrence left the new amount again
      // How long did the "from" amount hold? A "from" that lasted less than the minimum was itself a
      // one-off deviation, so returning from it is not a change — look further back instead.
      let fromRun = 0;
      while (k - 1 - fromRun >= 0 && elapsed[k - 1 - fromRun].inst.amountMinor === before.inst.amountMinor) fromRun += 1;
      const fromWasDeviation = fromRun < p.minOccurrencesAtNewAmount && k - 1 - fromRun >= 0 && !explicit.has(elapsed[k - fromRun].inst.id);
      if (!confirmedExplicitly) {
        if (variable) break;
        if (fromWasDeviation) continue;
        if (run < p.minOccurrencesAtNewAmount || reverted) break;
      }
      const cadence = parseCadence(at.c.recurrence);
      if (!cadence) break;
      const monthlyFrom = normalizedEquivalentMinor(before.inst.amountMinor, cadence, "MONTH");
      const monthlyTo = normalizedEquivalentMinor(at.inst.amountMinor, cadence, "MONTH");
      const used = elapsed.slice(k, k + Math.max(1, run));
      const refs = [ref("installment", s.businessId, before.inst.id), ...used.map((o) => ref("installment", s.businessId, o.inst.id))];
      if (confirmedExplicitly && event) refs.push(ref("payables-audit-event", s.businessId, event.id));
      out.push(
        result(COST02, s.businessId, at.c.id, "ACTIVE", toMajor(monthlyTo - monthlyFrom), {
          params: p,
          seriesKey: g.key,
          recurrence: at.c.recurrence,
          effectiveDate: at.inst.dueDate,
          fromMinor: before.inst.amountMinor,
          toMinor: at.inst.amountMinor,
          monthlyFromMinor: monthlyFrom,
          monthlyToMinor: monthlyTo,
          confirmation: confirmedExplicitly ? "EXPLICIT_AMOUNT_CHANGE" : "REPEATED_OCCURRENCES",
          occurrencesAtNewAmount: run,
          beforeInstallmentId: before.inst.id,
          afterInstallmentId: at.inst.id,
        }, refs, from, asOf),
      );
      break;
    }
  }
  return out;
}

/* ──────────────────── COST-04 · new material commitment ───────────────────── */

export function deriveNewMaterialCommitment(observations: readonly CostLedgerSnapshot[], now: Date): MeasureResult[] {
  const s = observations[0];
  if (!s) return [];
  const p = P04;
  const cp = P08;
  const asOf = asOfOf(s, now);
  const from = asOf - p.lookbackDays;
  const createdOf = new Map(s.commitmentMeta.map((m) => [m.commitmentId, toDayNumber(civilDateInZone(m.createdAt, s.inputs.timeZone))]));
  const out: MeasureResult[] = [];
  for (const g of ledgerSeries(s)) {
    if (g.members.length !== 1) continue; // part of an older series: a continuation, not a new commitment
    const c = g.members[0];
    if (c.scheduleKind !== "RECURRING" || c.status !== "ACTIVE" || natureOf(c) !== "OPERATING") continue;
    const cadence = parseCadence(c.recurrence);
    const first = g.occ[0];
    if (!cadence || !first) continue;
    if (first.day < from || first.day > asOf) continue; // not started yet, or not recent
    const created = createdOf.get(c.id);
    if (created === undefined) continue;
    if (created - first.day > p.backfillGraceDays) continue; // newly RECORDED, not new
    const monthly = normalizedEquivalentMinor(first.inst.amountMinor, cadence, "MONTH");
    const priorDay = fromDayNumber(first.day - 1);
    const prior = baselineViews({ ...s.inputs, asOf: priorDay }, priorDay).monthlyMinor;
    const priorWindow = windowCoverage(s, first.day - cp.windowDays, first.day - 1);
    const refs = [ref("commitment", s.businessId, c.id), ref("installment", s.businessId, first.inst.id)];
    const base = {
      params: p,
      recurrence: c.recurrence,
      firstDueDate: first.inst.dueDate,
      recordedDate: fromDayNumber(created),
      firstAmountMinor: first.inst.amountMinor,
      monthlyMinor: monthly,
      priorBaselineMonthlyMinor: prior,
      priorWindow: { from: priorWindow.from, to: priorWindow.to, covered: priorWindow.covered },
    };
    if (prior <= 0 || priorWindow.covered !== true) {
      // Known to be new, but there is no reliable previous baseline to call it material against.
      out.push(result(COST04, s.businessId, c.id, "INSUFFICIENT_EVIDENCE", null, {
        ...base,
        reason: prior <= 0 ? "NO_PRIOR_BASELINE" : "PRIOR_BASELINE_NOT_RELIABLE",
        minSupport: COST04.minSupport,
        have: 0,
      }, [], from, asOf));
      continue;
    }
    // Exact integer comparison: monthly / prior ≥ threshold.
    const thresholdBp = Math.round(p.materialShareOfPriorBaseline * 10_000);
    if (monthly * 10_000 < prior * thresholdBp) continue;
    out.push(result(COST04, s.businessId, c.id, "ACTIVE", toMajor(monthly), {
      ...base,
      shareBp: Math.round((monthly * 10_000) / prior),
      thresholdBp,
    }, refs, from, asOf));
  }
  return out;
}

/* ───────────────────────── COST-05 · explicitly ended ─────────────────────── */

export function deriveEndedCommitment(observations: readonly CostLedgerSnapshot[], now: Date): MeasureResult[] {
  const s = observations[0];
  if (!s) return [];
  const p = P05;
  const asOf = asOfOf(s, now);
  const from = asOf - p.lookbackDays;
  const lastEnd = new Map<number, CostAuditEvent>();
  for (const e of s.audit) {
    if (e.eventType !== "COMMITMENT_ENDED" || e.commitmentId == null) continue;
    const prev = lastEnd.get(e.commitmentId);
    if (!prev || e.id > prev.id) lastEnd.set(e.commitmentId, e);
  }
  const out: MeasureResult[] = [];
  for (const g of ledgerSeries(s)) {
    for (const c of g.members) {
      const event = lastEnd.get(c.id);
      if (!event) continue; // records that stopped appearing are NOT an end
      if (c.scheduleKind !== "RECURRING" || c.status === "RELEASED" || natureOf(c) !== "OPERATING") continue;
      const endsOnRaw = event.metadata?.endsOn;
      if (typeof endsOnRaw !== "string") continue;
      const endsOn = civilDateInZone(new Date(endsOnRaw), "UTC");
      if (c.endDate !== endsOn) continue; // the end was moved or withdrawn since
      const endDay = toDayNumber(endsOn);
      if (endDay < from || endDay > asOf) continue;
      const lived = g.occ.filter((o) => o.c.id === c.id && o.day <= endDay);
      const last = lived[lived.length - 1];
      const cadence = parseCadence(c.recurrence);
      if (!last || !cadence) continue; // it never took effect: nothing left the cost structure
      const monthly = normalizedEquivalentMinor(last.inst.amountMinor, cadence, "MONTH");
      out.push(result(COST05, s.businessId, c.id, "ACTIVE", toMajor(monthly), {
        params: p,
        recurrence: c.recurrence,
        endsOn,
        lastOccurrenceDate: last.inst.dueDate,
        lastAmountMinor: last.inst.amountMinor,
        monthlyRemovedMinor: monthly,
        cancelledInstallments: Array.isArray(event.metadata?.cancelledInstallments) ? (event.metadata?.cancelledInstallments as unknown[]).length : 0,
      }, [ref("payables-audit-event", s.businessId, event.id), ref("installment", s.businessId, last.inst.id)], from, asOf));
    }
  }
  return out;
}

/* ───────────────────────── Wave 2 · PATTERN descriptors ───────────────────── */

const PATTERN_FRESHNESS: RuleDescriptor["freshness"] = ["NEW_EVIDENCE", "WINDOW_ROLLED", "EVIDENCE_REVERSED", "RULE_VERSION_CHANGED"];

export const COST01: RuleDescriptor = {
  ...SHARED,
  ruleId: "COST-01",
  measureKey: "payables.baseline_shift",
  policyKey: "payables-baseline-shift",
  entityType: null,
  minSupport: 1,
  windowDays: P01.lookbackDays,
  freshness: PATTERN_FRESHNESS,
  question: "Did this business's recorded monthly cost baseline change, materially and lastingly, against its own baseline 90 days ago?",
};
export const COST06: RuleDescriptor = {
  ...SHARED,
  ruleId: "COST-06",
  measureKey: "payables.upcoming_concentration",
  policyKey: "payables-upcoming-concentration",
  entityType: null,
  minSupport: 1,
  windowDays: P08.windowDays * P08.completedWindows,
  freshness: PATTERN_FRESHNESS,
  question: "Is more falling due in the next 30 days than in any covered 30-day window of this business's own history?",
};
export const COST07: RuleDescriptor = {
  ...SHARED,
  ruleId: "COST-07",
  measureKey: "payables.cash_out_above_range",
  policyKey: "payables-cash-out-above-range",
  entityType: null,
  minSupport: 1,
  windowDays: P08.windowDays * P08.completedWindows,
  freshness: PATTERN_FRESHNESS,
  question: "Was more cash recorded as paid in the last 30 days than in any covered 30-day window of this business's own history?",
};

/** The eligibility every PATTERN shares: COST-08's trustworthy history, and its covered windows as the only history. */
function patternEligibility(s: CostLedgerSnapshot, now: Date, minDays: number, minCovered: number) {
  const a = assessCostCompleteness(s, now);
  const days = a.eligibility.trustworthyHistoryDays;
  const covered = a.eligibility.windows.slice(0, days / P08.windowDays).filter((w) => w.covered === true);
  const eligible = a.hasData && days >= minDays && covered.length >= minCovered;
  const reason = !a.hasData
    ? "NO_COST_DATA"
    : days < minDays
      ? `TRUSTWORTHY_HISTORY_${days}_OF_${minDays}_DAYS`
      : `COVERED_WINDOWS_${covered.length}_OF_${minCovered}`;
  return { a, days, covered, eligible, reason };
}

function ineligible(d: RuleDescriptor, s: CostLedgerSnapshot, asOf: number, from: number, e: ReturnType<typeof patternEligibility>, params: object): MeasureResult {
  return result(d, s.businessId, null, "INSUFFICIENT_EVIDENCE", null, {
    level: "PATTERN", params, reason: e.reason, trustworthyHistoryDays: e.days, coveredWindows: e.covered.length,
    minSupport: d.minSupport, have: 0,
  }, [], from, asOf);
}

/* ────────────────────── COST-01 · sustained baseline shift ──────────────────── */

export function deriveBaselineShift(observations: readonly CostLedgerSnapshot[], now: Date): MeasureResult[] {
  const s = observations[0];
  if (!s) return [];
  const asOf = asOfOf(s, now);
  const from = asOf - P01.lookbackDays;
  const e = patternEligibility(s, now, P01.minTrustworthyHistoryDays, 1);
  if (!e.eligible) return [ineligible(COST01, s, asOf, from, e, P01)];
  const input = { ...s.inputs, asOf: fromDayNumber(asOf) };
  const then = baselineViews(input, fromDayNumber(from));
  const mid = baselineViews(input, fromDayNumber(asOf - P01.sustainedDays));
  const current = baselineViews(input, fromDayNumber(asOf));
  if (then.monthlyMinor <= 0) {
    return [result(COST01, s.businessId, null, "INSUFFICIENT_EVIDENCE", null, { level: "PATTERN", params: P01, reason: "NO_PRIOR_BASELINE", minSupport: 1, have: 0 }, [], from, asOf)];
  }
  const delta = current.monthlyMinor - then.monthlyMinor;
  // |Δ| ≥ max(3% of the previous monthly baseline, one previous daily baseline) — integer arithmetic.
  const floor = Math.max(Math.ceil((then.monthlyMinor * Math.round(P01.minShareOfPriorMonthly * 10_000)) / 10_000), then.dailyMinor * P01.minPriorDailyBaselines);
  const material = Math.abs(delta) >= floor;
  // Sustained: today's level already held 30 days ago — a change inside the last 30 days is not yet a pattern.
  const sustained = mid.monthlyMinor === current.monthlyMinor;
  const before = new Map(then.lines.map((l) => [l.seriesKey, l]));
  const after = new Map(current.lines.map((l) => [l.seriesKey, l]));
  const drivers: Array<{ commitmentId: number; change: "ADDED" | "ENDED" | "CHANGED"; monthlyFromMinor: number; monthlyToMinor: number }> = [];
  for (const [k, l] of after) {
    const b = before.get(k);
    if (!b) drivers.push({ commitmentId: l.commitmentId, change: "ADDED", monthlyFromMinor: 0, monthlyToMinor: l.monthlyMinor });
    else if (b.monthlyMinor !== l.monthlyMinor) drivers.push({ commitmentId: l.commitmentId, change: "CHANGED", monthlyFromMinor: b.monthlyMinor, monthlyToMinor: l.monthlyMinor });
  }
  for (const [k, b] of before) if (!after.has(k)) drivers.push({ commitmentId: b.commitmentId, change: "ENDED", monthlyFromMinor: b.monthlyMinor, monthlyToMinor: 0 });
  drivers.sort((x, y) => Math.abs(y.monthlyToMinor - y.monthlyFromMinor) - Math.abs(x.monthlyToMinor - x.monthlyFromMinor) || x.commitmentId - y.commitmentId);
  const refs = drivers.map((d) => ref("commitment", s.businessId, d.commitmentId));
  if (refs.length === 0) refs.push(...e.a.refs.slice(0, 1));
  return [result(COST01, s.businessId, null, "ACTIVE", toMajor(delta), {
    level: "PATTERN", params: P01,
    detected: material && sustained && delta !== 0,
    comparedFrom: fromDayNumber(from), comparedTo: fromDayNumber(asOf),
    monthlyFromMinor: then.monthlyMinor, monthlyToMinor: current.monthlyMinor,
    dailyFromMinor: then.dailyMinor, dailyToMinor: current.dailyMinor,
    floorMinor: floor, material, sustained, drivers,
    trustworthyHistoryDays: e.days,
  }, refs, from, asOf)];
}

/* ─────────────────── COST-06 · upcoming payment concentration ───────────────── */

export function deriveUpcomingConcentration(observations: readonly CostLedgerSnapshot[], now: Date): MeasureResult[] {
  const s = observations[0];
  if (!s) return [];
  const asOf = asOfOf(s, now);
  const from = asOf - P08.windowDays * P08.completedWindows;
  const e = patternEligibility(s, now, P06.minTrustworthyHistoryDays, P06.minCoveredWindows);
  if (!e.eligible) return [ineligible(COST06, s, asOf, from, e, P06)];
  const to = asOf + P06.horizonDays - 1;
  // What falls due, paid or not: stored occurrences at their scheduled amount plus the projection of
  // running series — the same quantity each covered historical window's dueMinor measured.
  const recorded = windowCoverage(s, asOf, to);
  const projected = upcomingObligations({ ...s.inputs, asOf: fromDayNumber(asOf) }, fromDayNumber(asOf), fromDayNumber(to)).projectedMinor;
  const total = recorded.dueMinor + projected;
  const history = e.covered.map((w) => w.dueMinor);
  const max = Math.max(...history);
  const mean = Math.round(history.reduce((x, v) => x + v, 0) / history.length);
  return [result(COST06, s.businessId, null, "ACTIVE", toMajor(total), {
    level: "PATTERN", params: P06,
    detected: total > max,
    window: { from: fromDayNumber(asOf), to: fromDayNumber(to) },
    currentMinor: total, recordedMinor: recorded.dueMinor, projectedMinor: projected,
    historyMaxMinor: max, historyMeanMinor: mean, coveredWindows: history.length,
    trustworthyHistoryDays: e.days,
  }, recorded.refs.length ? recorded.refs : e.a.refs.slice(0, 1), from, asOf)];
}

/* ─────────────────────── COST-07 · cash out above own range ─────────────────── */

export function deriveCashOutAboveRange(observations: readonly CostLedgerSnapshot[], now: Date): MeasureResult[] {
  const s = observations[0];
  if (!s) return [];
  const asOf = asOfOf(s, now);
  const from = asOf - P08.windowDays * P08.completedWindows;
  const e = patternEligibility(s, now, P07.minTrustworthyHistoryDays, P07.minCoveredWindows);
  if (!e.eligible) return [ineligible(COST07, s, asOf, from, e, P07)];
  const cur = windowCoverage(s, asOf - P07.windowDays + 1, asOf);
  const history = e.covered.map((w) => w.cashOutMinor);
  const max = Math.max(...history);
  const mean = Math.round(history.reduce((x, v) => x + v, 0) / history.length);
  const payments = s.inputs.payments
    .filter((p) => p.status === "RECORDED" && p.currency === s.inputs.baseCurrency)
    .filter((p) => {
      const d = toDayNumber(civilDateInZone(p.paidAt, s.inputs.timeZone));
      return d >= asOf - P07.windowDays + 1 && d <= asOf;
    })
    .sort((x, y) => y.amountMinor - x.amountMinor || x.id - y.id);
  return [result(COST07, s.businessId, null, "ACTIVE", toMajor(cur.cashOutMinor), {
    level: "PATTERN", params: P07,
    // ABOVE only. Below the business's own range is never concluded: an unrecorded payment and lower
    // spending look the same in the record.
    detected: cur.cashOutMinor > max,
    window: { from: cur.from, to: cur.to },
    currentMinor: cur.cashOutMinor, historyMaxMinor: max, historyMeanMinor: mean, coveredWindows: history.length,
    largestPayments: payments.slice(0, 3).map((p) => ({ paymentId: p.id, amountMinor: p.amountMinor })),
    trustworthyHistoryDays: e.days,
  }, payments.length ? payments.map((p) => ref("payment", s.businessId, p.id)) : e.a.refs.slice(0, 1), from, asOf)];
}

/* ──────────────────────────────── the rules ───────────────────────────────── */

export function costRules(source: EvidenceSource<CostLedgerSnapshot>): KnowledgeRule<CostLedgerSnapshot>[] {
  return [
    { descriptor: COST08, source, derive: deriveCostCompleteness },
    { descriptor: COST02, source, derive: deriveRecurringAmountChange },
    { descriptor: COST04, source, derive: deriveNewMaterialCommitment },
    { descriptor: COST05, source, derive: deriveEndedCommitment },
    { descriptor: COST01, source, derive: deriveBaselineShift },
    { descriptor: COST06, source, derive: deriveUpcomingConcentration },
    { descriptor: COST07, source, derive: deriveCashOutAboveRange },
  ];
}
