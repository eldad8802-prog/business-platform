/**
 * HOME — collection over a period, against the period before it.
 *
 * The screen asks one question with three framings: היום · אתמול · שבוע. Each
 * one is a window and the window that preceded it, and the comparison is always
 * cut at the SAME point in both. "Today so far" is measured against "yesterday
 * up to this same hour" — comparing a morning against a whole day would report
 * a collapse every morning and a miracle every evening.
 *
 * WHICH MONEY: the verified `PaymentTransaction` (PAID, amount > 0), reached
 * through its request's business. Same definition the collection product uses,
 * and the same one the day read model already ships with.
 *
 * WHICH CALENDAR: Asia/Jerusalem, through `jerusalem-day`. Boundaries and the
 * comparison cut are both resolved as wall-clock instants, so a DST change
 * moves them with the country rather than with UTC.
 *
 * WHAT IT NEVER DOES: draw a point that has not happened. `elapsedPoints` says
 * how much of the current series is real; everything past it is absent, not
 * zero. A failed read is a failure, never ₪0.
 */
import { Prisma } from "@prisma/client";

import { tenantTx } from "@/lib/tenant/tenant-tx";
import { homeCollectionTxObserver, markHomeCollection } from "@/lib/services/home/home-collection-timeline";
import {
  addCalendarDays,
  ISRAEL_TIME_ZONE,
  jerusalemClock,
  jerusalemDayKey,
  jerusalemHour,
  jerusalemInstantAt,
  startOfJerusalemDayUtc,
  type JerusalemDayKey,
} from "@/lib/utils/jerusalem-day";
import { jerusalemMonthUtcHalfOpen } from "@/lib/utils/jerusalem-month-range";
import { currencyOrBase } from "@/lib/money/currency-split";
import {
  addToCurrency,
  foldPaidGroups,
  hasOtherCurrency,
  HOME_CURRENCY,
  listCurrencyTotals,
  type HomeCurrencyTotal,
} from "@/lib/services/home/home-currency";

export type HomePeriod = "today" | "yesterday" | "week";

export type HomeSeries = {
  /** Cumulative ₪ at each point: 24 hours for a day, 7 days for a week. ILS money only. */
  points: string[];
  /** How many leading points have actually happened. Never the whole array for a day in progress. */
  elapsedPoints: number;
  /** ILS only — another currency is never added in (see totalsByCurrency). */
  total: string;
  /** Every verified payment in the window, whatever its currency (a count adds no money). */
  count: number;
  /** The currency of `points` and `total`: always ILS (the screen draws ₪). */
  currency: string;
  /** Per-currency totals, ILS first; only currencies that occurred. */
  totalsByCurrency: HomeCurrencyTotal[];
  /** True when money in another currency came in — `points` / `total` do not include it. */
  isMixedCurrency: boolean;
};

export type HomeCollectionReadModel = {
  timezone: string;
  period: HomePeriod;
  /** "hour" for a day, "day" for the week. */
  granularity: "hour" | "day";
  current: HomeSeries;
  /** The period before, over its whole length — the dashed line. */
  previous: HomeSeries;
  /** The previous period measured only as far as the current one has reached. ILS only. */
  previousAtSamePoint: string;
  /**
   * Current against previous AT THE SAME POINT, rounded. `null` — never 0 —
   * when the previous period collected nothing, because a change from nothing
   * has no percentage.
   */
  changePct: number | null;
  /** "15:25" while today is in progress; null once a period is whole. */
  cutoffLabel: string | null;
  /** Israeli dates the two windows cover, for labels and tests. */
  window: { from: JerusalemDayKey; to: JerusalemDayKey };
  previousWindow: { from: JerusalemDayKey; to: JerusalemDayKey };
  month: {
    key: string;
    /** ILS only (see totalsByCurrency). */
    amount: string;
    /** Every verified payment of the month, whatever its currency. */
    count: number;
    /** ILS only (see previousTotalsByCurrency). */
    previousAmount: string;
    changePct: number | null;
    currency: string;
    totalsByCurrency: HomeCurrencyTotal[];
    previousTotalsByCurrency: HomeCurrencyTotal[];
    isMixedCurrency: boolean;
  } | null;
  /** True when any figure above left out money in a currency other than ILS. */
  isMixedCurrency: boolean;
};

const ZERO = new Prisma.Decimal(0);

type PaidRow = { amount: Prisma.Decimal; createdAt: Date; currency?: string | null };

