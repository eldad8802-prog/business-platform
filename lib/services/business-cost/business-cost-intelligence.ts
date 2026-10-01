/**
 * Business Cost Intelligence — pure, deterministic, one business at a time.
 *
 * Everything here is derived from the SAME inputs and the SAME daily engine as
 * `/api/business-cost` (`deriveBusinessCostForDate`); nothing computes money a
 * second way. It answers:
 *
 *   periods     what actually left (Cash Out) and what the period economically
 *               cost (Allocated Business Cost) — today, yesterday, this week,
 *               this month, the last 30 days, or a custom range
 *   baseline    the normalised recurring operating cost: daily (= the engine's
 *               baseline), weekly, monthly, annual — operating only, uncertain
 *               amounts never added
 *   upcoming    the FINANCIAL schedule: what is still to pay in the next 7 / 30
 *               days and this month, plus what is overdue. Stored occurrences
 *               (RECORDED) and the projection of running recurring commitments
 *               (PROJECTED). A workflow follow-up date is not an input at all.
 *   structure   where the recurring cost comes from, by AUTHORITATIVE
 *               classification only: the payee's kind, else the owner's own
 *               category, else UNCLASSIFIED. Nothing is inferred.
 *   changes     recorded facts: a recurring amount that changed, a cadence that
 *               changed — each with the occurrences that prove it
 *   signals     patterns relative to THIS business's own history, each DETECTED,
 *               NONE, or INSUFFICIENT_HISTORY (with what is missing). No other
 *               tenant's data is an input, and no universal threshold decides:
 *               "unusual" means outside the range this business itself showed.
 *
 * Not here, on purpose: revenue, profit, margin, break-even. Business cost is
 * not profitability, and no authoritative margin/COGS truth exists yet.
 */
import {
  addCadence,
  deriveBusinessCostForDate,
  fromDayNumber,
  natureOf,
  normalizedEquivalentMinor,
  parseCadence,
  seriesKeyOf,
  toDayNumber,
  type BusinessCostDay,
  type BusinessCostInput,
  type Cadence,
  type CivilDate,
  type CompletenessState,
  type CostCommitment,
  type CostLine,
  type CostNature,
} from "./business-cost-core";

export type IntelligenceInput = Omit<BusinessCostInput, "date"> & { asOf: CivilDate };

const MS_PER_DAY = 86_400_000;

/* ─────────────────────────────────── periods ─────────────────────────────── */

export type PeriodCost = {
  from: CivilDate;
  to: CivilDate;
  days: number;
  /** Money that actually left, booked on its Israel paid date (base currency). */
  cashOutMinor: number;
  /** Operating cost belonging to the period, independent of when it was paid. */
  allocatedMinor: number;
  allocatedRecordedMinor: number;
  allocatedProjectedMinor: number;
  /** Debt service (LENDER) — kept apart from operating cost, as the engine does. */
  debtServiceAllocatedMinor: number;
  /** The worst completeness of any day in the period, with every reason seen. */
  completeness: { state: CompletenessState; reasons: string[] };
};

/** Days are derived once each; a range is the exact sum of its days. */
export function costForRange(input: IntelligenceInput, from: CivilDate, to: CivilDate, cache?: DayCache): PeriodCost {
  const a = toDayNumber(from);
  const b = toDayNumber(to);
  if (b < a) throw new RangeError("range end before start");
  if (b - a > 731) throw new RangeError("range longer than two years");
  let cash = 0, alloc = 0, rec = 0, proj = 0, debt = 0;
  const reasons = new Set<string>();
  const rank: Record<CompletenessState, number> = { EMPTY: 0, COMPLETE: 1, PARTIAL: 2 };
  let state: CompletenessState = "EMPTY";
  for (let d = a; d <= b; d++) {
    const day = dayOf(input, fromDayNumber(d), cache);
    cash += day.cashOut.totalMinor;
    alloc += day.allocatedCost.totalMinor;
    rec += day.allocatedCost.recordedMinor;
    proj += day.allocatedCost.projectedMinor;
    debt += day.debtService.allocatedMinor;
    day.completeness.reasons.forEach((r) => reasons.add(r));
    if (rank[day.completeness.state] > rank[state]) state = day.completeness.state;
  }
  return {
    from,
    to,
    days: b - a + 1,
    cashOutMinor: cash,
    allocatedMinor: alloc,
    allocatedRecordedMinor: rec,
    allocatedProjectedMinor: proj,
    debtServiceAllocatedMinor: debt,
    completeness: { state, reasons: [...reasons].sort() },
  };
}

