/**
 * The calendar's pure rules (Appointments milestone B) — shared by every calendar screen, the Secretary's calendar
 * and the tests. No React, no fetch, no clock of its own: every function takes the instant or the day it reasons
 * about.
 *
 * Time is the server's: instants are UTC, the day and the wall clock are Israel's, read through
 * lib/utils/jerusalem-day (the module the API itself uses), so a DST change day draws exactly what the server
 * stored. The week starts on Sunday, as in the Secretary's calendar.
 *
 * Field limits are the API's own (appointment-schedule.service, appointment-config.service): a form refuses what
 * the server would refuse, in Hebrew, before anything is sent.
 */
import type {
  AppointmentCancelReason,
  AppointmentEventType,
  AppointmentKind,
  AppointmentLocationKind,
  AppointmentStatus,
} from "@prisma/client";

import {
  addCalendarDays,
  daysBetweenDayKeys,
  jerusalemClock,
  jerusalemDayKey,
  jerusalemInstantAt,
  type JerusalemDayKey,
} from "@/lib/utils/jerusalem-day";

export type DayKey = JerusalemDayKey;

// ── The wire shapes (what /api/appointments answers) ────────────────────────────────────────────

export type AppointmentWire = {
  id: number;
  status: AppointmentStatus;
  kind: AppointmentKind;
  startsAt: string | null;
  endsAt: string | null;
  durationMinutes: number | null;
  staffMemberId: number | null;
  businessServiceId: number | null;
  customerId: number | null;
  leadId: number | null;
  title: string | null;
  notes: string | null;
  locationKind: AppointmentLocationKind | null;
  locationDetail: string | null;
  cancelReason: AppointmentCancelReason | null;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  version: number;
};

export type HistoryWire = { type: AppointmentEventType; actor: string; at: string; payload: Record<string, unknown> };

export type StaffWire = {
  id: number;
  displayName: string;
  color: string | null;
  active: boolean;
  sortOrder: number;
  version: number;
  services: Array<{ businessServiceId: number; durationOverrideMinutes: number | null }>;
};

// ── Limits (the API's) ──────────────────────────────────────────────────────────────────────────

export const LIMITS = {
  title: 200,
  notes: 4000,
  locationDetail: 300,
  cancelReason: 500,
  staffName: 80,
  exceptionLabel: 80,
  minDuration: 5,
  maxDuration: 1440,
  rangeDays: 62,
} as const;

/** The first problem with a text field, in Hebrew, or null. */
export function textProblem(label: string, value: string, max: number): string | null {
  return value.length > max ? `${label} ארוך מדי: עד ${max.toLocaleString("he-IL")} תווים (כרגע ${value.length.toLocaleString("he-IL")}).` : null;
}

// ── Words ───────────────────────────────────────────────────────────────────────────────────────

export const STATUS_LABEL: Record<AppointmentStatus, string> = {
  PROPOSED: "ממתין לאישור",
  CONFIRMED: "מאושר",
  COMPLETED: "הושלם",
  NO_SHOW: "לא הגיע",
  CANCELED: "בוטל",
};

export const KIND_LABEL: Record<AppointmentKind, string> = {
  CUSTOMER: "תור ללקוח",
  INTERNAL: "פגישה פנימית",
  BLOCK: "חסימת זמן",
};

export const LOCATION_LABEL: Record<AppointmentLocationKind, string> = {
  IN_PERSON: "בעסק",
  PHONE: "בטלפון",
  ONLINE: "אונליין",
};

export const CANCEL_REASON_LABEL: Record<AppointmentCancelReason, string> = {
  OWNER_CANCELED: "ביטלתי אני",
  CUSTOMER_CANCELED: "הלקוח ביטל",
  DECLINED: "הבקשה נדחתה",
  EXPIRED: "הבקשה פקעה",
  OTHER: "סיבה אחרת",
};

/** The reasons an owner may choose (the API refuses the others). */
export const OWNER_CANCEL_REASONS: AppointmentCancelReason[] = ["OWNER_CANCELED", "CUSTOMER_CANCELED", "OTHER"];

