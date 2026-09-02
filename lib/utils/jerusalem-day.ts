/**
 * The calendar day, as the business experiences it.
 *
 * WHY THIS EXISTS: Dubiz runs on Israel time, and several domains need to answer
 * "which day is this?" and "how many days apart are these?". Answering that with
 * millisecond arithmetic is wrong twice a year. Israel moves its clocks in late
 * March and late October, so a 30-day span expressed as `30 * 86_400_000` lands
 * an hour off the wall-clock time it started from — an invoice issued at 09:00
 * came due at 10:00.
 *
 * The fix is to stop doing arithmetic on instants at all. Two instants are the
 * same day exactly when their `YYYY-MM-DD` key in Asia/Jerusalem matches, and
 * the distance between two days is the distance between their keys. DST cannot
 * perturb either, because neither ever measures elapsed time.
 *
 * Pure and dependency-free: no Prisma, no environment, no clock of its own. The
 * caller always supplies the instant, so every rule built on this is testable.
 */

export const ISRAEL_TIME_ZONE = "Asia/Jerusalem";

/**
 * `en-CA` because it formats as `YYYY-MM-DD`, which sorts and compares
 * lexicographically in calendar order. That property is what lets the rules
 * below be plain string comparisons.
 */
const DAY_KEY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: ISRAEL_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** A `YYYY-MM-DD` calendar date in Israel. Not an instant. */
export type JerusalemDayKey = string;

/** Which Israeli calendar day an instant falls on. */
export function jerusalemDayKey(instant: Date): JerusalemDayKey {
  return DAY_KEY_FORMATTER.format(instant);
}

/**
 * Interpret a day key as a position on the calendar.
 *
 * `Date.UTC` is used purely as an integer encoding of (year, month, day) — the
 * result is never treated as a real moment and never shown to anyone. Because
 * both operands are encoded the same way, the difference between them is an
 * exact whole number of calendar days with no timezone involved at all.
 */
function dayKeyOrdinal(key: JerusalemDayKey): number {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

const MS_PER_CALENDAR_DAY = 86_400_000;

/** Whole calendar days from `from` to `to`. Negative when `to` is earlier. */
export function daysBetweenDayKeys(
  from: JerusalemDayKey,
  to: JerusalemDayKey
): number {
  return Math.round(
    (dayKeyOrdinal(to) - dayKeyOrdinal(from)) / MS_PER_CALENDAR_DAY
  );
}

/**
 * The day key `days` calendar days after `key`.
 *
 * Uses UTC date arithmetic on the encoded ordinal, so month lengths and leap
 * years are handled by the calendar itself rather than by a table — and because
 * no real instant is involved, a DST transition inside the span cannot shift the
 * result.
 */
export function addCalendarDays(
  key: JerusalemDayKey,
  days: number
): JerusalemDayKey {
  const base = new Date(dayKeyOrdinal(key));
  base.setUTCDate(base.getUTCDate() + days);
  const y = base.getUTCFullYear();
  const m = String(base.getUTCMonth() + 1).padStart(2, "0");
  const d = String(base.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * A stable instant that always falls on `key` when read in Israel.
 *
 * Some read models must carry a calendar day through an API and a database
 * column that only speak `Date`. Midnight is the wrong choice for that: midnight
 * UTC is the previous evening in Israel, and midnight Israel time is itself a
 * DST-sensitive instant. Noon UTC is 14:00 or 15:00 in Israel — comfortably
 * inside the same calendar day under either offset, and on the day the clocks
 * change too. So `jerusalemDayKey(dayKeyToStableInstant(k)) === k`, always.
 *
 * The time component carries no meaning and must never be displayed.
 */
export function dayKeyToStableInstant(key: JerusalemDayKey): Date {
  return new Date(dayKeyOrdinal(key) + 12 * 60 * 60 * 1000);
}

/** Is `a` strictly before `b` on the calendar? */
export function dayKeyIsBefore(
  a: JerusalemDayKey,
  b: JerusalemDayKey
): boolean {
  // Fixed-width `YYYY-MM-DD` sorts in calendar order, so this is exact.
  return a < b;
}
