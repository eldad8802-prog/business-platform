/**
 * Month boundaries in Asia/Jerusalem for API filtering (half-open: [from, toExclusive)).
 */

import { startOfJerusalemDayUtc } from "./jerusalem-day";

const TZ = "Asia/Jerusalem";

export function dateKeyJerusalem(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Current calendar YYYY-MM in Jerusalem (for default inbox month). */
export function getCurrentYearMonthJerusalem(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  if (!y || !m) {
    throw new Error("Failed to resolve Jerusalem month");
  }
  return `${y}-${m}`;
}

/** groupMonth for a Document.createdAt (Jerusalem calendar month). */
export function formatYearMonthJerusalem(d: Date): string {
  return getCurrentYearMonthJerusalem(d);
}

/** Process-local memo for half-open Jerusalem month bounds (key: canonical `YYYY-MM`). */
const jerusalemMonthUtcHalfOpenCache = new Map<
  string,
  { fromMs: number; toExclusiveMs: number }
>();

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Earliest UTC instant where local Jerusalem calendar date is exactly `ymd` (YYYY-MM-DD).
 *
 * That instant is the start of the Israeli day, which `startOfJerusalemDayUtc`
 * resolves in O(1) with one shared formatter (Israel's DST shifts happen at
 * 02:00 local, never at midnight, so local midnight always exists).
 *
 * It used to be found by scanning ±96 h minute by minute, constructing a fresh
 * Intl.DateTimeFormat per minute: ~46,000 constructions for one month range,
 * 2–6 s of synchronous CPU on the first call per process. Inside an open
 * interactive transaction (/api/home/collection) that alone outlived Prisma's
 * 5000 ms timeout — the root cause of the intermittent P2028 (#658).
 */
function findFirstUtcForJerusalemDate(ymd: string): Date {
  return startOfJerusalemDayUtc(ymd);
}

/**
 * Validates YYYY-MM and returns UTC half-open range for that Jerusalem month.
 */
export function jerusalemMonthUtcHalfOpen(yearMonth: string): {
  from: Date;
  toExclusive: Date;
} {
  const m = /^(\d{4})-(\d{2})$/.exec(yearMonth.trim());
  if (!m) {
    throw new Error("invalid_month_format");
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) {
    throw new Error("invalid_month_values");
  }

  const cacheKey = `${y}-${pad2(mo)}`;
  const cached = jerusalemMonthUtcHalfOpenCache.get(cacheKey);
  if (cached) {
    return {
      from: new Date(cached.fromMs),
      toExclusive: new Date(cached.toExclusiveMs),
    };
  }

  const startYmd = `${y}-${pad2(mo)}-01`;
  const next =
    mo === 12 ? { y: y + 1, m: 1 } : { y, m: mo + 1 };
  const nextStartYmd = `${next.y}-${pad2(next.m)}-01`;

  const from = findFirstUtcForJerusalemDate(startYmd);
  const toExclusive = findFirstUtcForJerusalemDate(nextStartYmd);

  jerusalemMonthUtcHalfOpenCache.set(cacheKey, {
    fromMs: from.getTime(),
    toExclusiveMs: toExclusive.getTime(),
  });

  return {
    from: new Date(from.getTime()),
    toExclusive: new Date(toExclusive.getTime()),
  };
}
