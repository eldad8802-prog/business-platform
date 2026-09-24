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

export type HomePeriod = "today" | "yesterday" | "week";

export type HomeSeries = {
  /** Cumulative ₪ at each point: 24 hours for a day, 7 days for a week. */
  points: string[];
  /** How many leading points have actually happened. Never the whole array for a day in progress. */
  elapsedPoints: number;
  total: string;
  count: number;
};

export type HomeCollectionReadModel = {
  timezone: string;
  period: HomePeriod;
  /** "hour" for a day, "day" for the week. */
  granularity: "hour" | "day";
  current: HomeSeries;
  /** The period before, over its whole length — the dashed line. */
  previous: HomeSeries;
  /** The previous period measured only as far as the current one has reached. */
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
    amount: string;
    count: number;
    previousAmount: string;
    changePct: number | null;
  } | null;
};

const ZERO = new Prisma.Decimal(0);

type PaidRow = { amount: Prisma.Decimal; createdAt: Date };

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

/** Cumulative totals per bucket, and the running total. */
export function cumulate(
  rows: PaidRow[],
  bucketOf: (row: PaidRow) => number,
  length: number
): { points: string[]; total: Prisma.Decimal; count: number } {
  const perBucket = Array.from({ length }, () => ZERO);
  for (const row of rows) {
    const index = bucketOf(row);
    if (index >= 0 && index < length) perBucket[index] = perBucket[index].plus(row.amount);
  }
  let running = ZERO;
  const points = perBucket.map((value) => {
    running = running.plus(value);
    return running.toFixed(2);
  });
  return { points, total: running, count: rows.length };
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

  return tenantTx(businessId, async (tx) => {
    const paidWhere = (from: Date, toExclusive: Date): Prisma.PaymentTransactionWhereInput => ({
      status: "PAID",
      amount: { gt: 0 },
      // PaymentTransaction carries no businessId of its own; the request is its
      // only tenant anchor, and it is a required relation.
      paymentRequest: { businessId },
      createdAt: { gte: from, lt: toExclusive },
    });

    const monthKey = jerusalemDayKey(now).slice(0, 7);
    const [y, m] = monthKey.split("-").map(Number);
    const thisMonth = jerusalemMonthUtcHalfOpen(monthKey);
    const prevMonth = jerusalemMonthUtcHalfOpen(
      m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`
    );

    const [currentRows, previousRows, monthAgg, prevMonthAgg] = await Promise.all([
      tx.paymentTransaction.findMany({
        where: paidWhere(w.currentStart, w.currentEnd),
        select: { amount: true, createdAt: true },
      }),
      tx.paymentTransaction.findMany({
        where: paidWhere(w.previousStart, w.previousEnd),
        select: { amount: true, createdAt: true },
      }),
      tx.paymentTransaction.aggregate({
        where: paidWhere(thisMonth.from, thisMonth.toExclusive),
        _sum: { amount: true },
        _count: { _all: true },
      }),
      tx.paymentTransaction.aggregate({
        where: paidWhere(prevMonth.from, prevMonth.toExclusive),
        _sum: { amount: true },
        _count: { _all: true },
      }),
    ]);

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

    // The previous period, measured only as far as the current one has reached.
    const comparableRows = previousRows.filter((row) => row.createdAt < w.previousCut);
    const previousAtSamePoint = comparableRows.reduce((sum, row) => sum.plus(row.amount), ZERO);

    const monthAmount = monthAgg._sum.amount ?? ZERO;
    const prevMonthAmount = prevMonthAgg._sum.amount ?? ZERO;

    return {
      timezone: ISRAEL_TIME_ZONE,
      period,
      granularity: w.granularity,
      current: {
        points: current.points,
        elapsedPoints: w.elapsedPoints,
        total: current.total.toFixed(2),
        count: current.count,
      },
      previous: {
        points: previous.points,
        elapsedPoints: w.length,
        total: previous.total.toFixed(2),
        count: previous.count,
      },
      previousAtSamePoint: previousAtSamePoint.toFixed(2),
      changePct: changeAgainst(current.total, previousAtSamePoint),
      cutoffLabel: w.cutoffLabel,
      window: w.window,
      previousWindow: w.previousWindow,
      month: {
        key: monthKey,
        amount: monthAmount.toFixed(2),
        count: monthAgg._count._all,
        previousAmount: prevMonthAmount.toFixed(2),
        changePct: changeAgainst(monthAmount, prevMonthAmount),
      },
    };
  });
}

/** Whole calendar days between two Israeli day keys. */
function daysFrom(from: JerusalemDayKey, to: JerusalemDayKey): number {
  const ord = (key: string) => {
    const [y, m, d] = key.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ord(to) - ord(from)) / 86_400_000);
}