export const EVENT_LABEL: Record<AppointmentEventType, string> = {
  APPOINTMENT_CREATED: "נקבע",
  APPOINTMENT_CONFIRMED: "אושר",
  APPOINTMENT_COMPLETED: "סומן כהושלם",
  APPOINTMENT_NO_SHOW: "סומן כלא הגיע",
  APPOINTMENT_CANCELED: "בוטל",
  APPOINTMENT_RESCHEDULED: "הוזז",
  APPOINTMENT_DETAILS_CHANGED: "הפרטים עודכנו",
};

export const ACTOR_LABEL: Record<string, string> = { OWNER_USER: "אתה", CUSTOMER: "הלקוח", SYSTEM: "המערכת" };

/** An API refusal in the owner's words. `details` is the API's own detail object, never shown raw. */
export function errorText(code: string, status?: number): string {
  switch (code) {
    case "SLOT_CONFLICT": return "השעה הזו כבר תפוסה ביומן.";
    case "VERSION_CONFLICT": return "התור השתנה בינתיים. טענתי את הגרסה העדכנית — אפשר לנסות שוב.";
    case "INVALID_TRANSITION": return "אי אפשר לבצע את הפעולה הזו במצב הנוכחי של התור.";
    case "STAFF_NOT_ASSIGNED": return "העובד הזה לא משויך לשירות שנבחר.";
    case "STAFF_NOT_FOUND": return "העובד לא נמצא או שאינו פעיל.";
    case "SERVICE_NOT_FOUND": return "השירות לא נמצא או שאינו פעיל.";
    case "CUSTOMER_NOT_FOUND": return "הלקוח לא נמצא.";
    case "LEAD_NOT_FOUND": return "הליד לא נמצא.";
    case "NOT_FOUND": return status === 404 ? "לא נמצא. ייתכן שהיומן אינו פעיל לעסק." : "לא נמצא.";
    case "INVALID_INPUT": return "חלק מהפרטים לא תקינים. כדאי לבדוק את השדות ולנסות שוב.";
    case "IDEMPOTENCY_KEY_STALE":
    case "IDEMPOTENCY_KEY_REUSED":
    case "IDEMPOTENCY_KEY_INVALID": return "הבקשה נשלחה כבר בגרסה אחרת. אפשר לנסות שוב.";
    case "FORBIDDEN": return "אין הרשאה לפעולה הזו.";
    case "Unauthorized": return "צריך להתחבר מחדש.";
    case "NETWORK": return "אין חיבור כרגע. אפשר לנסות שוב בעוד רגע.";
    default: return "משהו השתבש. אפשר לנסות שוב בעוד רגע.";
  }
}

/** Which field an INVALID_INPUT names, in Hebrew. */
export const FIELD_LABEL: Record<string, string> = {
  startsAt: "שעת ההתחלה",
  endsAt: "שעת הסיום",
  durationMinutes: "משך",
  staffMemberId: "עובד",
  businessServiceId: "שירות",
  customerId: "לקוח",
  title: "כותרת",
  notes: "הערות",
  locationDetail: "פרטי המיקום",
  reason: "הסבר",
  displayName: "שם",
  color: "צבע",
  window: "טווח השעות",
  dayKey: "התאריך",
  label: "תיאור",
};

// ── Days, ranges and clocks ─────────────────────────────────────────────────────────────────────

export type CalendarView = "day" | "week" | "month";
export const VIEW_LABEL: Record<CalendarView, string> = { day: "יום", week: "שבוע", month: "חודש" };

export function weekdayOfDay(day: DayKey): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The Sunday that starts the week holding `day`. */
export function weekStart(day: DayKey): DayKey {
  return addCalendarDays(day, -weekdayOfDay(day));
}

