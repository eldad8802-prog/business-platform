/**
 * Accounting periods for the monthly accountant workflow — pure, no database.
 *
 * A period is an Israeli calendar month, keyed `YYYY-MM`. Every boundary is a half-open UTC range
 * `[from, toExclusive)` computed in Asia/Jerusalem by the shared helper (`jerusalemMonthUtcHalfOpen`),
 * so a record dated 00:30 on the 1st (Israel) belongs to the new month and a DST change never moves
 * a boundary. Dates stored as a bare calendar day (UTC midnight) always fall inside the month they
 * name, because Israel is ahead of UTC.
 *
 * The same module resolves the ad-hoc export request of the accountant-pack screen (month, quarter,
 * year). It refuses anything it cannot read instead of falling back to "no date filter" — the
 * previous resolver exported every record of the business when a quarter request arrived without a
 * separate `year` field, and always exported last year for a year request.
 */

import { getCurrentYearMonthJerusalem, jerusalemMonthUtcHalfOpen } from "@/lib/utils/jerusalem-month-range";

export type PeriodKey = string;

export type PeriodRange = {
  /** Inclusive lower bound (UTC instant of the Israeli start). */
  from: Date;
  /** Exclusive upper bound (UTC instant of the Israeli start of the next period). */
  toExclusive: Date;
};

const PERIOD_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;
const YEAR = /^(\d{4})$/;
const QUARTER_COMBINED = /^(\d{4})-Q([1-4])$/i;
const QUARTER_ONLY = /^Q?([1-4])$/i;

/** The earliest and latest years an export may name (a typo guard, not an accounting rule). */
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

const MONTH_NAMES_HE = [
  "ינואר",
  "פברואר",
  "מרץ",
  "אפריל",
  "מאי",
  "יוני",
  "יולי",
  "אוגוסט",
  "ספטמבר",
  "אוקטובר",
  "נובמבר",
  "דצמבר",
] as const;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function yearInRange(y: number): boolean {
  return Number.isInteger(y) && y >= MIN_YEAR && y <= MAX_YEAR;
}

export function isPeriodKey(value: unknown): value is PeriodKey {
  if (typeof value !== "string") return false;
  const m = PERIOD_KEY.exec(value);
  return m !== null && yearInRange(Number(m[1]));
}

function splitKey(key: PeriodKey): { y: number; m: number } {
  const match = PERIOD_KEY.exec(key);
  if (!match || !yearInRange(Number(match[1]))) throw new Error("invalid_period_key");
  return { y: Number(match[1]), m: Number(match[2]) };
}

export function periodKeyOf(y: number, m: number): PeriodKey {
  return `${y}-${pad2(m)}`;
}

/** Calendar arithmetic on period keys (no time zone involved). */
export function addPeriods(key: PeriodKey, delta: number): PeriodKey {
  const { y, m } = splitKey(key);
  const index = y * 12 + (m - 1) + delta;
  return periodKeyOf(Math.floor(index / 12), (index % 12) + 1);
}

/** Half-open UTC range of one Israeli calendar month. */
export function periodRange(key: PeriodKey): PeriodRange {
  splitKey(key);
  return jerusalemMonthUtcHalfOpen(key);
}

/** The Israeli calendar month that `now` falls in. */
export function currentPeriodKey(now: Date): PeriodKey {
  return getCurrentYearMonthJerusalem(now);
}

/** The most recently completed Israeli calendar month — what the 1st-of-month preparation evaluates. */
export function previousPeriodKey(now: Date): PeriodKey {
  return addPeriods(currentPeriodKey(now), -1);
}

/** True once the whole month is in the past in Israel (from 00:00 on the 1st of the next month). */
export function isPeriodClosed(key: PeriodKey, now: Date): boolean {
  return now.getTime() >= periodRange(key).toExclusive.getTime();
}

/** Jerusalem day of month (1..31) of an instant. */
export function jerusalemDayOfMonth(now: Date): number {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", day: "2-digit" }).format(now);
  return Number(day);
}

/** "ספטמבר" */
export function monthNameHe(key: PeriodKey): string {
  return MONTH_NAMES_HE[splitKey(key).m - 1];
}

/** "ספטמבר 2026" */
export function periodLabelHe(key: PeriodKey): string {
  const { y } = splitKey(key);
  return `${monthNameHe(key)} ${y}`;
}

/** Whether `instant` falls in `[range.from, range.toExclusive)`. */
export function inRange(instant: Date, range: PeriodRange): boolean {
  const t = instant.getTime();
  return t >= range.from.getTime() && t < range.toExclusive.getTime();
}

// ── Ad-hoc export request (the accountant-pack screen) ───────────────────────────────────────────

export type ExportRequestBody = {
  type?: unknown;
  month?: unknown;
  year?: unknown;
  quarter?: unknown;
};

export type ResolvedExportRange =
  | { ok: true; kind: "month" | "quarter" | "year"; label: string; range: PeriodRange }
  | { ok: false; error: "invalid_type" | "invalid_month" | "invalid_quarter" | "invalid_year" };

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Reads the screen's request. Accepted shapes:
 *   month    { type: "month",   month: "2026-09" }
 *   quarter  { type: "quarter", quarter: "2026-Q3" }   or   { type: "quarter", year: "2026", quarter: "3" | "Q3" }
 *   year     { type: "year",    year: "2025" }
 * Anything else is refused — never widened to an unbounded export.
 */
export function resolveExportRequest(body: ExportRequestBody): ResolvedExportRange {
  const type = str(body.type);

  if (type === "month") {
    const month = str(body.month);
    if (!isPeriodKey(month)) return { ok: false, error: "invalid_month" };
    return { ok: true, kind: "month", label: month, range: periodRange(month) };
  }

  if (type === "quarter") {
    const raw = str(body.quarter);
    let y: number | null = null;
    let q: number | null = null;
    const combined = QUARTER_COMBINED.exec(raw);
    if (combined) {
      y = Number(combined[1]);
      q = Number(combined[2]);
    } else {
      const only = QUARTER_ONLY.exec(raw);
      const year = YEAR.exec(str(body.year));
      if (only && year) {
        y = Number(year[1]);
        q = Number(only[1]);
      }
    }
    if (y === null || q === null || !yearInRange(y)) return { ok: false, error: "invalid_quarter" };
    const first = periodKeyOf(y, (q - 1) * 3 + 1);
    return {
      ok: true,
      kind: "quarter",
      label: `${y}-Q${q}`,
      range: { from: periodRange(first).from, toExclusive: periodRange(addPeriods(first, 2)).toExclusive },
    };
  }

  if (type === "year") {
    const year = YEAR.exec(str(body.year));
    if (!year || !yearInRange(Number(year[1]))) return { ok: false, error: "invalid_year" };
    const y = Number(year[1]);
    return {
      ok: true,
      kind: "year",
      label: String(y),
      range: { from: periodRange(periodKeyOf(y, 1)).from, toExclusive: periodRange(periodKeyOf(y, 12)).toExclusive },
    };
  }

  return { ok: false, error: "invalid_type" };
}
