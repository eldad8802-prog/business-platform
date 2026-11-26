/**
 * Availability — free time slots, computed. PURE: no Prisma, no clock of its own, no environment.
 *
 * Working hours are wall-clock minutes of an Israeli calendar day (0 … 1440), because that is how a business states
 * them ("Sunday 09:00–17:00"). They become instants only here, through jerusalem-day.ts — the one place that knows
 * the Israeli offset — so a day the clocks change is 23 or 25 hours long, exactly as the business lives it, and a
 * 09:00 opening stays 09:00 on both sides of the change.
 *
 * The rule for one scope's day (windowsForDay):
 *   1. an OPEN_HOURS exception for the day replaces its weekly hours (a special opening, a short Friday);
 *   2. otherwise the weekly rules for that weekday that are valid on the day apply;
 *   3. CLOSED exceptions are then cut out (the whole day without minutes, or the stated part).
 * A lane's day (laneWindowsForDay, G21 2026-11-24): the business's special days bound the business — every lane;
 * a staff member's lane is their own hours (or the business's, when they have none of their own) intersected with
 * the business's special hours that day; a business closure closes every lane; a staff member's own exceptions
 * apply to that staff member only. On the public link the staff hours are also bounded by the business's WEEKLY
 * hours (owner decision 2026-10-28: there staff hours may only narrow the business's).
 * Midnight (G17): a day's window that ends at 24:00 and the next day's window that starts at 00:00 are ONE stretch
 * of time — slots and "inside the hours" are computed over the merged stretch, so a 20:00–02:00 night (stored as
 * two rules: Tue 20:00–24:00 + Wed 00:00–02:00) offers 23:00 for two hours.
 * Clock change (G25): on the autumn night the hour 01:00–02:00 happens twice; a slot whose wall-clock start repeats
 * the one an hour before it is skipped — every listed time is unambiguous (approved policy, documented).
 * A slot is [start, start + duration); it occupies [start − bufferBefore, end + bufferAfter), and must not meet any
 * busy interval (the occupied ranges of the lane's active appointments and the business-wide blocks). Slots start at
 * the window's opening and step by the service's slot step; none before now + minimum notice, none beyond the horizon.
 */
import {
  addCalendarDays,
  daysBetweenDayKeys,
  jerusalemClock,
  jerusalemDayKey,
  jerusalemInstantAt,
  type JerusalemDayKey,
} from "@/lib/utils/jerusalem-day";

export const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
export const MINUTES_PER_DAY = 1440;
/** The widest range one slot query may ask for. */
export const MAX_SLOT_RANGE_DAYS = 31;
/**
 * How long an appointment that has a start but no end (a row from before the calendar, or from a conversation)
 * occupies, when it states no length of its own (G22). Its own durationMinutes wins.
 */
export const UNTIMED_DEFAULT_MINUTES = 60;

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
/** One scope's hours: its weekly rules and its exceptions. */
export type ScopeHours = { rules: WeeklyRule[]; exceptions: DayException[] };

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

/** The minutes both window lists hold. */
export function intersectWindows(a: MinuteWindow[], b: MinuteWindow[]): MinuteWindow[] {
  const out: MinuteWindow[] = [];
  for (const x of mergeWindows(a)) {
    for (const y of mergeWindows(b)) {
      const startMinute = Math.max(x.startMinute, y.startMinute);
      const endMinute = Math.min(x.endMinute, y.endMinute);
      if (startMinute < endMinute) out.push({ startMinute, endMinute });
    }
  }
  return mergeWindows(out);
}

function ruleValidOn(rule: WeeklyRule, dayKey: JerusalemDayKey): boolean {
  if (rule.validFrom && dayKey < rule.validFrom) return false;
  if (rule.validUntil && dayKey > rule.validUntil) return false;
  return true;
}

const specialOf = (today: DayException[]) =>
  today.filter((e) => e.kind === "OPEN_HOURS" && e.startMinute !== null && e.endMinute !== null)
    .map((e) => ({ startMinute: e.startMinute as number, endMinute: e.endMinute as number }));
const weeklyOf = (rules: WeeklyRule[], dayKey: JerusalemDayKey) =>
  mergeWindows(rules.filter((r) => r.weekday === weekdayOf(dayKey) && ruleValidOn(r, dayKey)));

