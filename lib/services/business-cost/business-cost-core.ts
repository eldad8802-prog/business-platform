/**
 * Daily Business Cost — pure, DB-free.
 *
 * Answers, for one business and one calendar date, three DIFFERENT questions
 * that must never collapse into one number:
 *
 *   1. CASH OUT          — money that actually left the business on that date.
 *                          Read from `Payment` (the payables ledger's economic
 *                          fact) by its `paidAt`. Nothing else.
 *   2. ALLOCATED COST    — the share of known commitments economically
 *                          attributable to that date. A 9,000 ₪ monthly rent
 *                          covering September costs 300 ₪ on each of its 30
 *                          days, whenever (and whether) it was paid.
 *   3. BASELINE COST     — the recurring cost of existing, normalised to an
 *                          average day, so a 31-day month does not make the
 *                          business look cheaper than a 30-day one.
 *
 * ── Source of truth ──────────────────────────────────────────────────────────
 * This module owns NO financial facts. It derives from `Commitment` +
 * `Installment` (what is owed, and for which occurrence) and `Payment` (what
 * moved). There is no stored daily cost and there must never be one: a stored
 * figure drifts the moment an installment is cancelled or a payment voided,
 * exactly as AD-2 of the payables programme forbids for balances.
 *
 * ── Payment date never moves economic allocation ────────────────────────────
 * Allocation reads installments and their cadence. Cash out reads payments.
 * The two inputs are disjoint on purpose; no allocation rule looks at `paidAt`.
 *
 * ── Honesty about what is known ─────────────────────────────────────────────
 * Every figure carries its basis:
 *   RECORDED    the amount is a stored installment; its coverage period is
 *               DERIVED from the commitment's cadence (deterministic rule).
 *   PROJECTED   an ACTIVE recurring commitment has no installment stored for
 *               the date yet; the amount is carried forward from the last
 *               recorded occurrence — the same rule the ledger's own
 *               roll-forward uses. Reported apart from RECORDED.
 *   UNCERTAIN   no defensible allocation exists (a one-off with only a due
 *               date, a payment plan whose economic period is unknown, an
 *               unknown cadence). Surfaced with its amount, NEVER added.
 *
 * Money is integer minor units (agorot) throughout; floating point never
 * touches an amount. Dates are CIVIL dates in the business's time zone
 * ("YYYY-MM-DD"), converted once at the edge.
 */

/* ───────────────────────────────── civil dates ───────────────────────────── */

/** "YYYY-MM-DD" — a calendar date in the business's time zone. */
export type CivilDate = string;

export const DEFAULT_BUSINESS_TIME_ZONE = "Asia/Jerusalem";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class BusinessCostValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BusinessCostValidationError";
  }
}

/** Days since 1970-01-01 for a civil date. Pure arithmetic, no zone involved. */
export function toDayNumber(date: CivilDate): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new BusinessCostValidationError(`Not a YYYY-MM-DD date: "${date}"`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
    throw new BusinessCostValidationError(`Not a real calendar date: "${date}"`);
  }
  return Date.UTC(y, mo - 1, d) / MS_PER_DAY;
}