export type DayCache = Map<CivilDate, BusinessCostDay>;
function dayOf(input: IntelligenceInput, date: CivilDate, cache?: DayCache): BusinessCostDay {
  const hit = cache?.get(date);
  if (hit) return hit;
  const day = deriveBusinessCostForDate({ ...input, date });
  cache?.set(date, day);
  return day;
}

/** The Israeli week starts on Sunday. */
export function weekStart(date: CivilDate): CivilDate {
  const d = toDayNumber(date);
  const dow = new Date(d * MS_PER_DAY).getUTCDay(); // 0 = Sunday
  return fromDayNumber(d - dow);
}
export function monthStart(date: CivilDate): CivilDate {
  return `${date.slice(0, 7)}-01`;
}
function monthEnd(date: CivilDate): CivilDate {
  const [y, m] = date.split("-").map(Number);
  return fromDayNumber(Date.UTC(y, m, 0) / MS_PER_DAY);
}
const shift = (date: CivilDate, days: number) => fromDayNumber(toDayNumber(date) + days);

export function standardPeriods(input: IntelligenceInput, cache: DayCache) {
  const t = input.asOf;
  return {
    today: costForRange(input, t, t, cache),
    yesterday: costForRange(input, shift(t, -1), shift(t, -1), cache),
    thisWeek: costForRange(input, weekStart(t), t, cache),
    thisMonth: costForRange(input, monthStart(t), t, cache),
    last30Days: costForRange(input, shift(t, -29), t, cache),
  };
}

/* ────────────────────────────────── baseline ─────────────────────────────── */

export type BaselineViews = {
  asOf: CivilDate;
  dailyMinor: number;
  weeklyMinor: number;
  monthlyMinor: number;
  annualMinor: number;
  /** One per operating recurring line in effect on `asOf`. */
  lines: Array<{
    seriesKey: string;
    commitmentId: number;
    title: string;
    recurrence: string;
    periodAmountMinor: number;
    basis: CostLine["basis"];
    dailyMinor: number;
    monthlyMinor: number;
  }>;
  /** Recorded amounts the engine could not place in time — never in the totals. */
  uncertainMinor: number;
  debtServiceMonthlyMinor: number;
  completeness: BusinessCostDay["completeness"];
};

export function baselineViews(input: IntelligenceInput, date: CivilDate = input.asOf, cache?: DayCache): BaselineViews {
  const day = dayOf(input, date, cache);
  const eq = (line: CostLine, unit: "DAY" | "WEEK" | "MONTH" | "YEAR") =>
    line.cadence ? normalizedEquivalentMinor(line.periodAmountMinor, line.cadence, unit) : 0;
  const lines = day.allocatedCost.lines.filter((l) => l.cadence);
  const sum = (unit: "DAY" | "WEEK" | "MONTH" | "YEAR") => lines.reduce((s, l) => s + eq(l, unit), 0);
  return {
    asOf: date,
    // Per line, then summed — identical to the engine's own baseline total.
    dailyMinor: day.baselineDailyCost.totalMinor,
    weeklyMinor: sum("WEEK"),
    monthlyMinor: sum("MONTH"),
    annualMinor: sum("YEAR"),
    lines: lines.map((l) => ({
      seriesKey: l.seriesKey,
      commitmentId: l.commitmentId,
      title: l.title,
      recurrence: l.recurrence,
      periodAmountMinor: l.periodAmountMinor,
      basis: l.basis,
      dailyMinor: l.baselineDailyMinor,
      monthlyMinor: eq(l, "MONTH"),
    })),
    uncertainMinor: day.uncertain.totalMinor,
    debtServiceMonthlyMinor: day.debtService.lines.reduce((s, l) => s + eq(l, "MONTH"), 0),
    completeness: day.completeness,
  };
}

/* ────────────────────────────────── upcoming ─────────────────────────────── */

export type UpcomingItem = {
  seriesKey: string;
  commitmentId: number;
  installmentId: number | null;
  title: string;
  payeeName: string;
  dueDate: CivilDate;
  /** Still to pay: scheduled amount minus active allocations (recorded); the
   *  carried-forward amount for a projected occurrence. */
  amountMinor: number;
  basis: "RECORDED" | "PROJECTED";
  nature: CostNature;
};

