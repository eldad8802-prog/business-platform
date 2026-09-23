/**
 * HOME — the day read model: money collected through Dubiz, by Israeli hour.
 *
 * WHAT THIS IS, AND IS NOT
 *   It answers one question: "how much money came in through Dubiz on this
 *   day, and when". It is NOT the business's revenue — cash, cheques and bank
 *   transfers never pass through Dubiz — so nothing built on it may be labelled
 *   "הכנסות". The Home screen says "נגבה דרך Dubiz".
 *
 * WHICH MONEY COUNTS
 *   The verified `PaymentTransaction` (status PAID, amount > 0), reached
 *   through its request's `businessId`. This is the definition the collection
 *   product settled on, and it is the stricter one in the direction that
 *   matters: a request the owner later cancelled can still have been paid
 *   through its link, and that money must not vanish. The older Home counter
 *   summed `PaymentRequest.paidAt` instead and therefore under-reported exactly
 *   that case.
 *
 * WHICH DAY
 *   Israeli calendar days, via `jerusalemDayUtcHalfOpen`. A day is 23, 24 or 25
 *   hours long across the two DST changes, which is how the business lived it.
 *   Nothing here reads the server's own timezone, so the answer does not depend
 *   on where the process runs — the old month boundary did, and on Vercel (UTC)
 *   it pushed the first two hours of every Israeli month into the month before.
 *
 * WHY COMPLETENESS IS NOT A GUESS ANYMORE
 *   The previous approach reconstructed a day in the browser from the newest
 *   500 paid requests, so an older day could be silently partial. This asks the
 *   database for the exact range, so a returned day is whole by construction.
 *   The flag stays on the wire because the SCREEN must keep distinguishing
 *   "nothing came in" from "we could not tell".
 */
import { Prisma } from "@prisma/client";

import { tenantTx } from "@/lib/tenant/tenant-tx";
import {
  ISRAEL_TIME_ZONE,
  jerusalemDayKey,
  jerusalemDayUtcHalfOpen,
  jerusalemHour,
  type JerusalemDayKey,
} from "@/lib/utils/jerusalem-day";
import { jerusalemMonthUtcHalfOpen } from "@/lib/utils/jerusalem-month-range";

export type HomeDayFigure = {
  /** 24 Israeli hours, `hours[9]` is 09:00–09:59. Money, as a fixed string. */
  hours: string[];
  total: string;
  count: number;
  /** True whenever the range was read from the database directly. */
  complete: boolean;
};

export type HomeMonthFigure = {
  /** `YYYY-MM` in Israel. */
  key: string;
  amount: string;
  count: number;
  previousAmount: string;
  previousCount: number;
  /**
   * Whole-month against whole previous month, rounded. `null` — never 0 — when
   * there is no previous month to compare with, because "no comparison" and
   * "no change" are different facts.
   */
  changePct: number | null;
};

export type HomeActivityFigure = {
  /** Tax invoices (and invoice-receipts) ISSUED today. */
  invoicesIssued: number;
  /** Leads created today. */
  newLeads: number;
};

export type HomeDayReadModel = {
  timezone: string;
  date: JerusalemDayKey;
  isToday: boolean;
  day: HomeDayFigure;
  month: HomeMonthFigure | null;
  activity: HomeActivityFigure | null;
};

export class FutureDayError extends Error {
  constructor(date: string) {
    super(`refusing to report a day that has not happened: ${date}`);
    this.name = "FutureDayError";
  }
}

const ZERO = new Prisma.Decimal(0);

/** `YYYY-MM` of an Israeli day key. */
function monthKeyOf(day: JerusalemDayKey): string {
  return day.slice(0, 7);
}

