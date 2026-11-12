/**
 * Notification time math — quiet hours and the daily digest moment, in the BUSINESS's time zone (notifications
 * track spec, 2026-11-12). PURE and Intl-based: no hand-written offsets, so a clock change (Asia/Jerusalem moves
 * on the Friday before the last Sunday of March and on the last Sunday of October) is the zone database's problem,
 * not ours. The business zone is BookingSettings.timeZone when present, else Asia/Jerusalem.
 */

export const DEFAULT_TIME_ZONE = "Asia/Jerusalem";

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** A zone Intl knows, else the default. Never throws. */
export function normalizeTimeZone(tz: unknown): string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function formatter(tz: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    FORMATTERS.set(tz, f);
  }
  return f;
}

export type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

export function localParts(instant: Date, tz: string): LocalParts {
  const parts = formatter(tz).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? NaN);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

/** Minutes since local midnight (0..1439). */
export function localMinuteOfDay(instant: Date, tz: string): number {
  const p = localParts(instant, tz);
  return p.hour * 60 + p.minute;
}

/** The local calendar day, YYYY-MM-DD. */
export function localDayKey(instant: Date, tz: string): string {
  const p = localParts(instant, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** The zone's offset from UTC at an instant, in minutes (Jerusalem: +120 winter, +180 summer). */
export function offsetMinutes(instant: Date, tz: string): number {
  const p = localParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/**
 * The instant at which the local wall clock in `tz` reads `minuteOfDay` on the local day `dayKey`.
 * A wall time that does not exist (the spring-forward gap) is moved forward by the length of the gap (02:30 on the
 * spring-forward night reads 03:30, as Temporal's "compatible" disambiguation); an ambiguous one (fall-back) resolves
 * to the EARLIER of the two.
 */
export function wallClockToInstant(dayKey: string, minuteOfDay: number, tz: string): Date {
  const [y, m, d] = dayKey.split("-").map(Number);
  const naive = Date.UTC(y, m - 1, d, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  // Try both offsets in effect around that moment; keep the candidates whose local reading is exactly right.
  const offsets = new Set<number>([
    offsetMinutes(new Date(naive - 36 * 3_600_000), tz),
    offsetMinutes(new Date(naive), tz),
    offsetMinutes(new Date(naive + 36 * 3_600_000), tz),
  ]);
  const exact: number[] = [];
  for (const off of offsets) {
    const t = naive - off * 60_000;
    const lp = localParts(new Date(t), tz);
    if (lp.year === y && lp.month === m && lp.day === d && lp.hour * 60 + lp.minute === minuteOfDay) exact.push(t);
  }
  if (exact.length > 0) return new Date(Math.min(...exact));
  // In the gap: the wall time was skipped. Read it with the offset in force BEFORE the jump (the smaller one), which
  // lands the same distance past the jump as the wall time was past the gap's start.
  const before = Math.min(...offsets);
  return new Date(naive - before * 60_000);
}

export function addDaysToKey(dayKey: string, days: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** Is a local minute inside the window [start, end)? A window may wrap midnight; start == end is no window. */
export function minuteInWindow(minute: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export type QuietHours = { enabled: boolean; startMinute: number; endMinute: number };

/**
 * Quiet hours at `now` for a business zone: null when not quiet, else the instant they end (the next local
 * `endMinute` that closes the CURRENT window — today's, or tomorrow's when the window wrapped past midnight).
 */
export function quietUntil(now: Date, tz: string, q: QuietHours): Date | null {
  if (!q.enabled) return null;
  const minute = localMinuteOfDay(now, tz);
  if (!minuteInWindow(minute, q.startMinute, q.endMinute)) return null;
  const today = localDayKey(now, tz);
  const endsTomorrow = q.startMinute > q.endMinute && minute >= q.startMinute;
  const end = wallClockToInstant(endsTomorrow ? addDaysToKey(today, 1) : today, q.endMinute, tz);
  // A clock change inside the window can never put the end before now; guard anyway (no busy loop on a bad zone).
  return end.getTime() > now.getTime() ? end : new Date(now.getTime() + 60_000);
}

/**
 * The daily digest for one user: due once the local clock has reached `digestMinute` on the local day; the day key
 * is the one the digest's dedupe key carries (`digest:u<userId>:<YYYY-MM-DD>`).
 */
export function digestMoment(now: Date, tz: string, digestMinute: number): { due: boolean; dayKey: string } {
  return { due: localMinuteOfDay(now, tz) >= digestMinute, dayKey: localDayKey(now, tz) };
}