export type UpcomingWindow = {
  from: CivilDate;
  to: CivilDate;
  totalMinor: number;
  recordedMinor: number;
  projectedMinor: number;
  items: UpcomingItem[];
};

type Group = { key: string; members: CostCommitment[] };
function groups(commitments: CostCommitment[]): Group[] {
  const map = new Map<string, CostCommitment[]>();
  for (const c of commitments) {
    const k = seriesKeyOf(c);
    map.set(k, [...(map.get(k) ?? []), c]);
  }
  return [...map.entries()].map(([key, members]) => ({ key, members }));
}

/**
 * Every still-open occurrence due in [from, to] (inclusive), plus overdue ones
 * when `includeOverdueBefore` is set. Non-base-currency series are skipped (no
 * conversion is ever invented). Projection follows the engine's own rule: only
 * from the latest occurrence of an ACTIVE series whose cadence is known, never
 * past its end date, anchored on the series' original day of month.
 */
export function upcomingObligations(input: IntelligenceInput, from: CivilDate, to: CivilDate): UpcomingWindow {
  const a = toDayNumber(from);
  const b = toDayNumber(to);
  const items: UpcomingItem[] = [];
  for (const g of groups(input.commitments)) {
    if (g.members.some((m) => m.currency !== input.baseCurrency)) continue;
    const occ = g.members
      .flatMap((c) => c.installments.map((i) => ({ i, c, day: toDayNumber(i.dueDate) })))
      .sort((x, y) => x.day - y.day || x.i.sequence - y.i.sequence);
    if (occ.length === 0) continue;
    for (const { i, c, day } of occ) {
      if (day < a || day > b) continue;
      if (i.status !== "SCHEDULED" || c.status === "RELEASED" || c.status === "CLOSED") continue;
      const remaining = i.amountMinor - (i.paidMinor ?? 0);
      if (remaining <= 0) continue;
      items.push(item(g.key, c, i.id, i.dueDate, remaining, "RECORDED"));
    }
    // Projection beyond the latest stored occurrence.
    const live = occ.filter((o) => o.i.status !== "CANCELLED");
    const last = live[live.length - 1];
    if (!last || last.c.scheduleKind !== "RECURRING" || last.c.status !== "ACTIVE") continue;
    const cadence = parseCadence(last.c.recurrence);
    if (!cadence) continue;
    const end = last.c.endDate ? toDayNumber(last.c.endDate) : Number.POSITIVE_INFINITY;
    const anchor = anchorDay(live.map((o) => o.day), last.day, cadence);
    for (let n = 1; n < 2000; n++) {
      const d = addCadence(last.day, cadence, n, anchor);
      if (d > b || d > end) break;
      if (d >= a) items.push(item(g.key, last.c, null, fromDayNumber(d), last.i.amountMinor, "PROJECTED"));
    }
  }
  items.sort((x, y) => (x.dueDate < y.dueDate ? -1 : x.dueDate > y.dueDate ? 1 : x.commitmentId - y.commitmentId));
  const total = (basis?: "RECORDED" | "PROJECTED") =>
    items.filter((x) => !basis || x.basis === basis).reduce((s, x) => s + x.amountMinor, 0);
  return { from, to, totalMinor: total(), recordedMinor: total("RECORDED"), projectedMinor: total("PROJECTED"), items };
}

function item(key: string, c: CostCommitment, installmentId: number | null, dueDate: CivilDate, amountMinor: number, basis: "RECORDED" | "PROJECTED"): UpcomingItem {
  return { seriesKey: key, commitmentId: c.id, installmentId, title: c.title, payeeName: c.payeeName, dueDate, amountMinor, basis, nature: natureOf(c) };
}

/** Same restoration as the engine's projectionAnchorDay: a clamped month end keeps the series' own day. */
function anchorDay(days: number[], lastDay: number, cadence: Cadence): number | undefined {
  if (cadence.unit !== "MONTH") return undefined;
  const last = new Date(lastDay * MS_PER_DAY);
  const lastDom = last.getUTCDate();
  const monthEndDom = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 0)).getUTCDate();
  if (lastDom !== monthEndDom) return lastDom;
  return Math.max(lastDom, new Date(days[0] * MS_PER_DAY).getUTCDate());
}

