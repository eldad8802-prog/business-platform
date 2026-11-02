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
import { windowsForDay } from "@/lib/services/appointment/availability.core";

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
  /** The customer's name, from the same read (null without a customer; absent on a write's echo). */
  customerName?: string | null;
  /** Where it came from (PUBLIC_BOOKING = the business's booking link). */
  sourceChannel?: string;
  /** Booked through the public link (Milestone C): the request's state and who asked — the owner's eyes only. */
  booking?: BookingWire | null;
};

export type BookingWire = { requestId: number; status: string; contactName: string; contactPhone: string | null; note: string | null; expiresAt: string };

export type HistoryWire = { type: AppointmentEventType; actor: string; at: string; payload: Record<string, unknown> };

export type StaffWire = {
  id: number;
  displayName: string;
  color: string | null;
  active: boolean;
  sortOrder: number;
  version: number;
  /** Offered on the public booking link (Milestone C, D7). */
  publicBookable?: boolean;
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
  COMPLETED: "התקיים",
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
  EXPIRED: "הבקשה פגה",
  OTHER: "סיבה אחרת",
};

/** The reasons an owner may choose (the API refuses the others). */
export const OWNER_CANCEL_REASONS: AppointmentCancelReason[] = ["OWNER_CANCELED", "CUSTOMER_CANCELED", "OTHER"];

export const EVENT_LABEL: Record<AppointmentEventType, string> = {
  APPOINTMENT_CREATED: "נקבע",
  APPOINTMENT_CONFIRMED: "אושר",
  APPOINTMENT_COMPLETED: "סומן שהתקיים",
  APPOINTMENT_NO_SHOW: "סומן כלא הגיע",
  APPOINTMENT_CANCELED: "בוטל",
  APPOINTMENT_RESCHEDULED: "הוזז",
  APPOINTMENT_DETAILS_CHANGED: "הפרטים עודכנו",
};

export const ACTOR_LABEL: Record<string, string> = { OWNER_USER: "אתה", CUSTOMER: "הלקוח", SYSTEM: "המערכת" };

/** A time block refused over existing appointments (owner decision P0-1: never laid over them, no "anyway"). */
export const BLOCK_CONFLICT_TEXT = "אי אפשר לחסום את הזמן הזה: יש בו תורים קיימים. צריך להזיז או לבטל אותם קודם, ואז לחסום.";