export function monthOf(day: DayKey): { year: number; month: number } {
  const [y, m] = day.split("-").map(Number);
  return { year: y, month: m };
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

export function firstOfMonth(year: number, month1: number): DayKey {
  return `${year}-${String(month1).padStart(2, "0")}-01`;
}

/** The days a view shows, first to last inclusive. */
export function viewDays(view: CalendarView, anchor: DayKey): DayKey[] {
  if (view === "day") return [anchor];
  if (view === "week") {
    const first = weekStart(anchor);
    return Array.from({ length: 7 }, (_, i) => addCalendarDays(first, i));
  }
  const { year, month } = monthOf(anchor);
  const first = firstOfMonth(year, month);
  return Array.from({ length: daysInMonth(year, month) }, (_, i) => addCalendarDays(first, i));
}

/** The instant range one read asks for: [start of the first day, start of the day after the last) — ≤ 62 days. */
export function viewRange(view: CalendarView, anchor: DayKey): { from: Date; to: Date; days: DayKey[] } {
  const days = viewDays(view, anchor);
  return { from: startOfDay(days[0]), to: startOfDay(addCalendarDays(days[days.length - 1], 1)), days };
}

export function startOfDay(day: DayKey): Date {
  return jerusalemInstantAt(day, 0, 0);
}

/** The anchor one step earlier / later (a day, a week, a month). A month step lands on the 1st. */
export function shiftAnchor(view: CalendarView, anchor: DayKey, delta: number): DayKey {
  if (view === "day") return addCalendarDays(anchor, delta);
  if (view === "week") return addCalendarDays(anchor, 7 * delta);
  const { year, month } = monthOf(anchor);
  const idx = year * 12 + (month - 1) + delta;
  return firstOfMonth(Math.floor(idx / 12), (idx % 12) + 1);
}

/**
 * The WALL-CLOCK minute of `instant` on the grid of `day`: 14:30 is 870 on every day, also on the 23- and 25-hour
 * days the clocks change (elapsed minutes would draw it an hour off). Negative on an earlier day, ≥ 1440 on a later.
 */
export function minuteInDay(instant: Date, day: DayKey): number {
  const { hours, minutes } = jerusalemClock(instant);
  return daysBetweenDayKeys(day, jerusalemDayKey(instant)) * 1440 + hours * 60 + minutes;
}

export function clock(minute: number): string {
  const m = ((minute % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** "09:30" as read in Israel. */
export function clockOf(instant: Date): string {
  const { hours, minutes } = jerusalemClock(instant);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** "HH:MM" → minutes, or null. */
export function parseClock(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

const DAY_TITLE = new Intl.DateTimeFormat("he-IL", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const DAY_SHORT = new Intl.DateTimeFormat("he-IL", { weekday: "short", day: "numeric", timeZone: "UTC" });
const MONTH_TITLE = new Intl.DateTimeFormat("he-IL", { month: "long", year: "numeric", timeZone: "UTC" });
const DAY_MONTH = new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "long", timeZone: "UTC" });

const asUtcNoon = (day: DayKey) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
};

export const dayTitle = (day: DayKey) => DAY_TITLE.format(asUtcNoon(day));
export const dayShort = (day: DayKey) => DAY_SHORT.format(asUtcNoon(day));
export const dayMonth = (day: DayKey) => DAY_MONTH.format(asUtcNoon(day));
export const dayNumber = (day: DayKey) => Number(day.slice(8, 10));
export const WEEKDAY_LETTER = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];

/** The header line of a view: the day, the week's span, or the month. */
export function viewTitle(view: CalendarView, anchor: DayKey): string {
  if (view === "day") return dayTitle(anchor);
  if (view === "month") {
    const { year, month } = monthOf(anchor);
    return MONTH_TITLE.format(new Date(Date.UTC(year, month - 1, 15)));
  }
  const first = weekStart(anchor);
  const last = addCalendarDays(first, 6);
  return `${dayMonth(first)} – ${dayMonth(last)}`;
}

export function todayKey(now: Date): DayKey {
  return jerusalemDayKey(now);
}

// ── Appointments on days ────────────────────────────────────────────────────────────────────────

export const isTimed = (a: AppointmentWire) => a.startsAt !== null && a.endsAt !== null;
export const isTerminal = (s: AppointmentStatus) => s === "COMPLETED" || s === "NO_SHOW" || s === "CANCELED";
export const isActive = (s: AppointmentStatus) => s === "PROPOSED" || s === "CONFIRMED";

/** The day an appointment belongs to (its start, in Israel), or null when it has no time yet. */
export function dayOf(a: AppointmentWire): DayKey | null {
  return a.startsAt ? jerusalemDayKey(new Date(a.startsAt)) : null;
}

export function byDay(list: AppointmentWire[]): Map<DayKey, AppointmentWire[]> {
  const map = new Map<DayKey, AppointmentWire[]>();
  for (const a of list) {
    const d = dayOf(a);
    if (!d) continue;
    const arr = map.get(d);
    if (arr) arr.push(a);
    else map.set(d, [a]);
  }
  for (const arr of map.values()) arr.sort((x, y) => (x.startsAt! < y.startsAt! ? -1 : x.startsAt! > y.startsAt! ? 1 : x.id - y.id));
  return map;
}

export type Placed = { appt: AppointmentWire; start: number; end: number; col: number; cols: number };

/**
 * The timed appointments of one day in one column, as blocks: minutes from midnight (clipped to the day) and side by
 * side when they overlap (a cancelled one beside its replacement, two staff lanes shown together). Greedy packing
 * per overlap group, so a group never widens the blocks of another.
 */
export function layoutDay(list: AppointmentWire[], day: DayKey): Placed[] {
  const items = list
    .filter(isTimed)
    .map((appt) => ({
      appt,
      start: Math.max(0, minuteInDay(new Date(appt.startsAt!), day)),
      end: Math.min(1440, minuteInDay(new Date(appt.endsAt!), day)),
    }))
    .filter((x) => x.end > x.start)
    .sort((a, b) => a.start - b.start || b.end - a.end || a.appt.id - b.appt.id);
  const out: Placed[] = [];
  let group: Array<{ appt: AppointmentWire; start: number; end: number; col: number }> = [];
  let groupEnd = -1;
  const flush = () => {
    const cols = group.reduce((m, g) => Math.max(m, g.col + 1), 0);
    for (const g of group) out.push({ ...g, cols });
    group = [];
  };
  for (const it of items) {
    if (group.length && it.start >= groupEnd) flush();
    const used = new Set(group.filter((g) => g.end > it.start).map((g) => g.col));
    let col = 0;
    while (used.has(col)) col++;
    group.push({ ...it, col });
    groupEnd = Math.max(groupEnd, it.end);
  }
  if (group.length) flush();
  return out;
}

/** The hours a time grid draws: 07:00–21:00, widened to hold every appointment and every working window shown. */
export function gridHours(placed: Placed[], windows: Array<{ startMinute: number; endMinute: number }> = []): { first: number; last: number } {
  let first = 7;
  let last = 21;
  for (const p of placed) {
    first = Math.min(first, Math.floor(p.start / 60));
    last = Math.max(last, Math.ceil(p.end / 60));
  }
  for (const w of windows) {
    first = Math.min(first, Math.floor(w.startMinute / 60));
    last = Math.max(last, Math.ceil(w.endMinute / 60));
  }
  return { first: Math.max(0, first), last: Math.min(24, Math.max(last, first + 1)) };
}

/** A minute snapped to the grid step (15 minutes by default), inside the day. */
export function snap(minute: number, step = 15): number {
  return Math.min(1440 - step, Math.max(0, Math.round(minute / step) * step));
}

/** The instant of `minute` after the Israeli midnight of `day`. */
export function instantAt(day: DayKey, minute: number): Date {
  return jerusalemInstantAt(day, Math.floor(minute / 60), minute % 60);
}

export function durationOf(a: AppointmentWire): number | null {
  if (a.durationMinutes) return a.durationMinutes;
  if (a.startsAt && a.endsAt) return Math.round((Date.parse(a.endsAt) - Date.parse(a.startsAt)) / 60_000);
  return null;
}

export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} דק׳`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hours = h === 1 ? "שעה" : h === 2 ? "שעתיים" : `${h} שעות`;
  return m ? `${hours} ו־${m} דק׳` : hours;
}

/** "09:00–09:45" for a timed appointment, "09:00" for an untimed one with a start, "ללא שעה" otherwise. */
export function timeLabel(a: AppointmentWire): string {
  if (!a.startsAt) return "ללא שעה";
  const start = clockOf(new Date(a.startsAt));
  return a.endsAt ? `${start}–${clockOf(new Date(a.endsAt))}` : start;
}

// ── What the owner may do ───────────────────────────────────────────────────────────────────────

export type Action = "confirm" | "complete" | "no_show" | "cancel" | "move" | "edit";

/** The lifecycle's allowed moves (appointment.lifecycle) as buttons; a block only moves, edits and cancels. */
export function actionsFor(a: AppointmentWire): Action[] {
  if (isTerminal(a.status)) return [];
  const out: Action[] = [];
  if (a.kind !== "BLOCK") {
    if (a.status === "PROPOSED") out.push("confirm");
    if (a.status === "CONFIRMED") out.push("complete", "no_show");
  }
  if (isTimed(a)) out.push("move");
  out.push("edit", "cancel");
  return out;
}

/** The status change each status action asks the API for. */
export const STATUS_TO: Record<Exclude<Action, "move" | "edit">, "CONFIRMED" | "COMPLETED" | "NO_SHOW" | "CANCELED"> = {
  confirm: "CONFIRMED",
  complete: "COMPLETED",
  no_show: "NO_SHOW",
  cancel: "CANCELED",
};

// ── Names ───────────────────────────────────────────────────────────────────────────────────────

export type Names = {
  customers: Map<number, string>;
  services: Map<number, string>;
  staff: Map<number, StaffWire>;
};

/** The line an appointment shows: the customer and the service, or the title of a meeting / block. */
export function headline(a: AppointmentWire, names: Names): string {
  const customer = a.customerId !== null ? names.customers.get(a.customerId) : undefined;
  const service = a.businessServiceId !== null ? names.services.get(a.businessServiceId) : undefined;
  if (a.kind === "CUSTOMER") {
    const what = a.title?.trim() || service || "תור";
    return customer ? `${customer} · ${what}` : what;
  }
  return a.title?.trim() || KIND_LABEL[a.kind];
}

/** A staff colour, or the brand's when none was chosen. */
export function staffColor(staffMemberId: number | null, names: Names): string {
  if (staffMemberId === null) return "var(--dz-brand)";
  return names.staff.get(staffMemberId)?.color ?? "var(--dz-brand)";
}

// ── Weekly hours ────────────────────────────────────────────────────────────────────────────────

export type WeekWindow = { weekday: number; startMinute: number; endMinute: number };

/** The windows of each weekday (0 = Sunday), sorted. */
export function windowsByWeekday(rules: WeekWindow[]): WeekWindow[][] {
  const out: WeekWindow[][] = Array.from({ length: 7 }, () => []);
  for (const r of rules) if (r.weekday >= 0 && r.weekday <= 6) out[r.weekday].push(r);
  for (const d of out) d.sort((a, b) => a.startMinute - b.startMinute);
  return out;
}

/** A window list's first problem in Hebrew (start before end, inside the day, no overlap), or null. */
export function windowsProblem(windows: Array<{ startMinute: number; endMinute: number }>): string | null {
  const sorted = [...windows].sort((a, b) => a.startMinute - b.startMinute);
  for (let i = 0; i < sorted.length; i++) {
    const w = sorted[i];
    if (!(w.startMinute >= 0 && w.endMinute <= 1440 && w.endMinute > w.startMinute)) return "שעת הסיום צריכה להיות אחרי שעת ההתחלה.";
    if (i > 0 && w.startMinute < sorted[i - 1].endMinute) return "שני טווחים באותו יום חופפים.";
  }
  return null;
}