export function upcomingViews(input: IntelligenceInput) {
  const t = input.asOf;
  return {
    overdue: overdueObligations(input),
    next7Days: upcomingObligations(input, t, shift(t, 6)),
    next30Days: upcomingObligations(input, t, shift(t, 29)),
    currentMonth: upcomingObligations(input, t, monthEnd(t)),
  };
}

/** Stored occurrences due before asOf that are still not fully paid. */
export function overdueObligations(input: IntelligenceInput): UpcomingWindow {
  const w = upcomingObligations(input, "1970-01-01", shift(input.asOf, -1));
  const items = w.items.filter((x) => x.basis === "RECORDED");
  const total = items.reduce((s, x) => s + x.amountMinor, 0);
  return { from: w.from, to: w.to, totalMinor: total, recordedMinor: total, projectedMinor: 0, items };
}

/* ────────────────────────────────── structure ────────────────────────────── */

export type StructureGroup = {
  /** PAYEE_KIND (structured payee data), OWNER_CATEGORY (the owner's own words), UNCLASSIFIED. */
  source: "PAYEE_KIND" | "OWNER_CATEGORY" | "UNCLASSIFIED";
  key: string;
  monthlyMinor: number;
  /** Share of the operating monthly baseline, in basis points (sums to 10000 ± rounding). */
  shareBp: number;
  commitmentIds: number[];
};

export function costStructure(input: IntelligenceInput, baseline: BaselineViews): StructureGroup[] {
  const byId = new Map(input.commitments.map((c) => [`${c.source}:${c.id}`, c]));
  const out = new Map<string, StructureGroup>();
  for (const line of baseline.lines) {
    const c =
      byId.get(`COMMITMENT:${line.commitmentId}`) ?? byId.get(`LEGACY_OBLIGATION:${line.commitmentId}`) ?? null;
    const kind = c?.payeeKind && c.payeeKind !== "OTHER" ? c.payeeKind : null;
    const category = c?.category?.trim() || null;
    const g = kind
      ? { source: "PAYEE_KIND" as const, key: kind }
      : category
        ? { source: "OWNER_CATEGORY" as const, key: category }
        : { source: "UNCLASSIFIED" as const, key: "UNCLASSIFIED" };
    const id = `${g.source}:${g.key}`;
    const cur = out.get(id) ?? { ...g, monthlyMinor: 0, shareBp: 0, commitmentIds: [] };
    cur.monthlyMinor += line.monthlyMinor;
    if (!cur.commitmentIds.includes(line.commitmentId)) cur.commitmentIds.push(line.commitmentId);
    out.set(id, cur);
  }
  const total = baseline.monthlyMinor;
  const list = [...out.values()].sort((x, y) => y.monthlyMinor - x.monthlyMinor || x.key.localeCompare(y.key));
  for (const g of list) g.shareBp = total > 0 ? Math.round((g.monthlyMinor * 10000) / total) : 0;
  return list;
}

/* ─────────────────────────────────── changes ─────────────────────────────── */

export type AmountChange = {
  kind: "RECURRING_AMOUNT_CHANGED";
  seriesKey: string;
  commitmentId: number;
  title: string;
  recurrence: string;
  /** The due date of the first occurrence at the new amount. */
  effectiveDate: CivilDate;
  fromMinor: number;
  toMinor: number;
  monthlyFromMinor: number;
  monthlyToMinor: number;
  /** The two occurrences that prove the change. */
  evidence: { beforeInstallmentId: number; afterInstallmentId: number };
};
export type CadenceChange = {
  kind: "RECURRING_CADENCE_CHANGED";
  seriesKey: string;
  commitmentId: number;
  title: string;
  fromRecurrence: string;
  toRecurrence: string;
  effectiveDate: CivilDate;
  evidence: { beforeInstallmentId: number; afterInstallmentId: number };
};