/** An API refusal in the owner's words. `details` is the API's own detail object, never shown raw. */
export function errorText(code: string, status?: number): string {
  switch (code) {
    case "SLOT_CONFLICT": return "השעה הזו כבר תפוסה ביומן.";
    case "VERSION_CONFLICT": return "התור השתנה בינתיים. טענתי את הגרסה העדכנית — אפשר לנסות שוב.";
    case "INVALID_TRANSITION": return "אי אפשר לבצע את הפעולה הזו במצב הנוכחי של התור.";
    case "NOT_STARTED": return "אפשר לסמן „התקיים” או „לא הגיע” רק אחרי שעת התחלת התור.";
    case "NO_CUSTOMER": return "„לא הגיע” מתאים רק לתור של לקוח.";
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
    case "BOOKING_CLOSED": return "ההזמנות מהקישור עוד לא פתוחות לעסק שלך. אפשר להכין הגדרות, והקישור יופיע כשדוביז תפתח אותן.";
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

/**
 * "09:00–09:45" for a timed appointment, "09:00" for an untimed one with a start, "ללא שעה" otherwise. A range is
 * wrapped in a left-to-right isolate (U+2066 … U+2069): inside Hebrew text the dash would otherwise flip it to
 * "09:45–09:00".
 */
export function timeLabel(a: AppointmentWire): string {
  if (!a.startsAt) return "ללא שעה";
  const start = clockOf(new Date(a.startsAt));
  return a.endsAt ? `⁦${start}–${clockOf(new Date(a.endsAt))}⁩` : start;
}

// ── What the owner may do ───────────────────────────────────────────────────────────────────────

export type Action = "confirm" | "complete" | "no_show" | "cancel" | "move" | "edit";

/**
 * The lifecycle's allowed moves (appointment.lifecycle) as buttons, with the outcome rule the server enforces
 * (appointment.service outcomeRefusal): "הושלם" / "לא הגיע" only once the appointment has started, "לא הגיע" only
 * for a customer appointment. A block only moves, edits and cancels.
 */
export function actionsFor(a: AppointmentWire, now: Date): Action[] {
  if (isTerminal(a.status)) return [];
  const out: Action[] = [];
  if (a.kind !== "BLOCK") {
    if (a.status === "PROPOSED") out.push("confirm");
    const started = !a.startsAt || Date.parse(a.startsAt) <= now.getTime();
    if (a.status === "CONFIRMED" && started) {
      out.push("complete");
      if (a.kind === "CUSTOMER") out.push("no_show");
    }
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
  // A request from the booking link names who asked until the owner links a customer card (D6).
  const customer = a.customerName ?? (a.customerId !== null ? names.customers.get(a.customerId) : undefined) ?? a.booking?.contactName;
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

// ── What is open: the same rule the slots engine applies ──────────────────────────────────────────

export type RuleLike = WeekWindow & { validFrom?: string | null; validUntil?: string | null };
export type ExceptionLike = { dayKey: string; kind: "CLOSED" | "OPEN_HOURS"; startMinute: number | null; endMinute: number | null; label?: string | null };
export type LaneHours = { rules: RuleLike[]; exceptions: ExceptionLike[] };
/** The business's hours and exceptions, and each staff member's own (empty rules = works by the business's hours). */
export type Availability = { business: LaneHours; staff: Map<number, LaneHours> };

export const NO_AVAILABILITY: Availability = { business: { rules: [], exceptions: [] }, staff: new Map() };

const ALL_DAY: RuleLike[] = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 0, endMinute: 1440 }));

/**
 * The open windows of one lane on one day, exactly as the server computes them for free slots
 * (appointment-schedule.service laneAvailability + availability.core windowsForDay): a staff member's own weekly hours
 * when they have any, otherwise the business's; the business's exceptions AND the staff member's own both apply.
 * `null` = nothing is known for that day (no hours were ever set and no exception falls on it): nothing is shaded.
 * With no weekly hours at all an exception still shows — cut out of an otherwise open day.
 */
export function openWindows(av: Availability, staffMemberId: number | null, day: DayKey): Array<{ startMinute: number; endMinute: number }> | null {
  const own = staffMemberId === null ? undefined : av.staff.get(staffMemberId);
  const rules = own && own.rules.length ? own.rules : av.business.rules;
  const today = [...av.business.exceptions, ...(own?.exceptions ?? [])].filter((e) => e.dayKey === day);
  if (!rules.length && !today.length) return null;
  return windowsForDay(day, rules.length ? rules : ALL_DAY, today);
}

/** One exception in words: "סגור כל היום", "סגור 12:00–14:00", "שעות מיוחדות 10:00–13:00", with its label. */
export function exceptionText(e: ExceptionLike): string {
  const range = e.startMinute !== null && e.endMinute !== null ? `⁦${clock(e.startMinute)}–${e.endMinute >= 1440 ? "24:00" : clock(e.endMinute)}⁩` : null;
  const what = e.kind === "OPEN_HOURS" ? `שעות מיוחדות ${range ?? ""}`.trim() : range ? `סגור ${range}` : "סגור כל היום";
  return e.label ? `${what} · ${e.label}` : what;
}

export type DayAvailability = {
  /** The business is closed the whole day (its weekly hours or an exception). */
  closed: boolean;
  /** The day's exceptions in words — the business's first, then each staff member's ("דנה: סגור כל היום"). */
  notes: string[];
};

/** What the month cell and the phone's day say about one day. */
export function dayAvailability(av: Availability, day: DayKey, names: Names): DayAvailability {
  const open = openWindows(av, null, day);
  const notes = av.business.exceptions.filter((e) => e.dayKey === day).map(exceptionText);
  for (const [id, lane] of av.staff) {
    const name = names.staff.get(id);
    if (!name?.active) continue;
    for (const e of lane.exceptions.filter((x) => x.dayKey === day)) notes.push(`${name.displayName}: ${exceptionText(e)}`);
  }
  return { closed: open !== null && open.length === 0, notes };
}

/** A closed exception on the grid: where it lies in the day, and what it says ("סגור · חג", "שירה: סגור"). */
export type ClosureBand = { start: number; end: number; label: string };

/**
 * The closed exceptions that fall on one lane's day (the business's and the staff member's own), as bands with their
 * words — so the grid names a closure instead of showing only stripes. A whole-day closure spans the day.
 */
export function closureBands(av: Availability, staffMemberId: number | null, day: DayKey, names: Names): ClosureBand[] {
  const own = staffMemberId === null ? [] : av.staff.get(staffMemberId)?.exceptions ?? [];
  const who = staffMemberId === null ? null : names.staff.get(staffMemberId)?.displayName ?? null;
  const band = (e: ExceptionLike, mine: boolean): ClosureBand => ({
    start: e.startMinute ?? 0,
    end: e.endMinute ?? 1440,
    label: `${mine && who ? `${who}: ` : ""}סגור${e.label ? ` · ${e.label}` : ""}`,
  });
  return [
    ...av.business.exceptions.filter((e) => e.dayKey === day && e.kind === "CLOSED").map((e) => band(e, false)),
    ...own.filter((e) => e.dayKey === day && e.kind === "CLOSED").map((e) => band(e, true)),
  ];
}

/**
 * Said BEFORE booking a time the lane is not open: the owner may still book it (the server accepts it with
 * OUTSIDE_AVAILABILITY — their calendar, their call), but never without knowing why it is not offered. Null when the
 * time is open, or when no hours are known. The reason is the same rule the free-slot search applies (openWindows).
 */
export function availabilityWarning(av: Availability, staffMemberId: number | null, day: DayKey, startMinute: number, minutes: number, names: Names): string | null {
  const open = openWindows(av, staffMemberId, day);
  if (open === null || !(minutes > 0)) return null;
  const end = startMinute + minutes;
  if (open.some((w) => w.startMinute <= startMinute && end <= w.endMinute)) return null;
  const hits = closureBands(av, staffMemberId, day, names).filter((b) => b.start < end && startMinute < b.end);
  const range = (a: number, b: number) => `⁦${clock(a)}–${b >= 1440 ? "24:00" : clock(b)}⁩`;
  if (hits.length) return `השעה נופלת בזמן סגור: ${hits.map((b) => (b.start === 0 && b.end === 1440 ? `${b.label} (כל היום)` : `${b.label} ${range(b.start, b.end)}`)).join(" · ")}.`;
  if (!open.length) return staffMemberId === null ? "העסק לא פעיל ביום הזה לפי שעות הפעילות." : "העובד לא עובד ביום הזה לפי שעות העבודה שלו.";
  return `השעה מחוץ לשעות הפעילות ביום הזה (${open.map((w) => range(w.startMinute, w.endMinute)).join(", ")}).`;
}

/** Why a day offers no free time, in words, when the hours explain it (a closure, a day off); else null. */
export function noSlotsReason(av: Availability, staffMemberId: number | null, day: DayKey, names: Names): string | null {
  const open = openWindows(av, staffMemberId, day);
  if (open === null || open.length) return null;
  const bands = closureBands(av, staffMemberId, day, names);
  if (bands.length) return `היום סגור: ${bands.map((b) => b.label).join(" · ")}.`;
  return staffMemberId === null ? "העסק לא פעיל ביום הזה לפי שעות הפעילות." : "העובד לא עובד ביום הזה לפי שעות העבודה שלו.";
}


// ── Public booking requests (Milestone C) ─────────────────────────────────────────────────────────

export const REQUEST_STATUS_LABEL: Record<string, string> = {
  PENDING: "ממתינה לאישור",
  APPROVED: "אושרה",
  DECLINED: "נדחתה",
  EXPIRED: "פגה",
  WITHDRAWN: "בוטלה ע״י הלקוח",
};

/** How long a pending request still holds its time: "עוד 9 שע׳", "עוד 40 דק׳", or "פגה". */
export function timeLeftLabel(expiresAt: string, now: Date): { text: string; urgent: boolean } {
  const ms = Date.parse(expiresAt) - now.getTime();
  if (!(ms > 0)) return { text: "פגה", urgent: true };
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return { text: `עוד ${minutes} דק׳`, urgent: true };
  const hours = Math.floor(minutes / 60);
  return { text: `עוד ${hours} שע׳`, urgent: hours < 2 };
}
// ── Redesign (direction A, 2026-11-02): lanes, hours in words, units, colours ──────────────────────

export type Lane = { key: string; staffMemberId: number | null; label: string; color: string | null; inactive: boolean };

/**
 * The day view's lanes: "ללא עובד" (the business itself), every active staff member, and every inactive one who
 * still has an appointment that day — an existing appointment never disappears because its staff member was
 * deactivated (the staff screen's promise). A staff id the list does not know (a read that failed) gets a lane too.
 */
export function dayLanes(staff: StaffWire[], dayAppointments: AppointmentWire[]): Lane[] {
  const used = new Set(dayAppointments.map((a) => a.staffMemberId).filter((x): x is number => x !== null));
  const lanes: Lane[] = [{ key: "biz", staffMemberId: null, label: "ללא עובד", color: null, inactive: false }];
  for (const m of [...staff].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)) {
    if (!m.active && !used.has(m.id)) continue;
    lanes.push({ key: `s${m.id}`, staffMemberId: m.id, label: m.active ? m.displayName : `${m.displayName} (לא פעיל)`, color: m.color, inactive: !m.active });
    used.delete(m.id);
  }
  for (const id of used) lanes.push({ key: `s${id}`, staffMemberId: id, label: "עובד", color: null, inactive: true });
  return lanes;
}