export function fromDayNumber(day: number): CivilDate {
  const d = new Date(day * MS_PER_DAY);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

export function daysInMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

/**
 * The calendar date an instant falls on in `timeZone`.
 *
 * This is the ONE place an instant becomes a date. It is correct for both
 * conventions found in the ledger: date-picker values stored as UTC midnight
 * (03:00 in Israel, same date) and legacy values stored as local midnight
 * (21:00Z the previous UTC day, same local date). A payment recorded at 00:30
 * Israel time is correctly that local day, not the previous UTC day.
 */
export function civilDateInZone(instant: Date, timeZone: string): CivilDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/* ─────────────────────────────────── cadence ─────────────────────────────── */

export type Cadence = { unit: "DAY" | "WEEK" | "MONTH"; every: number };

/**
 * Recurrence strings the engine understands.
 *
 * The payables write side can currently PRODUCE only NONE / WEEKLY / MONTHLY /
 * YEARLY (`RecurrenceCadenceValue`). The remaining values are accepted here so
 * the engine is ready the moment the write side learns them ("ארנונה כל
 * חודשיים" needs BIMONTHLY) — `Commitment.recurrence` is a String column, so
 * that is a code change, not a migration. An unknown value is never guessed.
 */
const CADENCES: Record<string, Cadence> = {
  DAILY: { unit: "DAY", every: 1 },
  WEEKLY: { unit: "WEEK", every: 1 },
  BIWEEKLY: { unit: "WEEK", every: 2 },
  MONTHLY: { unit: "MONTH", every: 1 },
  BIMONTHLY: { unit: "MONTH", every: 2 },
  QUARTERLY: { unit: "MONTH", every: 3 },
  SEMIANNUAL: { unit: "MONTH", every: 6 },
  YEARLY: { unit: "MONTH", every: 12 },
};

export function parseCadence(recurrence: string | null | undefined): Cadence | null {
  if (!recurrence) return null;
  return CADENCES[recurrence.trim().toUpperCase()] ?? null;
}

/**
 * Add `n` cadence steps to a civil date.
 *
 * Month arithmetic clamps to the month's last day and keeps `anchorDay`, so a
 * series anchored on the 31st goes Jan 31 → Feb 28 (29 in a leap year) → Mar 31,
 * never drifting to the 28th for the rest of its life.
 */
export function addCadence(day: number, cadence: Cadence, n: number, anchorDay?: number): number {
  if (cadence.unit === "DAY") return day + cadence.every * n;
  if (cadence.unit === "WEEK") return day + 7 * cadence.every * n;
  const d = new Date(day * MS_PER_DAY);
  const targetDay = anchorDay ?? d.getUTCDate();
  const monthIndex = d.getUTCMonth() + cadence.every * n;
  const year = d.getUTCFullYear() + Math.floor(monthIndex / 12);
  const month0 = ((monthIndex % 12) + 12) % 12;
  const clamped = Math.min(targetDay, daysInMonth(year, month0 + 1));
  return Date.UTC(year, month0, clamped) / MS_PER_DAY;
}

/**
 * Mean length of one cadence period in days, as a rational `num / den`.
 * A month is the Gregorian mean, 365.2425 / 12 days — so the baseline of a
 * monthly amount is the same in every month and every year, leap or not.
 */
function meanPeriodDays(cadence: Cadence): { num: bigint; den: bigint } {
  if (cadence.unit === "DAY") return { num: BigInt(cadence.every), den: ONE };
  if (cadence.unit === "WEEK") return { num: BigInt(7 * cadence.every), den: ONE };
  return { num: BigInt(3652425) * BigInt(cadence.every), den: BigInt(120000) };
}

/* ─────────────────────────────── integer money ───────────────────────────── */

// The build targets below ES2020, so BigInt literals (`1n`) are unavailable.
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== ZERO && (a < ZERO) !== (b < ZERO) ? q - ONE : q;
}

/** Half-up rounding of a non-negative rational to an integer. */
function roundHalfUp(num: bigint, den: bigint): number {
  return Number(floorDiv(TWO * num + den, TWO * den));
}

/**
 * The share of `amountMinor` belonging to day `index` (0-based) of a period of
 * `days` days.
 *
 * Cumulative-floor split: share(i) = ⌊A(i+1)/N⌋ − ⌊Ai/N⌋. Every share is an
 * integer, shares differ by at most one agora, and the N shares sum to EXACTLY
 * A — an allocation that loses or invents an agora over a period is a bug.
 */
export function dailyShareMinor(amountMinor: number, days: number, index: number): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new BusinessCostValidationError("amount must be a non-negative integer of minor units");
  }
  if (!Number.isInteger(days) || days < 1 || index < 0 || index >= days) {
    throw new BusinessCostValidationError("day index outside its period");
  }
  const a = BigInt(amountMinor);
  const n = BigInt(days);
  return Number(floorDiv(a * BigInt(index + 1), n) - floorDiv(a * BigInt(index), n));
}