/** Recorded facts only: consecutive live occurrences of a recurring series that differ. */
export function recordedChanges(input: IntelligenceInput): Array<AmountChange | CadenceChange> {
  const out: Array<AmountChange | CadenceChange> = [];
  for (const g of groups(input.commitments)) {
    if (g.members.some((m) => m.scheduleKind !== "RECURRING" || m.currency !== input.baseCurrency)) continue;
    const occ = g.members
      .flatMap((c) => c.installments.filter((i) => i.status !== "CANCELLED").map((i) => ({ i, c, day: toDayNumber(i.dueDate) })))
      .sort((x, y) => x.day - y.day || x.i.sequence - y.i.sequence);
    for (let k = 1; k < occ.length; k++) {
      const prev = occ[k - 1];
      const next = occ[k];
      if (next.day > toDayNumber(input.asOf)) break; // only what has taken effect
      const cPrev = parseCadence(prev.c.recurrence);
      const cNext = parseCadence(next.c.recurrence);
      const evidence = { beforeInstallmentId: prev.i.id, afterInstallmentId: next.i.id };
      if (prev.c.recurrence !== next.c.recurrence) {
        out.push({ kind: "RECURRING_CADENCE_CHANGED", seriesKey: g.key, commitmentId: next.c.id, title: next.c.title, fromRecurrence: prev.c.recurrence, toRecurrence: next.c.recurrence, effectiveDate: next.i.dueDate, evidence });
      } else if (prev.i.amountMinor !== next.i.amountMinor && cPrev && cNext) {
        out.push({
          kind: "RECURRING_AMOUNT_CHANGED",
          seriesKey: g.key,
          commitmentId: next.c.id,
          title: next.c.title,
          recurrence: next.c.recurrence,
          effectiveDate: next.i.dueDate,
          fromMinor: prev.i.amountMinor,
          toMinor: next.i.amountMinor,
          monthlyFromMinor: normalizedEquivalentMinor(prev.i.amountMinor, cPrev, "MONTH"),
          monthlyToMinor: normalizedEquivalentMinor(next.i.amountMinor, cNext, "MONTH"),
          evidence,
        });
      }
    }
  }
  return out.sort((x, y) => (x.effectiveDate < y.effectiveDate ? -1 : x.effectiveDate > y.effectiveDate ? 1 : 0));
}

/* ─────────────────────────────────── signals ─────────────────────────────── */

export type SignalState = "DETECTED" | "NONE" | "INSUFFICIENT_HISTORY";
export type Insufficient = { code: "NO_HISTORY" | "TOO_SHORT_HISTORY"; haveDays: number; needDays: number };

/** The comparison window of every signal: one month back, then the business's own past. */
export const SIGNAL_POLICY = {
  /** Baseline comparison: now vs this many days ago. */
  baselineLookbackDays: 90,
  /** Rolling windows for "unusual vs my own history". */
  windowDays: 30,
  historyWindows: 12,
  /** Fewer full windows than this and nothing is concluded. */
  minHistoryWindows: 6,
} as const;

export type BaselineChangeSignal = {
  kind: "BASELINE_RECURRING_COST_CHANGED";
  state: SignalState;
  from: CivilDate;
  to: CivilDate;
  monthlyFromMinor: number;
  monthlyToMinor: number;
  dailyFromMinor: number;
  dailyToMinor: number;
  /** What moved it: series added, ended, or changed amount/cadence between the two dates. */
  drivers: Array<{ seriesKey: string; commitmentId: number; title: string; change: "ADDED" | "ENDED" | "CHANGED"; monthlyFromMinor: number; monthlyToMinor: number }>;
  insufficient?: Insufficient;
};

export function baselineChangeSignal(input: IntelligenceInput, cache?: DayCache): BaselineChangeSignal {
  const to = input.asOf;
  const from = shift(to, -SIGNAL_POLICY.baselineLookbackDays);
  const now = baselineViews(input, to, cache);
  const then = baselineViews(input, from, cache);
  const base = { kind: "BASELINE_RECURRING_COST_CHANGED" as const, from, to, monthlyFromMinor: then.monthlyMinor, monthlyToMinor: now.monthlyMinor, dailyFromMinor: then.dailyMinor, dailyToMinor: now.dailyMinor };
  if (then.lines.length === 0) {
    const first = firstOccurrenceDay(input);
    const have = first === null ? 0 : Math.max(0, toDayNumber(to) - first);
    return { ...base, state: "INSUFFICIENT_HISTORY", drivers: [], insufficient: { code: first === null ? "NO_HISTORY" : "TOO_SHORT_HISTORY", haveDays: have, needDays: SIGNAL_POLICY.baselineLookbackDays } };
  }
  const before = new Map(then.lines.map((l) => [l.seriesKey, l]));
  const after = new Map(now.lines.map((l) => [l.seriesKey, l]));
  const drivers: BaselineChangeSignal["drivers"] = [];
  for (const [k, l] of after) {
    const b = before.get(k);
    if (!b) drivers.push({ seriesKey: k, commitmentId: l.commitmentId, title: l.title, change: "ADDED", monthlyFromMinor: 0, monthlyToMinor: l.monthlyMinor });
    else if (b.monthlyMinor !== l.monthlyMinor) drivers.push({ seriesKey: k, commitmentId: l.commitmentId, title: l.title, change: "CHANGED", monthlyFromMinor: b.monthlyMinor, monthlyToMinor: l.monthlyMinor });
  }
  for (const [k, b] of before) {
    if (!after.has(k)) drivers.push({ seriesKey: k, commitmentId: b.commitmentId, title: b.title, change: "ENDED", monthlyFromMinor: b.monthlyMinor, monthlyToMinor: 0 });
  }
  drivers.sort((x, y) => Math.abs(y.monthlyToMinor - y.monthlyFromMinor) - Math.abs(x.monthlyToMinor - x.monthlyFromMinor));
  return { ...base, state: now.monthlyMinor !== then.monthlyMinor ? "DETECTED" : "NONE", drivers };
}