export const WEEKDAY_SHORT = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];

const endClock = (m: number) => (m >= 1440 ? "24:00" : clock(m));
/** "09:00–17:00" in a left-to-right isolate (inside Hebrew text the dash would flip it). */
export const rangeText = (start: number, end: number) => `⁦${clock(start)}–${endClock(end)}⁩`;

/**
 * The weekly hours in one line, consecutive days with the same windows joined: "א׳–ה׳ 09:00–17:00 · ו׳ 09:00–13:00".
 * No hours at all → null (the caller says "לא הוגדרו").
 */
export function hoursSummary(rules: WeekWindow[]): string | null {
  const days = windowsByWeekday(rules).map((d) => d.map((w) => rangeText(w.startMinute, w.endMinute)).join(", "));
  if (days.every((d) => !d)) return null;
  const parts: string[] = [];
  let i = 0;
  while (i < 7) {
    if (!days[i]) { i++; continue; }
    let j = i;
    while (j + 1 < 7 && days[j + 1] === days[i]) j++;
    parts.push(`${j > i ? `${WEEKDAY_SHORT[i]}–${WEEKDAY_SHORT[j]}` : WEEKDAY_SHORT[i]} ${days[i]}`);
    i = j + 1;
  }
  return parts.join(" · ");
}

/**
 * The next range "+ טווח שעות" adds after a day's last one: from its end, two hours long, never past midnight;
 * a day whose last range already ends at 23:45 or later has no room (null). An empty day starts at 09:00–17:00.
 */