/** `windows` with every CLOSED exception of the day cut out; a whole-day closure leaves nothing. */
function cutClosures(windows: MinuteWindow[], today: DayException[]): MinuteWindow[] {
  let out = windows;
  for (const closed of today.filter((e) => e.kind === "CLOSED")) {
    if (closed.startMinute === null || closed.endMinute === null) return [];
    out = subtractWindow(out, { startMinute: closed.startMinute, endMinute: closed.endMinute });
  }
  return out;
}

/** The open windows of one scope's day, in wall-clock minutes. */
export function windowsForDay(dayKey: JerusalemDayKey, rules: WeeklyRule[], exceptions: DayException[]): MinuteWindow[] {
  const today = exceptions.filter((e) => e.dayKey === dayKey);
  const special = specialOf(today);
  return cutClosures(special.length > 0 ? mergeWindows(special) : weeklyOf(rules, dayKey), today);
}

/**
 * G21: the open windows of one LANE's day.
 *   - the business's lane (staff = null): the business's own day (windowsForDay);
 *   - a staff lane: the staff member's own special hours that day, else their own weekly hours, else (no hours of
 *     their own) the business's day hours (special, else weekly) — then bounded by the business's special hours when
 *     the business has any that day; then the business's closures and the staff member's own closures cut out.
 *   - `bound: "BUSINESS_HOURS"` (the public link): the staff lane is also bounded by the business's whole day
 *     (weekly or special, closures cut) — staff hours there only ever narrow the business's.
 * A staff member's exceptions never touch another lane; a business closure closes every lane.
 */
export function laneWindowsForDay(
  dayKey: JerusalemDayKey,
  business: ScopeHours,
  staff: ScopeHours | null,
  bound: "BUSINESS_SPECIAL" | "BUSINESS_HOURS" = "BUSINESS_SPECIAL",
): MinuteWindow[] {
  if (staff === null) return windowsForDay(dayKey, business.rules, business.exceptions);
  const bizToday = business.exceptions.filter((e) => e.dayKey === dayKey);
  const staffToday = staff.exceptions.filter((e) => e.dayKey === dayKey);
  const bizSpecial = specialOf(bizToday);
  const staffSpecial = specialOf(staffToday);
  let windows: MinuteWindow[];
  if (staffSpecial.length > 0) windows = mergeWindows(staffSpecial);
  else if (staff.rules.length > 0) windows = weeklyOf(staff.rules, dayKey);
  else windows = bizSpecial.length > 0 ? mergeWindows(bizSpecial) : weeklyOf(business.rules, dayKey);
  if (bizSpecial.length > 0) windows = intersectWindows(windows, bizSpecial);
  if (bound === "BUSINESS_HOURS") windows = intersectWindows(windows, windowsForDay(dayKey, business.rules, business.exceptions));
  return cutClosures(cutClosures(windows, bizToday), staffToday);
}

/** A wall-clock minute of a day as an instant; minute 1440 is the next day's midnight. */
export function instantOf(dayKey: JerusalemDayKey, minute: number): Date {
  if (minute >= MINUTES_PER_DAY) return jerusalemInstantAt(addCalendarDays(dayKey, 1), 0, 0);
  return jerusalemInstantAt(dayKey, Math.floor(minute / 60), minute % 60);
}

export function windowsAsIntervals(dayKey: JerusalemDayKey, windows: MinuteWindow[]): Interval[] {
  return windows.map((w) => ({ start: instantOf(dayKey, w.startMinute), end: instantOf(dayKey, w.endMinute) }));
}

/**
 * G17: the open stretches of time from the day before `fromDay` to the day after `toDay`, as instants, with a
 * window that ends at midnight and the next day's window that starts at midnight joined into one stretch.
 */
