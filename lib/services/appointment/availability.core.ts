/**
 * Availability — free time slots, computed. PURE: no Prisma, no clock of its own, no environment.
 *
 * Working hours are wall-clock minutes of an Israeli calendar day (0 … 1440), because that is how a business states
 * them ("Sunday 09:00–17:00"). They become instants only here, through jerusalem-day.ts — the one place that knows
 * the Israeli offset — so a day the clocks change is 23 or 25 hours long, exactly as the business lives it, and a
 * 09:00 opening stays 09:00 on both sides of the change.
 *
 * The rule for a day:
 *   1. an OPEN_HOURS exception for the day replaces its weekly hours (a special opening, a short Friday);
 *   2. otherwise the weekly rules for that weekday that are valid on the day apply;
 *   3. CLOSED exceptions are then cut out (the whole day without minutes, or the stated part).
 * A slot is [start, start + duration); it occupies [start − bufferBefore, end + bufferAfter), and must not meet any
 * busy interval (the occupied ranges of the lane's active appointments and the business-wide blocks). Slots start at
 * the window's opening and step by the service's slot step; none before now + minimum notice, none beyond the horizon.
 */
import {
  addCalendarDays,
  daysBetweenDayKeys,
  jerusalemInstantAt,
  type JerusalemDayKey,
} from "@/lib/utils/jerusalem-day";

export const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
export const MINUTES_PER_DAY = 1440;
/** The widest range one slot query may ask for. */
export const MAX_SLOT_RANGE_DAYS = 31;

export type MinuteWindow = { startMinute: number; endMinute: number };
export type WeeklyRule = MinuteWindow & {
  weekday: number;
  validFrom?: JerusalemDayKey | null;
  validUntil?: JerusalemDayKey | null;
};
export type DayException = {
  dayKey: JerusalemDayKey;
  kind: "CLOSED" | "OPEN_HOURS";
  startMinute: number | null;
  endMinute: number | null;
};
export type Interval = { start: Date; end: Date };