/** amount ÷ mean period length, rounded half-up to an agora. */
export function baselineDailyMinor(amountMinor: number, cadence: Cadence): number {
  const { num, den } = meanPeriodDays(cadence);
  return roundHalfUp(BigInt(amountMinor) * den, num);
}

/* ──────────────────────────────────── inputs ─────────────────────────────── */

export type CommitmentScheduleKind = "ONE_OFF" | "RECURRING" | "INSTALLMENT_PLAN";
export type CommitmentStatus = "ACTIVE" | "CLOSED" | "RELEASED";
export type InstallmentStatus = "SCHEDULED" | "CANCELLED" | "SETTLED_LEGACY";
export type PayeeKind =
  | "SUPPLIER"
  | "AUTHORITY"
  | "UTILITY"
  | "LANDLORD"
  | "EMPLOYEE"
  | "LENDER"
  | "INSURER"
  | "OTHER";

export type CostInstallment = {
  id: number;
  sequence: number;
  /** Civil due date in the business time zone. */
  dueDate: CivilDate;
  amountMinor: number;
  currency: string;
  status: InstallmentStatus;
};

/**
 * Which table a commitment was read from.
 *   COMMITMENT         the payables ledger (`Commitment` + `Installment`).
 *   LEGACY_OBLIGATION  a `BusinessObligation` row the one-time backfill never
 *                      saw — the secretary still writes that table, with no
 *                      dual-write. Mapped 1:1 by the backfill's own rules
 *                      (programme §13), read-only, and never double-counted:
 *                      a row that has a Commitment is read from the ledger.
 */
export type CostSource = "COMMITMENT" | "LEGACY_OBLIGATION";

export type CostCommitment = {
  source: CostSource;
  /** The row id in its own source table. */
  id: number;
  title: string;
  payeeName: string;
  payeeKind: PayeeKind | null;
  currency: string;
  scheduleKind: CommitmentScheduleKind;
  recurrence: string;
  recurrenceSeriesId: string | null;
  status: CommitmentStatus;
  isLegacy: boolean;
  /**
   * Last civil day the commitment is in effect (`Commitment.endAt`, inclusive),
   * or null when no end was recorded. Legacy obligations never carry one.
   */
  endDate: CivilDate | null;
  installments: CostInstallment[];
};

export type CostPayment = {
  id: number;
  paidAt: Date;
  amountMinor: number;
  currency: string;
  status: "RECORDED" | "VOID";
  payeeName: string;
  method: string;
  /** Active allocations only — the payables-core predicate is applied upstream. */
  allocations: Array<{ installmentId: number; commitmentId: number; amountMinor: number }>;
};

export type BusinessCostInput = {
  date: CivilDate;
  timeZone: string;
  /** The currency every total is stated in. Other currencies are never converted. */
  baseCurrency: string;
  commitments: CostCommitment[];
  payments: CostPayment[];
  /**
   * The owner's affirmation that the recurring backbone is captured
   * (`BusinessObligationOrientation.oriented`). Null = never asked. Without it,
   * "complete" can only ever mean "complete over what Dubiz was told".
   */
  ownerAffirmedBackboneCaptured: boolean | null;
};

/* ─────────────────────────────────── outputs ─────────────────────────────── */

export type CostNature = "OPERATING" | "DEBT_SERVICE";

export type CostLine = {
  source: CostSource;
  /** Row id in `source`'s table. */
  commitmentId: number;
  /** Stable identity of the economic commitment (a legacy series spans rows). */
  seriesKey: string;
  title: string;
  payeeName: string;
  nature: CostNature;
  recurrence: string;
  cadence: Cadence;
  basis: "RECORDED" | "PROJECTED";
  /** The coverage period the date falls in, inclusive on both ends. */
  period: { from: CivilDate; to: CivilDate; days: number; dayIndex: number };
  periodAmountMinor: number;
  /** This date's calendar-exact share of `periodAmountMinor`. */
  allocatedMinor: number;
  /** `periodAmountMinor` normalised to a mean day of this cadence. */
  baselineDailyMinor: number;
  /** RECORDED: the installment. PROJECTED: the last recorded one it extends.
   *  Null for a legacy obligation, which has no installment row. */
  installmentId: number | null;
  installmentSequence: number;
  occurrencesProjected: number;
};

