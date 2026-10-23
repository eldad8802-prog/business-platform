/**
 * Exchange-rate freshness, for a future platform-admin view (FX-SOURCE-RECOMMENDATION.md §5 "Monitoring").
 * Library only — no route exposes it yet (no existing admin surface reads global reference data, and adding
 * one is new authority, i.e. a separate decision).
 *
 * Read with the runtime client (app_runtime: SELECT only on "FxRate", read-open reference data). Per pair:
 * the newest rate date (any verification), the newest date whose CURRENT value (newest fetchedAt) is VERIFIED,
 * and whether that verified rate is stale — older than STALE_AFTER_BUSINESS_DAYS business days (Mon–Fri;
 * Israeli holidays are not modelled, so a holiday can raise an early, harmless alarm — never a late one).
 */
import { prisma } from "@/lib/prisma";

import { addCivilDays, BOI_BASES, civilDateIn, type BoiBase } from "./boi-parser";

export const STALE_AFTER_BUSINESS_DAYS = 2;
/** How far back the status looks; anything older is reported as "no rate". */
export const STATUS_LOOKBACK_DAYS = 31;

export type FxStatusRow = { readonly rateDate: string; readonly fetchedAt: string; readonly verification: string };

export type FxPairStatus = {
  readonly pair: `${BoiBase}/ILS`;
  readonly latestRateDate: string | null;
  readonly latestVerifiedRateDate: string | null;
  /** The newest date's current value is UNVERIFIED (a jump / no baseline) — an admin must look. */
  readonly latestIsUnverified: boolean;
  /** Mon–Fri days after latestVerifiedRateDate up to and including today; null when there is none. */
  readonly businessDaysSinceVerified: number | null;
  readonly stale: boolean;
};

function weekday(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

/** Mon–Fri days d with from < d ≤ to (0 when to ≤ from). */
export function businessDaysAfter(from: string, to: string): number {
  if (to <= from) return 0;
  let n = 0;
  for (let d = addCivilDays(from, 1); d <= to; d = addCivilDays(d, 1)) {
    const w = weekday(d);
    if (w !== 0 && w !== 6) n += 1;
  }
  return n;
}

/** Pure: the status of one pair from its rows (any order) and today (Asia/Jerusalem). */
export function computePairStatus(base: BoiBase, rows: readonly FxStatusRow[], today: string): FxPairStatus {
  const current = new Map<string, FxStatusRow>();
  for (const r of rows) {
    if (r.rateDate > today) continue; // never counts a future-dated row as fresh
    const prev = current.get(r.rateDate);
    if (!prev || r.fetchedAt > prev.fetchedAt) current.set(r.rateDate, r);
  }
  const dates = [...current.keys()].sort();
  const latestRateDate = dates.length ? dates[dates.length - 1] : null;
  const verified = dates.filter((d) => current.get(d)!.verification === "VERIFIED");
  const latestVerifiedRateDate = verified.length ? verified[verified.length - 1] : null;
  const businessDaysSinceVerified = latestVerifiedRateDate ? businessDaysAfter(latestVerifiedRateDate, today) : null;
  return {
    pair: `${base}/ILS`,
    latestRateDate,
    latestVerifiedRateDate,
    latestIsUnverified: latestRateDate !== null && current.get(latestRateDate)!.verification !== "VERIFIED",
    businessDaysSinceVerified,
    stale: businessDaysSinceVerified === null || businessDaysSinceVerified > STALE_AFTER_BUSINESS_DAYS,
  };
}

export type FxRateStatus = { readonly today: string; readonly pairs: readonly FxPairStatus[]; readonly anyStale: boolean };

export async function getFxRateStatus(now: Date = new Date()): Promise<FxRateStatus> {
  const today = civilDateIn(now, "Asia/Jerusalem");
  const from = new Date(`${addCivilDays(today, -STATUS_LOOKBACK_DAYS)}T00:00:00.000Z`);
  const pairs: FxPairStatus[] = [];
  for (const base of BOI_BASES) {
    const rows = await prisma.fxRate.findMany({
      where: { base, quote: "ILS", kind: "REPRESENTATIVE", source: "BANK_OF_ISRAEL", rateDate: { gte: from } },
      select: { rateDate: true, fetchedAt: true, verification: true },
    });
    pairs.push(
      computePairStatus(
        base,
        rows.map((r) => ({ rateDate: r.rateDate.toISOString().slice(0, 10), fetchedAt: r.fetchedAt.toISOString(), verification: r.verification })),
        today
      )
    );
  }
  return { today, pairs, anyStale: pairs.some((p) => p.stale) };
}