export type RangeSignal = {
  kind: "UPCOMING_PAYMENT_CONCENTRATION" | "CASH_OUT_OUTSIDE_OWN_RANGE";
  state: SignalState;
  window: { from: CivilDate; to: CivilDate };
  currentMinor: number;
  /** The business's own comparable windows, oldest first. */
  history: Array<{ from: CivilDate; to: CivilDate; minor: number }>;
  historyMinMinor: number | null;
  historyMaxMinor: number | null;
  historyMeanMinor: number | null;
  /** Only ABOVE: see cashOutSignal for why "below my range" is never concluded. */
  direction: "ABOVE" | null;
  insufficient?: Insufficient;
};

function rangeSignal(
  kind: RangeSignal["kind"],
  window: { from: CivilDate; to: CivilDate },
  current: number,
  history: RangeSignal["history"],
  firstDataDay: number | null,
): RangeSignal {
  const need = SIGNAL_POLICY.minHistoryWindows * SIGNAL_POLICY.windowDays;
  const oldestWindowStart = toDayNumber(window.from) - SIGNAL_POLICY.windowDays * SIGNAL_POLICY.historyWindows;
  // A window counts as history only if the business already had data when it began.
  const usable = firstDataDay === null ? [] : history.filter((h) => toDayNumber(h.from) >= firstDataDay);
  const empty = { historyMinMinor: null, historyMaxMinor: null, historyMeanMinor: null, direction: null };
  if (usable.length < SIGNAL_POLICY.minHistoryWindows) {
    const have = firstDataDay === null ? 0 : Math.max(0, toDayNumber(window.from) - Math.max(firstDataDay, oldestWindowStart));
    return { kind, state: "INSUFFICIENT_HISTORY", window, currentMinor: current, history: usable, ...empty, insufficient: { code: firstDataDay === null ? "NO_HISTORY" : "TOO_SHORT_HISTORY", haveDays: have, needDays: need } };
  }
  const values = usable.map((h) => h.minor);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = Math.round(values.reduce((s, v) => s + v, 0) / values.length);
  const direction = current > max ? "ABOVE" : null;
  return { kind, state: direction ? "DETECTED" : "NONE", window, currentMinor: current, history: usable, historyMinMinor: min, historyMaxMinor: max, historyMeanMinor: mean, direction };
}

function firstOccurrenceDay(input: IntelligenceInput): number | null {
  let first: number | null = null;
  for (const c of input.commitments) for (const i of c.installments) {
    const d = toDayNumber(i.dueDate);
    if (first === null || d < first) first = d;
  }
  return first;
}

/** Scheduled operating amounts (recorded occurrences, not cancelled) due in a window — independent of payment. */
function dueInWindow(input: IntelligenceInput, a: number, b: number): number {
  let sum = 0;
  for (const c of input.commitments) {
    if (c.currency !== input.baseCurrency || c.status === "RELEASED") continue;
    for (const i of c.installments) {
      const d = toDayNumber(i.dueDate);
      if (d >= a && d <= b && i.status !== "CANCELLED" && i.currency === input.baseCurrency) sum += i.amountMinor;
    }
  }
  return sum;
}

/**
 * The next 30 days are unusually heavy when what falls due (recorded and
 * projected) is above EVERY comparable 30-day window of this business's own
 * last year. Past windows count recorded occurrences only — they are history.
 */