export type UncertainReason =
  | "ONE_OFF_COVERAGE_UNKNOWN"
  | "PAYMENT_PLAN_COVERAGE_UNKNOWN"
  | "UNKNOWN_CADENCE"
  | "CONFLICTING_OCCURRENCES"
  | "CONFLICTING_CADENCE";

export type UncertainItem = {
  source: CostSource;
  commitmentId: number;
  title: string;
  payeeName: string;
  reason: UncertainReason;
  amountMinor: number;
  dueDate: CivilDate | null;
};

export type ExclusionReason =
  | "NOT_STARTED"
  | "ENDED"
  | "RELEASED"
  | "INSTALLMENT_CANCELLED"
  | "NON_BASE_CURRENCY"
  | "INVALID_AMOUNT"
  | "NO_INSTALLMENTS";

export type Exclusion = {
  source: CostSource;
  commitmentId: number;
  title: string;
  reason: ExclusionReason;
  detail?: string;
};

export type CashOutPayment = {
  paymentId: number;
  amountMinor: number;
  payeeName: string;
  method: string;
  /** Which commitments this cash settled — information, never allocation. */
  allocations: Array<{ installmentId: number; commitmentId: number; amountMinor: number }>;
  unallocatedMinor: number;
};

export type CompletenessState = "EMPTY" | "COMPLETE" | "PARTIAL";

export type BusinessCostDay = {
  date: CivilDate;
  timeZone: string;
  currency: string;
  /** Operating cost economically attributable to `date`. */
  allocatedCost: {
    totalMinor: number;
    recordedMinor: number;
    projectedMinor: number;
    lines: CostLine[];
  };
  /** Recurring operating cost normalised to a mean day. The "cost to open" base. */
  baselineDailyCost: { totalMinor: number };
  /** Loan repayments: cash commitments whose cost share (interest) is unknown. */
  debtService: { allocatedMinor: number; baselineDailyMinor: number; lines: CostLine[] };
  /** Money that left the business on `date`. Independent of every figure above. */
  cashOut: {
    totalMinor: number;
    payments: CashOutPayment[];
    /** Payments that day in another currency — listed, never converted or added. */
    otherCurrency: Array<{ paymentId: number; amountMinor: number; currency: string }>;
  };
  /** Known obligations Dubiz cannot allocate. Never included in any total. */
  uncertain: {
    window: { from: CivilDate; to: CivilDate };
    totalMinor: number;
    items: UncertainItem[];
  };
  excluded: Exclusion[];
  completeness: {
    state: CompletenessState;
    reasons: string[];
    ownerAffirmedBackboneCaptured: boolean | null;
  };
};

/* ─────────────────────────────────── engine ──────────────────────────────── */

/** Guards an open-ended projection walk; a weekly commitment 100 years out is ~5,200. */
const MAX_PROJECTION_STEPS = 20_000;

type Occurrence = CostInstallment & { commitment: CostCommitment; day: number };

function natureOf(c: CostCommitment): CostNature {
  // Structured data only. A loan repayment is mostly principal — financing,
  // not cost — and the interest share is not recorded anywhere. Free-text
  // titles ("הלוואה") are deliberately NOT parsed into financial semantics.
  return c.payeeKind === "LENDER" ? "DEBT_SERVICE" : "OPERATING";
}

function seriesKeyOf(c: CostCommitment): string {
  // A legacy recurring obligation rolled forward as N separate rows sharing a
  // series id; the backfill made each row its own RECURRING commitment. They
  // are ONE economic commitment — treating them apart would count the rent
  // once for every month that ever passed.
  return c.scheduleKind === "RECURRING" && c.recurrenceSeriesId
    ? `series:${c.recurrenceSeriesId}`
    : `${c.source}:${c.id}`;
}