export function openStretches(fromDay: JerusalemDayKey, toDay: JerusalemDayKey, windowsOf: (day: JerusalemDayKey) => MinuteWindow[]): Interval[] {
  const out: Interval[] = [];
  const last = addCalendarDays(toDay, 1);
  for (let day = addCalendarDays(fromDay, -1); day <= last; day = addCalendarDays(day, 1)) {
    for (const iv of windowsAsIntervals(day, mergeWindows(windowsOf(day)))) {
      const prev = out[out.length - 1];
      if (prev && iv.start.getTime() <= prev.end.getTime()) {
        if (iv.end.getTime() > prev.end.getTime()) prev.end = iv.end;
      } else {
        out.push({ start: iv.start, end: iv.end });
      }
    }
  }
  return out;
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

/**
 * G22: the end an appointment occupies until — its own end, or (a row with a start but no end) its start plus its
 * own length, or plus UNTIMED_DEFAULT_MINUTES. Null without a start: it occupies nothing (it has no time).
 */
export function effectiveEnd(a: { startsAt: Date | null; endsAt: Date | null; durationMinutes: number | null }): Date | null {
  if (!a.startsAt) return null;
  if (a.endsAt) return a.endsAt;
  const minutes = a.durationMinutes && a.durationMinutes > 0 ? a.durationMinutes : UNTIMED_DEFAULT_MINUTES;
  return new Date(a.startsAt.getTime() + minutes * MINUTE);
}

/** Is [startsAt, endsAt) entirely inside one open stretch? (Pass openStretches(...) to see across midnight.) */
export function insideAvailability(startsAt: Date, endsAt: Date, intervals: Interval[]): boolean {
  return intervals.some((w) => w.start.getTime() <= startsAt.getTime() && endsAt.getTime() <= w.end.getTime());
}

/**
 * G25: true for the SECOND occurrence of a wall-clock time on the autumn clock-change night (the instant an hour
 * earlier reads the same Israeli day and clock) — the ambiguous duplicate that is never offered as a slot.
 */
export function isRepeatedWallClock(instant: Date): boolean {
  const before = new Date(instant.getTime() - 60 * MINUTE);
  if (jerusalemDayKey(before) !== jerusalemDayKey(instant)) return false;
  const a = jerusalemClock(before);
  const b = jerusalemClock(instant);
  return a.hours === b.hours && a.minutes === b.minutes;
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
  /** One scope's hours (used when `windowsOf` is not given). */
  rules: WeeklyRule[];
  exceptions: DayException[];
  /** A lane's open windows per day (laneWindowsForDay); wins over rules + exceptions. */
  windowsOf?: (day: JerusalemDayKey) => MinuteWindow[];
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
  const windowsOf = q.windowsOf ?? ((day: JerusalemDayKey) => windowsForDay(day, q.rules, q.exceptions));
  const out: Slot[] = [];
  for (const w of openStretches(q.fromDay, q.toDay, windowsOf)) {
    for (let t = w.start.getTime(); t + q.durationMinutes * MINUTE <= w.end.getTime(); t += q.slotStepMinutes * MINUTE) {
      if (t < earliest || t > latest) continue;
      const startsAt = new Date(t);
      const day = jerusalemDayKey(startsAt);
      if (day < q.fromDay || day > q.toDay) continue;
      if (isRepeatedWallClock(startsAt)) continue;
      const endsAt = new Date(t + q.durationMinutes * MINUTE);
      const occupied = occupiedRange(startsAt, endsAt, q.bufferBeforeMinutes, q.bufferAfterMinutes);
      if (q.busy.some((b) => overlaps(occupied, b))) continue;
      out.push({ startsAt, endsAt });
    }
  }
  return out;
}

// ── G20: what a change to the hours leaves outside them ─────────────────────────────────────────

export type PlacedAppointment = { id: number; staffMemberId: number | null; startsAt: Date; endsAt: Date };
export type HoursImpact = { count: number; days: Array<{ dayKey: JerusalemDayKey; count: number }>; firstIds: number[] };

/**
 * The live future appointments that do not sit entirely inside their lane's open time (the same lane rule the free
 * slots use, across midnight). Lanes without any hours known (`hasHours(lane)` false) are never "outside".
 * Information only — nothing is cancelled or moved.
 */
export function appointmentsOutside(
  appts: PlacedAppointment[],
  windowsOf: (staffMemberId: number | null, day: JerusalemDayKey) => MinuteWindow[],
  hasHours: (staffMemberId: number | null) => boolean,
): HoursImpact {
  const days = new Map<JerusalemDayKey, number>();
  const ids: number[] = [];
  for (const a of appts) {
    if (!hasHours(a.staffMemberId)) continue;
    const day = jerusalemDayKey(a.startsAt);
    const stretches = openStretches(day, jerusalemDayKey(new Date(a.endsAt.getTime() - 1)), (d) => windowsOf(a.staffMemberId, d));
    if (insideAvailability(a.startsAt, a.endsAt, stretches)) continue;
    days.set(day, (days.get(day) ?? 0) + 1);
    ids.push(a.id);
  }
  const sorted = [...days.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1));
  return { count: ids.length, days: sorted.slice(0, 10).map(([dayKey, count]) => ({ dayKey, count })), firstIds: ids.slice(0, 20) };
}