export function nextRange(ranges: Array<{ startMinute: number; endMinute: number }>): { startMinute: number; endMinute: number } | null {
  if (!ranges.length) return { startMinute: 540, endMinute: 1020 };
  const last = Math.max(...ranges.map((r) => r.endMinute));
  if (last > 1440 - 15) return null;
  return { startMinute: last, endMinute: Math.min(1440, last + 120) };
}

/** The quarter-hour clock values a time picker offers (start: 00:00–23:45; end: 00:15–24:00), plus `keep` if off-grid. */
export function timeOptions(kind: "start" | "end", keep?: number | null): number[] {
  const out = Array.from({ length: 96 }, (_, i) => (kind === "start" ? i * 15 : (i + 1) * 15));
  if (keep !== undefined && keep !== null && !out.includes(keep)) out.push(keep);
  return out.sort((a, b) => a - b);
}
export const timeOptionLabel = (m: number) => endClock(m);

/** A length of time in the unit it reads best in: whole days, else whole hours, else minutes. */
export type LeadUnit = "minutes" | "hours" | "days";
export const UNIT_MINUTES: Record<LeadUnit, number> = { minutes: 1, hours: 60, days: 1440 };
export const UNIT_LABEL: Record<LeadUnit, string> = { minutes: "דקות", hours: "שעות", days: "ימים" };
export function splitMinutes(m: number): { value: number; unit: LeadUnit } {
  if (m > 0 && m % 1440 === 0) return { value: m / 1440, unit: "days" };
  if (m > 0 && m % 60 === 0) return { value: m / 60, unit: "hours" };
  return { value: m, unit: "minutes" };
}

/** The staff colours (soft, distinct); a new staff member gets the first one nobody uses yet. */
export const STAFF_PALETTE = ["#c0643f", "#7d5ba6", "#4f8a68", "#3f78a8", "#c08a2e", "#b8577a", "#2f7f7a", "#66707e"];
export function nextStaffColor(staff: Array<Pick<StaffWire, "color">>): string {
  const taken = new Set(staff.map((m) => m.color?.toLowerCase()).filter(Boolean));
  return STAFF_PALETTE.find((c) => !taken.has(c)) ?? STAFF_PALETTE[staff.length % STAFF_PALETTE.length];
}
export const COLOR_NAME: Record<string, string> = {
  "#c0643f": "טרקוטה", "#7d5ba6": "סגול", "#4f8a68": "ירוק", "#3f78a8": "כחול", "#c08a2e": "חרדל", "#b8577a": "ורוד", "#2f7f7a": "טורקיז", "#66707e": "אפור",
};