function monthWindow(date: CivilDate): { from: CivilDate; to: CivilDate } {
  const [y, m] = date.split("-").map(Number);
  const from = `${y}-${String(m).padStart(2, "0")}-01`;
  const to = `${y}-${String(m).padStart(2, "0")}-${String(daysInMonth(y, m)).padStart(2, "0")}`;
  return { from, to };
}

/**
 * The anchor day for month-based projection from the last recorded occurrence.
 * If that occurrence sits on a clamped month end (Feb 28 of a series born on
 * the 31st), the series' own anchor is restored instead of inheriting the clamp.
 */
function projectionAnchorDay(occurrences: Occurrence[], last: Occurrence): number {
  const lastDate = new Date(last.day * MS_PER_DAY);
  const lastDom = lastDate.getUTCDate();
  const monthEnd = daysInMonth(lastDate.getUTCFullYear(), lastDate.getUTCMonth() + 1);
  if (lastDom !== monthEnd) return lastDom;
  const firstDom = new Date(occurrences[0].day * MS_PER_DAY).getUTCDate();
  return Math.max(lastDom, firstDom);
}

export function deriveBusinessCostForDate(input: BusinessCostInput): BusinessCostDay {
  const target = toDayNumber(input.date);
  const base = input.baseCurrency.toUpperCase();

  const lines: CostLine[] = [];
  const uncertainItems: UncertainItem[] = [];
  const excluded: Exclusion[] = [];
  const window = monthWindow(input.date);
  const windowFrom = toDayNumber(window.from);
  const windowTo = toDayNumber(window.to);

  // ── group into economic commitments ──────────────────────────────────────
  const groups = new Map<string, CostCommitment[]>();
  for (const c of input.commitments) {
    const key = seriesKeyOf(c);
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }

  for (const [seriesKey, members] of groups) {
    const head = members.reduce((a, b) => (b.id > a.id ? b : a));

    if (members.some((m) => m.currency.toUpperCase() !== base)) {
      excluded.push({
        source: head.source,
        commitmentId: head.id,
        title: head.title,
        reason: "NON_BASE_CURRENCY",
        detail: `${head.currency} is not converted to ${base}`,
      });
      continue;
    }

    // ── one-off and payment plans: amount known, economic period not ──────
    if (head.scheduleKind !== "RECURRING") {
      for (const c of members) {
        for (const inst of c.installments) {
          if (inst.status === "CANCELLED") continue;
          if (c.status === "RELEASED") continue;
          const day = toDayNumber(inst.dueDate);
          if (day < windowFrom || day > windowTo) continue;
          if (inst.amountMinor < 0) {
            excluded.push({ source: c.source, commitmentId: c.id, title: c.title, reason: "INVALID_AMOUNT" });
            continue;
          }
          uncertainItems.push({
            source: c.source,
            commitmentId: c.id,
            title: c.title,
            payeeName: c.payeeName,
            reason:
              c.scheduleKind === "ONE_OFF"
                ? "ONE_OFF_COVERAGE_UNKNOWN"
                : "PAYMENT_PLAN_COVERAGE_UNKNOWN",
            amountMinor: inst.amountMinor,
            dueDate: inst.dueDate,
          });
        }
      }
      continue;
    }

    // ── recurring ─────────────────────────────────────────────────────────
    const cadences = new Set(members.map((m) => m.recurrence.trim().toUpperCase()));
    if (cadences.size > 1) {
      uncertainItems.push({
        source: head.source,
        commitmentId: head.id,
        title: head.title,
        payeeName: head.payeeName,
        reason: "CONFLICTING_CADENCE",
        amountMinor: 0,
        dueDate: null,
      });
      continue;
    }
    const cadence = parseCadence(head.recurrence);
    if (!cadence) {
      uncertainItems.push({
        source: head.source,
        commitmentId: head.id,
        title: head.title,
        payeeName: head.payeeName,
        reason: "UNKNOWN_CADENCE",
        amountMinor: head.installments[0]?.amountMinor ?? 0,
        dueDate: null,
      });
      continue;
    }

    const occurrences: Occurrence[] = members
      .flatMap((c) => c.installments.map((i) => ({ ...i, commitment: c, day: toDayNumber(i.dueDate) })))
      .sort((a, b) => a.day - b.day || a.sequence - b.sequence || a.id - b.id);

    if (occurrences.length === 0) {
      excluded.push({ source: head.source, commitmentId: head.id, title: head.title, reason: "NO_INSTALLMENTS" });
      continue;
    }

    // Two live occurrences on the same due date: the ledger disagrees with
    // itself about what is owed for that period. Not guessed.
    const liveDays = occurrences.filter((o) => o.status !== "CANCELLED").map((o) => o.day);
    if (new Set(liveDays).size !== liveDays.length) {
      uncertainItems.push({
        source: head.source,
        commitmentId: head.id,
        title: head.title,
        payeeName: head.payeeName,
        reason: "CONFLICTING_OCCURRENCES",
        amountMinor: 0,
        dueDate: null,
      });
      continue;
    }

    const first = occurrences[0];
    if (target < first.day) {
      excluded.push({
        source: head.source,
        commitmentId: head.id,
        title: head.title,
        reason: "NOT_STARTED",
        detail: `first occurrence ${first.dueDate}`,
      });
      continue;
    }

    // An end date is a fact the owner recorded: nothing is allocated after it,
    // and a period that straddles it is compressed into the days that were in
    // effect — the full recorded amount still sums exactly, over fewer days,
    // rather than leaking cost past the end or silently dropping part of it.
    const endDay = head.endDate ? toDayNumber(head.endDate) : null;
    if (endDay !== null && target > endDay) {
      excluded.push({
        source: head.source,
        commitmentId: head.id,
        title: head.title,
        reason: "ENDED",
        detail: `ended ${head.endDate}`,
      });
      continue;
    }

    // A cancelled occurrence that was replaced on the same date is history,
    // not a period: the live one owns that date.
    const liveDaySet = new Set(liveDays);
    const timeline = occurrences.filter((o) => o.status !== "CANCELLED" || !liveDaySet.has(o.day));
    const last = timeline[timeline.length - 1];

    // Every boundary after the last recorded occurrence comes from ONE function,
    // so the last recorded period and the first projected one share an edge.
    const anchorDay = cadence.unit === "MONTH" ? projectionAnchorDay(timeline, last) : undefined;
    const boundaryAfterLast = (k: number) => addCadence(last.day, cadence, k, anchorDay);

    // Recorded coverage: occurrence k covers [due_k, due_{k+1}) when the next
    // occurrence is stored, else [due_k, due_k + one cadence). Periods tile
    // with no gap and no overlap even where the ledger's own roll-forward
    // drifted, because a stored next due date always wins.
    let covering: { occ: Occurrence; from: number; toExclusive: number } | null = null;
    for (let k = 0; k < timeline.length; k += 1) {
      const occ = timeline[k];
      const next = timeline[k + 1];
      const toExclusive = next ? next.day : boundaryAfterLast(1);
      if (target >= occ.day && target < toExclusive) {
        covering = { occ, from: occ.day, toExclusive };
        break;
      }
    }

    const nature = natureOf(head);

    const pushLine = (
      occ: Occurrence,
      from: number,
      toExclusive: number,
      basis: "RECORDED" | "PROJECTED",
      occurrencesProjected: number,
    ) => {
      if (occ.amountMinor < 0 || !Number.isSafeInteger(occ.amountMinor)) {
        excluded.push({ source: occ.commitment.source, commitmentId: occ.commitment.id, title: occ.commitment.title, reason: "INVALID_AMOUNT" });
        return;
      }
      if (endDay !== null) toExclusive = Math.min(toExclusive, endDay + 1);
      const days = toExclusive - from;
      const dayIndex = target - from;
      lines.push({
        source: occ.commitment.source,
        commitmentId: occ.commitment.id,
        seriesKey,
        title: occ.commitment.title,
        payeeName: occ.commitment.payeeName,
        nature,
        recurrence: head.recurrence,
        cadence,
        basis,
        period: { from: fromDayNumber(from), to: fromDayNumber(toExclusive - 1), days, dayIndex },
        periodAmountMinor: occ.amountMinor,
        allocatedMinor: dailyShareMinor(occ.amountMinor, days, dayIndex),
        baselineDailyMinor: baselineDailyMinor(occ.amountMinor, cadence),
        installmentId: occ.commitment.source === "COMMITMENT" ? occ.id : null,
        installmentSequence: occ.sequence,
        occurrencesProjected,
      });
    };

    if (covering) {
      const { occ } = covering;
      if (occ.commitment.status === "RELEASED") {
        excluded.push({ source: occ.commitment.source, commitmentId: occ.commitment.id, title: occ.commitment.title, reason: "RELEASED" });
      } else if (occ.status === "CANCELLED") {
        excluded.push({
          source: occ.commitment.source,
          commitmentId: occ.commitment.id,
          title: occ.commitment.title,
          reason: "INSTALLMENT_CANCELLED",
          detail: `installment #${occ.sequence} (${occ.dueDate}) was cancelled`,
        });
      } else {
        // SCHEDULED and SETTLED_LEGACY both describe an occurrence that was
        // owed; whether it was paid is cash, not cost.
        pushLine(occ, covering.from, covering.toExclusive, "RECORDED", 0);
      }
      continue;
    }

    // Past the last recorded coverage. Only an ACTIVE commitment continues;
    // a closed or released one keeps its history and stops there — its end
    // date is not recorded, so nothing is projected past what is known.
    if (last.commitment.status !== "ACTIVE") {
      excluded.push({
        source: last.commitment.source,
        commitmentId: last.commitment.id,
        title: last.commitment.title,
        reason: last.commitment.status === "RELEASED" ? "RELEASED" : "ENDED",
        detail: `last recorded occurrence ${last.dueDate}`,
      });
      continue;
    }
    if (last.status === "CANCELLED") {
      // The newest occurrence was withdrawn; carrying its amount forward would
      // resurrect a cancelled obligation.
      excluded.push({
        source: last.commitment.source,
        commitmentId: last.commitment.id,
        title: last.commitment.title,
        reason: "INSTALLMENT_CANCELLED",
        detail: `latest occurrence #${last.sequence} was cancelled; nothing to project from`,
      });
      continue;
    }

    // Projected period k (k ≥ 1) is [boundary(k), boundary(k+1)).
    let step = 1;
    while (target >= boundaryAfterLast(step + 1) && step <= MAX_PROJECTION_STEPS) step += 1;
    if (step > MAX_PROJECTION_STEPS) {
      excluded.push({
        source: last.commitment.source,
        commitmentId: last.commitment.id,
        title: last.commitment.title,
        reason: "ENDED",
        detail: "projection horizon exceeded",
      });
      continue;
    }
    pushLine(last, boundaryAfterLast(step), boundaryAfterLast(step + 1), "PROJECTED", step);
  }

  // ── cash out: payments only, by their own date ───────────────────────────
  const cashPayments: CashOutPayment[] = [];
  const otherCurrency: BusinessCostDay["cashOut"]["otherCurrency"] = [];
  for (const p of input.payments) {
    if (p.status !== "RECORDED") continue;
    if (civilDateInZone(p.paidAt, input.timeZone) !== input.date) continue;
    if (p.currency.toUpperCase() !== base) {
      otherCurrency.push({ paymentId: p.id, amountMinor: p.amountMinor, currency: p.currency });
      continue;
    }
    const allocated = p.allocations.reduce((s, a) => s + a.amountMinor, 0);
    cashPayments.push({
      paymentId: p.id,
      amountMinor: p.amountMinor,
      payeeName: p.payeeName,
      method: p.method,
      allocations: p.allocations,
      unallocatedMinor: p.amountMinor - allocated,
    });
  }
  cashPayments.sort((a, b) => a.paymentId - b.paymentId);

  // ── totals ────────────────────────────────────────────────────────────────
  lines.sort((a, b) => b.allocatedMinor - a.allocatedMinor || a.commitmentId - b.commitmentId);
  const operating = lines.filter((l) => l.nature === "OPERATING");
  const debt = lines.filter((l) => l.nature === "DEBT_SERVICE");
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  const recordedMinor = sum(operating.filter((l) => l.basis === "RECORDED").map((l) => l.allocatedMinor));
  const projectedMinor = sum(operating.filter((l) => l.basis === "PROJECTED").map((l) => l.allocatedMinor));

  uncertainItems.sort((a, b) => a.commitmentId - b.commitmentId);
  excluded.sort((a, b) => a.commitmentId - b.commitmentId);

  const reasons: string[] = [];
  if (projectedMinor > 0 || debt.some((l) => l.basis === "PROJECTED")) reasons.push("PROJECTED_OCCURRENCES");
  if (uncertainItems.length > 0) reasons.push("UNALLOCATABLE_COMMITMENTS");
  if (debt.length > 0) reasons.push("DEBT_SERVICE_COST_SHARE_UNKNOWN");
  if (excluded.some((e) => e.reason === "NON_BASE_CURRENCY" || e.reason === "INVALID_AMOUNT")) {
    reasons.push("UNUSABLE_COMMITMENT_DATA");
  }
  if (input.ownerAffirmedBackboneCaptured !== true) reasons.push("BACKBONE_NOT_AFFIRMED");

  const hasAnything = lines.length > 0 || uncertainItems.length > 0;
  const state: CompletenessState = !hasAnything
    ? "EMPTY"
    : reasons.length === 0
      ? "COMPLETE"
      : "PARTIAL";

  return {
    date: input.date,
    timeZone: input.timeZone,
    currency: base,
    allocatedCost: {
      totalMinor: recordedMinor + projectedMinor,
      recordedMinor,
      projectedMinor,
      lines: operating,
    },
    baselineDailyCost: { totalMinor: sum(operating.map((l) => l.baselineDailyMinor)) },
    debtService: {
      allocatedMinor: sum(debt.map((l) => l.allocatedMinor)),
      baselineDailyMinor: sum(debt.map((l) => l.baselineDailyMinor)),
      lines: debt,
    },
    cashOut: {
      totalMinor: sum(cashPayments.map((p) => p.amountMinor)),
      payments: cashPayments,
      otherCurrency,
    },
    uncertain: {
      window,
      totalMinor: sum(uncertainItems.map((u) => u.amountMinor)),
      items: uncertainItems,
    },
    excluded,
    completeness: {
      state,
      reasons,
      ownerAffirmedBackboneCaptured: input.ownerAffirmedBackboneCaptured,
    },
  };
}