/** The windows a period covers, and where the comparison is cut. */
export function resolveWindows(period: HomePeriod, now: Date) {
  const today = jerusalemDayKey(now);
  const clock = jerusalemClock(now);

  if (period === "week") {
    // The last 7 Israeli days, today included and still in progress.
    const from = addCalendarDays(today, -6);
    const prevTo = addCalendarDays(from, -1);
    const prevFrom = addCalendarDays(prevTo, -6);
    return {
      granularity: "day" as const,
      length: 7,
      window: { from, to: today },
      previousWindow: { from: prevFrom, to: prevTo },
      currentStart: startOfJerusalemDayUtc(from),
      currentEnd: now,
      previousStart: startOfJerusalemDayUtc(prevFrom),
      previousEnd: startOfJerusalemDayUtc(addCalendarDays(prevTo, 1)),
      // The same wall-clock moment on the last day of the previous window.
      previousCut: jerusalemInstantAt(prevTo, clock.hours, clock.minutes),
      elapsedPoints: 7,
      inProgress: true,
      cutoffLabel: `${String(clock.hours).padStart(2, "0")}:${String(clock.minutes).padStart(2, "0")}`,
    };
  }

  const day = period === "today" ? today : addCalendarDays(today, -1);
  const previousDay = addCalendarDays(day, -1);
  const inProgress = period === "today";
  return {
    granularity: "hour" as const,
    length: 24,
    window: { from: day, to: day },
    previousWindow: { from: previousDay, to: previousDay },
    currentStart: startOfJerusalemDayUtc(day),
    currentEnd: inProgress ? now : startOfJerusalemDayUtc(addCalendarDays(day, 1)),
    previousStart: startOfJerusalemDayUtc(previousDay),
    previousEnd: startOfJerusalemDayUtc(day),
    previousCut: inProgress
      ? jerusalemInstantAt(previousDay, clock.hours, clock.minutes)
      : startOfJerusalemDayUtc(day),
    // A day in progress has only reached the hour it is in.
    elapsedPoints: inProgress ? jerusalemHour(now) + 1 : 24,
    inProgress,
    cutoffLabel: inProgress
      ? `${String(clock.hours).padStart(2, "0")}:${String(clock.minutes).padStart(2, "0")}`
      : null,
  };
}

/**
 * Cumulative ILS totals per bucket, and the running ILS total. Rows in another currency are kept
 * on their own line in `totalsByCurrency` and never enter the points; `count` is every row.
 */
export function cumulate(
  rows: PaidRow[],
  bucketOf: (row: PaidRow) => number,
  length: number
): { points: string[]; total: Prisma.Decimal; count: number; totalsByCurrency: HomeCurrencyTotal[] } {
  const perBucket = Array.from({ length }, () => ZERO);
  const byCurrency = new Map<string, { total: Prisma.Decimal; count: number }>();
  for (const row of rows) {
    const index = bucketOf(row);
    if (index < 0 || index >= length) continue;
    addToCurrency(byCurrency, row.currency, row.amount);
    if (currencyOrBase(row.currency) !== HOME_CURRENCY) continue;
    perBucket[index] = perBucket[index].plus(row.amount);
  }
  let running = ZERO;
  const points = perBucket.map((value) => {
    running = running.plus(value);
    return running.toFixed(2);
  });
  return { points, total: running, count: rows.length, totalsByCurrency: listCurrencyTotals(byCurrency) };
}

/** A change a business can read. `null` when there is nothing to compare against. */
export function changeAgainst(current: Prisma.Decimal, previous: Prisma.Decimal): number | null {
  if (!previous.greaterThan(ZERO)) return null;
  return Math.round(current.minus(previous).dividedBy(previous).times(100).toNumber());
}