/** The Israeli month before this one. */
function previousMonthKey(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/**
 * The whole read model for one day.
 *
 * `scope: "day"` is for day navigation, where only the selected day changes:
 * the month context and today's activity are the same facts they were a click
 * ago, so re-aggregating them would be work with no answer attached.
 */
export async function loadHomeDay(
  businessId: number,
  input: { date?: string | null; scope?: "full" | "day"; now?: Date } = {}
): Promise<HomeDayReadModel> {
  const now = input.now ?? new Date();
  const todayKey = jerusalemDayKey(now);
  const date = normalizeDayKey(input.date) ?? todayKey;
  if (date > todayKey) throw new FutureDayError(date);

  const isToday = date === todayKey;
  const full = (input.scope ?? "full") === "full";
  const dayRange = jerusalemDayUtcHalfOpen(date);
  const monthKey = monthKeyOf(todayKey);
  const thisMonth = jerusalemMonthUtcHalfOpen(monthKey);
  const prevMonth = jerusalemMonthUtcHalfOpen(previousMonthKey(monthKey));

  return tenantTx(businessId, async (tx) => {
    const paidWhere = (from: Date, toExclusive: Date): Prisma.PaymentTransactionWhereInput => ({
      status: "PAID",
      amount: { gt: 0 },
      // PaymentTransaction carries no businessId of its own; the request is the
      // only tenant anchor it has, and it is a required relation.
      paymentRequest: { businessId },
      createdAt: { gte: from, lt: toExclusive },
    });

    const rows = await tx.paymentTransaction.findMany({
      where: paidWhere(dayRange.from, dayRange.toExclusive),
      select: { amount: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    const day = bucketByJerusalemHour(rows);

    if (!full) {
      return { timezone: ISRAEL_TIME_ZONE, date, isToday, day, month: null, activity: null };
    }

    const [current, previous] = await Promise.all([
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

    const amount = current._sum.amount ?? ZERO;
    const previousAmount = previous._sum.amount ?? ZERO;
    const month: HomeMonthFigure = {
      key: monthKey,
      amount: amount.toFixed(2),
      count: current._count._all,
      previousAmount: previousAmount.toFixed(2),
      previousCount: previous._count._all,
      changePct: monthChangePct(amount, previousAmount),
    };

    // "עוד היום" describes today and only today, so it is read for the
    // current day even while an earlier day is on screen — the screen is what
    // decides whether to show it.
    const todayRange = jerusalemDayUtcHalfOpen(todayKey);
    const [invoicesIssued, newLeads] = await Promise.all([
      tx.billingDocument.count({
        where: {
          businessId,
          status: "ISSUED",
          documentType: { in: ["TAX_INVOICE", "TAX_INVOICE_RECEIPT"] },
          issuedAt: { gte: todayRange.from, lt: todayRange.toExclusive },
        },
      }),
      tx.lead.count({
        where: {
          businessId,
          createdAt: { gte: todayRange.from, lt: todayRange.toExclusive },
        },
      }),
    ]);

    return {
      timezone: ISRAEL_TIME_ZONE,
      date,
      isToday,
      day,
      month,
      activity: { invoicesIssued, newLeads },
    };
  });
}

/**
 * Verified payments into 24 Israeli hours.
 *
 * Exported for its own test: bucketing is where a timezone mistake would hide,
 * and the rule "two payments in the same hour are one bar" only shows up in a
 * test that can put two payments in the same hour.
 */
export function bucketByJerusalemHour(
  rows: { amount: Prisma.Decimal | number | string; createdAt: Date }[]
): HomeDayFigure {
  const buckets = Array.from({ length: 24 }, () => ZERO);
  let total = ZERO;
  for (const row of rows) {
    const hour = jerusalemHour(row.createdAt);
    buckets[hour] = buckets[hour].plus(row.amount);
    total = total.plus(row.amount);
  }
  return {
    hours: buckets.map((b) => b.toFixed(2)),
    total: total.toFixed(2),
    count: rows.length,
    complete: true,
  };
}

/**
 * Month against previous month, as a whole percent.
 *
 * `null` when the previous month collected nothing: a change from zero has no
 * percentage, and showing "+100%" — or worse, "0%" — would be inventing a
 * comparison the business never had.
 */
export function monthChangePct(
  amount: Prisma.Decimal,
  previousAmount: Prisma.Decimal
): number | null {
  if (!previousAmount.greaterThan(ZERO)) return null;
  return Math.round(amount.minus(previousAmount).dividedBy(previousAmount).times(100).toNumber());
}

/** Accepts `YYYY-MM-DD` and nothing else; anything malformed is treated as absent. */
export function normalizeDayKey(raw: string | null | undefined): JerusalemDayKey | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Round-tripping through the day boundary rejects impossible dates such as
  // 2026-02-31, which the pattern alone would let through.
  return jerusalemDayKey(jerusalemDayUtcHalfOpen(value).from) === value ? value : null;
}