/* ─────────────────────────────── explanation ─────────────────────────────── */

function shekels(minor: number): string {
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  const frac = String(abs % 100).padStart(2, "0");
  return `${minor < 0 ? "-" : ""}₪${whole}.${frac}`;
}

function heDate(date: CivilDate): string {
  const [y, m, d] = date.split("-");
  return `${d}/${m}/${y}`;
}

const CADENCE_HE: Record<string, string> = {
  DAILY: "יומית",
  WEEKLY: "שבועית",
  BIWEEKLY: "דו-שבועית",
  MONTHLY: "חודשית",
  BIMONTHLY: "דו-חודשית",
  QUARTERLY: "רבעונית",
  SEMIANNUAL: "חצי-שנתית",
  YEARLY: "שנתית",
};

/**
 * One owner-readable sentence per line, built only from the line's own fields —
 * so every number in it can be traced back to a stored installment.
 *   "שכירות — ₪300.00 היום מתוך התחייבות חודשית של ₪9,000.00 (01/09/2026–30/09/2026, 30 ימים)"
 */
export function explainLineHe(line: CostLine): string {
  const cadence = CADENCE_HE[line.recurrence.toUpperCase()] ?? "חוזרת";
  const projected = line.basis === "PROJECTED" ? " · לפי הסכום האחרון שנרשם" : "";
  return `${line.title} — ${shekels(line.allocatedMinor)} היום מתוך התחייבות ${cadence} של ${shekels(
    line.periodAmountMinor,
  )} (${heDate(line.period.from)}–${heDate(line.period.to)}, ${line.period.days} ימים)${projected}`;
}