export function upcomingConcentrationSignal(input: IntelligenceInput): RangeSignal {
  const W = SIGNAL_POLICY.windowDays;
  const t = toDayNumber(input.asOf);
  const next = upcomingObligations(input, input.asOf, fromDayNumber(t + W - 1));
  // Everything that falls due, paid or not: stored occurrences at their scheduled
  // amount, plus the projection of running series.
  const scheduledNext = dueInWindow(input, t, t + W - 1) + next.projectedMinor;
  const history = [];
  for (let k = SIGNAL_POLICY.historyWindows; k >= 1; k--) {
    const a = t - W * k;
    history.push({ from: fromDayNumber(a), to: fromDayNumber(a + W - 1), minor: dueInWindow(input, a, a + W - 1) });
  }
  return rangeSignal("UPCOMING_PAYMENT_CONCENTRATION", { from: next.from, to: next.to }, scheduledNext, history, firstOccurrenceDay(input));
}

/**
 * Cash out over the last 30 days compared with the business's own previous
 * 30-day windows. ABOVE every window it has itself shown is the signal; inside
 * its range it is not, however large.
 *
 * Never BELOW: less recorded cash than usual cannot be told apart from a
 * payment that is simply not recorded yet, or a monthly payment that fell just
 * outside the 30-day window (a business paying rent on the 1st would be told
 * "less money left than usual" every month before recording it). That is not
 * evidence, so it is not concluded.
 */
export function cashOutSignal(input: IntelligenceInput): RangeSignal {
  const W = SIGNAL_POLICY.windowDays;
  const t = toDayNumber(input.asOf);
  const cashIn = (a: number, b: number) => {
    let s = 0;
    for (const p of input.payments) {
      if (p.status !== "RECORDED" || p.currency !== input.baseCurrency) continue;
      const d = toDayNumber(civilDate(p.paidAt, input.timeZone));
      if (d >= a && d <= b) s += p.amountMinor;
    }
    return s;
  };
  const current = cashIn(t - W + 1, t);
  const history = [];
  for (let k = SIGNAL_POLICY.historyWindows; k >= 1; k--) {
    const b = t - W * k;
    history.push({ from: fromDayNumber(b - W + 1), to: fromDayNumber(b), minor: cashIn(b - W + 1, b) });
  }
  let first: number | null = null;
  for (const p of input.payments) {
    if (p.status !== "RECORDED") continue;
    const d = toDayNumber(civilDate(p.paidAt, input.timeZone));
    if (first === null || d < first) first = d;
  }
  return rangeSignal("CASH_OUT_OUTSIDE_OWN_RANGE", { from: fromDayNumber(t - W + 1), to: input.asOf }, current, history, first);
}

const ZONE_FORMAT = new Map<string, Intl.DateTimeFormat>();
function civilDate(instant: Date, timeZone: string): CivilDate {
  let f = ZONE_FORMAT.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    ZONE_FORMAT.set(timeZone, f);
  }
  return f.format(instant);
}

export type ChangeSignal = {
  kind: "RECURRING_COST_CHANGED";
  state: SignalState;
  window: { from: CivilDate; to: CivilDate };
  changes: Array<AmountChange | CadenceChange>;
};

/** Recorded amount/cadence changes that took effect in the baseline lookback window. */
export function recurringChangeSignal(input: IntelligenceInput): ChangeSignal {
  const to = input.asOf;
  const from = shift(to, -SIGNAL_POLICY.baselineLookbackDays);
  const changes = recordedChanges(input).filter((c) => c.effectiveDate >= from && c.effectiveDate <= to);
  return { kind: "RECURRING_COST_CHANGED", state: changes.length ? "DETECTED" : "NONE", window: { from, to }, changes };
}

/* ─────────────────────────────────── summary ─────────────────────────────── */

export type BusinessCostSummary = ReturnType<typeof summarizeBusinessCost>;

export function summarizeBusinessCost(input: IntelligenceInput) {
  const cache: DayCache = new Map();
  const baseline = baselineViews(input, input.asOf, cache);
  return {
    asOf: input.asOf,
    timeZone: input.timeZone,
    currency: input.baseCurrency,
    periods: standardPeriods(input, cache),
    baseline,
    upcoming: upcomingViews(input),
    structure: costStructure(input, baseline),
    changes: recordedChanges(input),
    signals: {
      baselineChange: baselineChangeSignal(input, cache),
      recurringChange: recurringChangeSignal(input),
      upcomingConcentration: upcomingConcentrationSignal(input),
      cashOut: cashOutSignal(input),
    },
  };
}