export async function loadHomeCollection(
  businessId: number,
  input: { period?: string | null; now?: Date } = {}
): Promise<HomeCollectionReadModel> {
  const now = input.now ?? new Date();
  const period: HomePeriod =
    input.period === "yesterday" || input.period === "week" ? input.period : "today";
  const w = resolveWindows(period, now);

  // Month bounds are pure computation: resolve them BEFORE the interactive
  // transaction opens, so no CPU work runs on the transaction's 5000 ms clock
  // (the P2028 of #658 was exactly that — see jerusalem-month-range.ts).
  const monthKey = jerusalemDayKey(now).slice(0, 7);
  const [y, m] = monthKey.split("-").map(Number);
  const thisMonth = jerusalemMonthUtcHalfOpen(monthKey);
  const prevMonth = jerusalemMonthUtcHalfOpen(
    m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`
  );

  // Observability marks (see home-collection-timeline.ts): they record time and
  // nothing else, and are silent when no timeline is in scope.
  markHomeCollection("T1");
  const model = await tenantTx(businessId, async (tx) => {
    const paidWhere = (from: Date, toExclusive: Date): Prisma.PaymentTransactionWhereInput => ({
      status: "PAID",
      amount: { gt: 0 },
      // PaymentTransaction carries no businessId of its own; the request is its
      // only tenant anchor, and it is a required relation.
      paymentRequest: { businessId },
      createdAt: { gte: from, lt: toExclusive },
    });

    markHomeCollection("T5");
    const [currentRows, previousRows, monthGroups, prevMonthGroups] = await Promise.all([
      tx.paymentTransaction.findMany({
        where: paidWhere(w.currentStart, w.currentEnd),
        select: { amount: true, currency: true, createdAt: true },
      }),
      tx.paymentTransaction.findMany({
        where: paidWhere(w.previousStart, w.previousEnd),
        select: { amount: true, currency: true, createdAt: true },
      }),
      // Grouped by currency (still four reads): the ILS group is the month figure.
      tx.paymentTransaction.groupBy({
        by: ["currency"],
        where: paidWhere(thisMonth.from, thisMonth.toExclusive),
        _sum: { amount: true },
        _count: { _all: true },
      }),
      tx.paymentTransaction.groupBy({
        by: ["currency"],
        where: paidWhere(prevMonth.from, prevMonth.toExclusive),
        _sum: { amount: true },
        _count: { _all: true },
      }),
    ]);
    markHomeCollection("T6");

    const bucketOf =
      w.granularity === "hour"
        ? (row: PaidRow) => jerusalemHour(row.createdAt)
        : (start: JerusalemDayKey) => (row: PaidRow) =>
            daysFrom(start, jerusalemDayKey(row.createdAt));

    const currentBucket =
      w.granularity === "hour" ? (bucketOf as (r: PaidRow) => number) : (bucketOf as (s: string) => (r: PaidRow) => number)(w.window.from);
    const previousBucket =
      w.granularity === "hour" ? (bucketOf as (r: PaidRow) => number) : (bucketOf as (s: string) => (r: PaidRow) => number)(w.previousWindow.from);

    const current = cumulate(currentRows, currentBucket, w.length);
    const previous = cumulate(previousRows, previousBucket, w.length);

    // The previous period, measured only as far as the current one has reached — in ILS, like
    // the current total it is compared with.
    const comparableRows = previousRows.filter(
      (row) => row.createdAt < w.previousCut && currencyOrBase(row.currency) === HOME_CURRENCY
    );
    const previousAtSamePoint = comparableRows.reduce((sum, row) => sum.plus(row.amount), ZERO);

    const monthFold = foldPaidGroups(monthGroups);
    const prevMonthFold = foldPaidGroups(prevMonthGroups);
    const monthAmount = monthFold.amount;
    const prevMonthAmount = prevMonthFold.amount;
    const currentMixed = hasOtherCurrency(current.totalsByCurrency);
    const previousMixed = hasOtherCurrency(previous.totalsByCurrency);
    const monthMixed =
      hasOtherCurrency(monthFold.totalsByCurrency) || hasOtherCurrency(prevMonthFold.totalsByCurrency);

    return {
      timezone: ISRAEL_TIME_ZONE,
      period,
      granularity: w.granularity,
      current: {
        points: current.points,
        elapsedPoints: w.elapsedPoints,
        total: current.total.toFixed(2),
        count: current.count,
        currency: HOME_CURRENCY,
        totalsByCurrency: current.totalsByCurrency,
        isMixedCurrency: currentMixed,
      },
      previous: {
        points: previous.points,
        elapsedPoints: w.length,
        total: previous.total.toFixed(2),
        count: previous.count,
        currency: HOME_CURRENCY,
        totalsByCurrency: previous.totalsByCurrency,
        isMixedCurrency: previousMixed,
      },
      previousAtSamePoint: previousAtSamePoint.toFixed(2),
      changePct: changeAgainst(current.total, previousAtSamePoint),
      cutoffLabel: w.cutoffLabel,
      window: w.window,
      previousWindow: w.previousWindow,
      month: {
        key: monthKey,
        amount: monthAmount.toFixed(2),
        count: monthFold.count,
        previousAmount: prevMonthAmount.toFixed(2),
        changePct: changeAgainst(monthAmount, prevMonthAmount),
        currency: HOME_CURRENCY,
        totalsByCurrency: monthFold.totalsByCurrency,
        previousTotalsByCurrency: prevMonthFold.totalsByCurrency,
        isMixedCurrency: monthMixed,
      },
      isMixedCurrency: currentMixed || previousMixed || monthMixed,
    };
  }, { onPhase: homeCollectionTxObserver });
  markHomeCollection("T7");
  return model;
}

/** Whole calendar days between two Israeli day keys. */
function daysFrom(from: JerusalemDayKey, to: JerusalemDayKey): number {
  const ord = (key: string) => {
    const [y, m, d] = key.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ord(to) - ord(from)) / 86_400_000);
}
