/**
 * Month boundaries in Asia/Jerusalem for API filtering (half-open: [from, toExclusive)).
 */

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
 */
function findFirstUtcForJerusalemDate(ymd: string): Date {
  const [yy, mm, dd] = ymd.split("-").map(Number);
  const start = Date.UTC(yy, mm - 1, dd) - 96 * 3600 * 1000;
  const end = Date.UTC(yy, mm - 1, dd) + 96 * 3600 * 1000;

  let minMinute = Infinity;
  for (let t = start; t <= end; t += 60 * 1000) {
    if (dateKeyJerusalem(new Date(t)) === ymd) {
      minMinute = Math.min(minMinute, t);
    }
  }
  if (!Number.isFinite(minMinute)) {
    throw new Error(`jerusalem_date_not_found:${ymd}`);
  }

  let lo = minMinute - 120 * 1000;
  let hi = minMinute + 120 * 1000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (dateKeyJerusalem(new Date(mid)) === ymd) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return new Date(hi);
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