/** The staff members who may take a service: those assigned to it, or everyone active when nobody is. */
export function staffForService(staff: StaffWire[], serviceId: number | null): StaffWire[] {
  const active = staff.filter((x) => x.active);
  if (serviceId === null) return active;
  const assigned = active.filter((x) => x.services.some((a) => a.businessServiceId === serviceId));
  return assigned.length ? assigned : active;
}

/**
 * A chosen staff member who does not perform the newly chosen service is cleared (the server would refuse the booking
 * with STAFF_NOT_ASSIGNED); a fitting choice is kept.
 */
export function keepStaffFor(staff: StaffWire[], serviceId: number | null, staffId: number | null): number | null {
  if (staffId === null) return null;
  return staffForService(staff, serviceId).some((x) => x.id === staffId) ? staffId : null;
}

/** A booking-link request's outcome in words — its appointment's cancellation wins over "אושרה" (a customer can cancel an approved booking). */
export function requestOutcome(r: { status: string; appointment: { status: string } }): { label: string; tone: "ok" | "off" } {
  if (r.status === "APPROVED" && r.appointment.status === "CANCELED") return { label: "התור בוטל", tone: "off" };
  return { label: REQUEST_STATUS_LABEL[r.status] ?? r.status, tone: r.status === "APPROVED" ? "ok" : "off" };
}

/**
 * Booking-link settings that leave the link with nothing a customer can book, said before saving makes it so:
 * "the customer must choose a staff member" while staff names are hidden offers no staff to choose — every service
 * becomes unbookable (the public page's rule, public-booking-model serviceBookable).
 */
export function bookingDeadEnd(s: { staffChoiceMode: string; showStaffNames: boolean }, hasStaff: boolean): string | null {
  if (hasStaff && s.staffChoiceMode === "REQUIRED" && !s.showStaffNames) {
    return "בחירת עובד מוגדרת כחובה, אבל שמות העובדים מוסתרים — כך אף שירות לא יוצג ללקוחות. אפשר להציג את השמות, או לשנות את הבחירה ל„אם רוצה”.";
  }
  return null;
}

// ── Who performs what: one rule for the service page and the staff page ─────────────────────────────

export type AssignAxis = { kind: "service"; serviceId: number } | { kind: "staff"; staffId: number };
/** The editor's picture: per row (a staff member on a service page, a service on a staff page) → its own length or null. */
export type AssignPick = Map<number, number | null>;

/** What the server holds today for one axis, in the editor's terms. */
export function currentPick(staff: StaffWire[], axis: AssignAxis): AssignPick {
  if (axis.kind === "staff") {
    const m = staff.find((x) => x.id === axis.staffId);
    return new Map((m?.services ?? []).map((x) => [x.businessServiceId, x.durationOverrideMinutes]));
  }
  const out: AssignPick = new Map();
  for (const m of staff) {
    if (!m.active) continue;
    const a = m.services.find((x) => x.businessServiceId === axis.serviceId);
    if (a) out.set(m.id, a.durationOverrideMinutes);
  }
  return out;
}

export function samePick(a: AssignPick, b: AssignPick): boolean {
  return a.size === b.size && [...a].every(([k, v]) => b.has(k) && b.get(k) === v);
}

/**
 * The writes that make the server hold `want` for one axis — read-modify-write on the staff members' CURRENT lists
 * (`fresh`, read right before saving): only this axis's entries change, every other assignment and its own length is
 * carried over exactly, and each write is one staff member's whole list sent with the version it was read at.
 */
export function assignmentWrites(fresh: StaffWire[], axis: AssignAxis, want: AssignPick): Array<{ member: StaffWire; services: StaffWire["services"] }> {
  const out: Array<{ member: StaffWire; services: StaffWire["services"] }> = [];
  if (axis.kind === "staff") {
    const member = fresh.find((x) => x.id === axis.staffId);
    if (!member) return out;
    const services = [...want].map(([businessServiceId, durationOverrideMinutes]) => ({ businessServiceId, durationOverrideMinutes }));
    if (!samePick(currentPick(fresh, axis), want)) out.push({ member, services });
    return out;
  }
  for (const member of fresh.filter((m) => m.active)) {
    const has = member.services.find((x) => x.businessServiceId === axis.serviceId);
    const wanted = want.has(member.id);
    const override = want.get(member.id) ?? null;
    if (!has && !wanted) continue;
    if (has && wanted && has.durationOverrideMinutes === override) continue;
    const others = member.services.filter((x) => x.businessServiceId !== axis.serviceId);
    out.push({ member, services: wanted ? [...others, { businessServiceId: axis.serviceId, durationOverrideMinutes: override }] : others });
  }
  return out;
}