export function isDayKey(value: unknown): value is JerusalemDayKey {
  if (typeof value !== "string" || !DAY_KEY.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** 0 = Sunday … 6 = Saturday — the calendar's weekday, independent of any offset. */
export function weekdayOf(dayKey: JerusalemDayKey): number {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isValidWindow(w: MinuteWindow): boolean {
  return Number.isInteger(w.startMinute) && Number.isInteger(w.endMinute)
    && w.startMinute >= 0 && w.endMinute <= MINUTES_PER_DAY && w.startMinute < w.endMinute;
}

/** Sorted, with touching or overlapping windows merged. */
export function mergeWindows(windows: MinuteWindow[]): MinuteWindow[] {
  const sorted = windows.filter(isValidWindow).map((w) => ({ ...w })).sort((a, b) => a.startMinute - b.startMinute);
  const out: MinuteWindow[] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w.startMinute <= last.endMinute) last.endMinute = Math.max(last.endMinute, w.endMinute);
    else out.push({ startMinute: w.startMinute, endMinute: w.endMinute });
  }
  return out;
}

/** `windows` with `cut` removed. */
export function subtractWindow(windows: MinuteWindow[], cut: MinuteWindow): MinuteWindow[] {
  const out: MinuteWindow[] = [];
  for (const w of windows) {
    if (cut.endMinute <= w.startMinute || cut.startMinute >= w.endMinute) { out.push(w); continue; }
    if (cut.startMinute > w.startMinute) out.push({ startMinute: w.startMinute, endMinute: cut.startMinute });
    if (cut.endMinute < w.endMinute) out.push({ startMinute: cut.endMinute, endMinute: w.endMinute });
  }
  return out;
}

function ruleValidOn(rule: WeeklyRule, dayKey: JerusalemDayKey): boolean {
  if (rule.validFrom && dayKey < rule.validFrom) return false;
  if (rule.validUntil && dayKey > rule.validUntil) return false;
  return true;
}

/** The open windows of one day, in wall-clock minutes. */
export function windowsForDay(dayKey: JerusalemDayKey, rules: WeeklyRule[], exceptions: DayException[]): MinuteWindow[] {
  const today = exceptions.filter((e) => e.dayKey === dayKey);
  const special = today.filter((e) => e.kind === "OPEN_HOURS" && e.startMinute !== null && e.endMinute !== null);
  let windows = special.length > 0
    ? mergeWindows(special.map((e) => ({ startMinute: e.startMinute as number, endMinute: e.endMinute as number })))
    : mergeWindows(rules.filter((r) => r.weekday === weekdayOf(dayKey) && ruleValidOn(r, dayKey)));
  for (const closed of today.filter((e) => e.kind === "CLOSED")) {
    if (closed.startMinute === null || closed.endMinute === null) return [];
    windows = subtractWindow(windows, { startMinute: closed.startMinute, endMinute: closed.endMinute });
  }
  return windows;
}

/** A wall-clock minute of a day as an instant; minute 1440 is the next day's midnight. */
export function instantOf(dayKey: JerusalemDayKey, minute: number): Date {
  if (minute >= MINUTES_PER_DAY) return jerusalemInstantAt(addCalendarDays(dayKey, 1), 0, 0);
  return jerusalemInstantAt(dayKey, Math.floor(minute / 60), minute % 60);
}

export function windowsAsIntervals(dayKey: JerusalemDayKey, windows: MinuteWindow[]): Interval[] {
  return windows.map((w) => ({ start: instantOf(dayKey, w.startMinute), end: instantOf(dayKey, w.endMinute) }));
}

/** Half-open intervals meet when each starts before the other ends. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

const MINUTE = 60_000;

/** The time an appointment takes out of its lane: its own span widened by its buffers. */
export function occupiedRange(startsAt: Date, endsAt: Date, bufferBeforeMinutes: number, bufferAfterMinutes: number): Interval {
  return {
    start: new Date(startsAt.getTime() - bufferBeforeMinutes * MINUTE),
    end: new Date(endsAt.getTime() + bufferAfterMinutes * MINUTE),
  };
}

/** Is [startsAt, endsAt) entirely inside one open window of its day? */
export function insideAvailability(startsAt: Date, endsAt: Date, intervals: Interval[]): boolean {
  return intervals.some((w) => w.start.getTime() <= startsAt.getTime() && endsAt.getTime() <= w.end.getTime());
}

export type SlotQuery = {
  fromDay: JerusalemDayKey;
  /** Inclusive. */
  toDay: JerusalemDayKey;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  slotStepMinutes: number;
  minLeadMinutes: number;
  maxAdvanceDays: number;
  now: Date;
  rules: WeeklyRule[];
  exceptions: DayException[];
  /** Occupied ranges already taken in this lane (buffers included). */
  busy: Interval[];
};

export type Slot = { startsAt: Date; endsAt: Date };

export function computeSlots(q: SlotQuery): Slot[] {
  if (!isDayKey(q.fromDay) || !isDayKey(q.toDay)) return [];
  const span = daysBetweenDayKeys(q.fromDay, q.toDay);
  if (span < 0 || span >= MAX_SLOT_RANGE_DAYS) return [];
  if (!(q.durationMinutes > 0) || !(q.slotStepMinutes > 0)) return [];
  const earliest = q.now.getTime() + q.minLeadMinutes * MINUTE;
  const latest = q.now.getTime() + q.maxAdvanceDays * 24 * 60 * MINUTE;
  const out: Slot[] = [];
  for (let i = 0; i <= span; i++) {
    const day = addCalendarDays(q.fromDay, i);
    for (const w of windowsAsIntervals(day, windowsForDay(day, q.rules, q.exceptions))) {
      for (let t = w.start.getTime(); t + q.durationMinutes * MINUTE <= w.end.getTime(); t += q.slotStepMinutes * MINUTE) {
        if (t < earliest || t > latest) continue;
        const startsAt = new Date(t);
        const endsAt = new Date(t + q.durationMinutes * MINUTE);
        const occupied = occupiedRange(startsAt, endsAt, q.bufferBeforeMinutes, q.bufferAfterMinutes);
        if (q.busy.some((b) => overlaps(occupied, b))) continue;
        out.push({ startsAt, endsAt });
      }
    }
  }
  return out;
}
