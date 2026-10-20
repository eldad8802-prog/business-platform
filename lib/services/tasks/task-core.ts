/**
 * Daily Tasks — the pure core (Daily Tasks spec, sections 6, 8.5, 12.6, 12.9).
 *
 * Everything here is deterministic and dependency-free: no Prisma, no clock, no environment. The service
 * (task.service.ts) supplies "now" and "today" and turns these decisions into writes inside one tenant
 * transaction; the tests prove the decisions without a database.
 *
 *   - Calendar days: a task is due on a Jerusalem calendar day (`YYYY-MM-DD`), stored as a DATE.
 *   - Recurrence: four rule kinds (every day, chosen weekdays, a day of the month with 31 = the last day,
 *     every N days), measured in calendar days — never in hours, so DST cannot move an occurrence.
 *   - The manual-task state machine (6.1): OPEN → DONE / CANCELED → (reopen) OPEN. IN_PROGRESS is not used.
 *   - The closed journal payload (12.6): per event type, a fixed set of keys whose values are numbers,
 *     booleans, day keys or enum tokens. Free text can never reach the journal (the DB CHECK refuses it too).
 */
import { addCalendarDays, daysBetweenDayKeys, type JerusalemDayKey } from "@/lib/utils/jerusalem-day";

// ── Calendar days ──────────────────────────────────────────────────────────────────────────────

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function isDayKey(value: unknown): value is JerusalemDayKey {
  if (typeof value !== "string" || !DAY_KEY.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** A DATE column value as Prisma hands it over (UTC midnight) ↔ the calendar day it names. */
export function dayKeyToDbDate(key: JerusalemDayKey): Date {
  if (!isDayKey(key)) throw new Error(`not a calendar day: ${String(key)}`);
  return new Date(`${key}T00:00:00.000Z`);
}
export function dbDateToDayKey(value: Date): JerusalemDayKey {
  return value.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, of the calendar day itself (no time zone involved). */
export function weekdayOf(key: JerusalemDayKey): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function daysInMonth(key: JerusalemDayKey): number {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// ── Recurrence (6.2) ───────────────────────────────────────────────────────────────────────────

export type SeriesRule =
  | { kind: "DAILY" }
  | { kind: "WEEKDAYS"; weekdays: number[] }
  | { kind: "MONTH_DAY"; monthDay: number }
  | { kind: "EVERY_N_DAYS"; intervalDays: number };

export type RuleProblem = "WEEKDAYS_EMPTY" | "WEEKDAY_OUT_OF_RANGE" | "MONTH_DAY_OUT_OF_RANGE" | "INTERVAL_OUT_OF_RANGE";

export function validateRule(rule: SeriesRule): RuleProblem | null {
  switch (rule.kind) {
    case "DAILY":
      return null;
    case "WEEKDAYS":
      if (!Array.isArray(rule.weekdays) || rule.weekdays.length === 0) return "WEEKDAYS_EMPTY";
      if (rule.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return "WEEKDAY_OUT_OF_RANGE";
      return null;
    case "MONTH_DAY":
      return Number.isInteger(rule.monthDay) && rule.monthDay >= 1 && rule.monthDay <= 31 ? null : "MONTH_DAY_OUT_OF_RANGE";
    case "EVERY_N_DAYS":
      return Number.isInteger(rule.intervalDays) && rule.intervalDays >= 2 && rule.intervalDays <= 366 ? null : "INTERVAL_OUT_OF_RANGE";
  }
}

/** The weekdays sorted and de-duplicated, the shape stored in TaskSeries.ruleWeekdays. */
export function normalizeRule(rule: SeriesRule): SeriesRule {
  return rule.kind === "WEEKDAYS" ? { kind: "WEEKDAYS", weekdays: [...new Set(rule.weekdays)].sort((a, b) => a - b) } : rule;
}

/** Does the rule (anchored at startOn) fall on `day`? Days before startOn never do. */
export function occursOn(rule: SeriesRule, startOn: JerusalemDayKey, day: JerusalemDayKey): boolean {
  if (day < startOn) return false;
  switch (rule.kind) {
    case "DAILY":
      return true;
    case "WEEKDAYS":
      return rule.weekdays.includes(weekdayOf(day));
    case "MONTH_DAY": {
      const dom = Number(day.slice(8, 10));
      return dom === Math.min(rule.monthDay, daysInMonth(day));
    }
    case "EVERY_N_DAYS":
      return daysBetweenDayKeys(startOn, day) % rule.intervalDays === 0;
  }
}

/** The longest gap any valid rule can leave between two occurrences, plus margin. */
const MAX_SCAN_DAYS = 400;

/** The first occurrence on or after `from` (and never before startOn). */
export function firstOccurrenceOnOrAfter(rule: SeriesRule, startOn: JerusalemDayKey, from: JerusalemDayKey): JerusalemDayKey {
  let day = from < startOn ? startOn : from;
  for (let i = 0; i <= MAX_SCAN_DAYS; i += 1) {
    if (occursOn(rule, startOn, day)) return day;
    day = addCalendarDays(day, 1);
  }
  throw new Error("recurrence rule has no occurrence within the scan window");
}

/**
 * The next occurrence after an occurrence closes (6.2): the first rule day strictly after BOTH today and the
 * closed occurrence's due day. An overdue occurrence completed late never produces occurrences for the days
 * already gone; one completed early never produces a second occurrence for its own day.
 */
export function nextOccurrenceAfterClose(rule: SeriesRule, startOn: JerusalemDayKey, closedDueOn: JerusalemDayKey | null, today: JerusalemDayKey): JerusalemDayKey {
  const floor = closedDueOn && closedDueOn > today ? closedDueOn : today;
  return firstOccurrenceOnOrAfter(rule, startOn, addCalendarDays(floor, 1));
}

/** Resuming a series with no open occurrence (6.5): the first rule day from today (today included). */
export function occurrenceOnResume(rule: SeriesRule, startOn: JerusalemDayKey, today: JerusalemDayKey): JerusalemDayKey {
  return firstOccurrenceOnOrAfter(rule, startOn, today);
}

/** At most this many dates are listed in OCCURRENCES_MISSED; beyond it, the count alone (6.2). */
export const MISSED_DATES_LIMIT = 31;

/**
 * Occurrences the rule produced after an open occurrence's due day, up to and including today: the open one
 * stays single and shows "missed N" instead of a pile (6.2).
 */
export function missedOccurrences(rule: SeriesRule, startOn: JerusalemDayKey, openDueOn: JerusalemDayKey, today: JerusalemDayKey): { count: number; dates: JerusalemDayKey[] } {
  const dates: JerusalemDayKey[] = [];
  let count = 0;
  if (today <= openDueOn) return { count, dates };
  let day = addCalendarDays(openDueOn, 1);
  // Bounded: a series cannot be open for more than a few years in practice; cap the walk at ten years.
  for (let i = 0; i < 3660 && day <= today; i += 1) {
    if (occursOn(rule, startOn, day)) {
      count += 1;
      if (dates.length < MISSED_DATES_LIMIT) dates.push(day);
    }
    day = addCalendarDays(day, 1);
  }
  return { count, dates };
}

// ── The manual-task state machine (6.1) ─────────────────────────────────────────────────────────

export type TaskState = "OPEN" | "DONE" | "CANCELED" | "IN_PROGRESS";
export type TaskAction = "EDIT" | "RESCHEDULE" | "SNOOZE" | "COMPLETE" | "CANCEL" | "SKIP" | "REOPEN";

/** Which state an action may start from, and where it leads. IN_PROGRESS is a legacy value nothing enters. */
export const TRANSITIONS: Readonly<Record<TaskAction, { from: readonly TaskState[]; to: TaskState }>> = Object.freeze({
  EDIT: { from: ["OPEN"], to: "OPEN" },
  RESCHEDULE: { from: ["OPEN"], to: "OPEN" },
  SNOOZE: { from: ["OPEN"], to: "OPEN" },
  COMPLETE: { from: ["OPEN"], to: "DONE" },
  CANCEL: { from: ["OPEN"], to: "CANCELED" },
  SKIP: { from: ["OPEN"], to: "CANCELED" },
  REOPEN: { from: ["DONE", "CANCELED"], to: "OPEN" },
});

export function canTransition(action: TaskAction, from: TaskState): boolean {
  return TRANSITIONS[action].from.includes(from);
}

// ── Text limits (mirrored by DB CHECKs) ─────────────────────────────────────────────────────────

export const TITLE_MAX = 200;
export const NOTE_MAX = 2000;

export type TextProblem = "TITLE_REQUIRED" | "TITLE_TOO_LONG" | "NOTE_TOO_LONG";
export function validateText(title: string | undefined, note: string | null | undefined): TextProblem | null {
  if (title !== undefined) {
    if (title.trim().length === 0) return "TITLE_REQUIRED";
    if (title.length > TITLE_MAX) return "TITLE_TOO_LONG";
  }
  if (note != null && note.length > NOTE_MAX) return "NOTE_TOO_LONG";
  return null;
}

// ── The closed journal payload (12.6) ───────────────────────────────────────────────────────────

/** The DB CHECK's token shape: every string in a payload must match it. */
export const PAYLOAD_TOKEN = /^[A-Za-z0-9_:.-]{0,64}$/;

type PayloadKind = "day" | "days" | "int" | "token" | "tokens" | "bool";

/**
 * Per event type, the only keys a payload may carry and what each holds. Nothing here can hold a title, a
 * note, a name, an amount or a balance (T-M5): those never enter the journal.
 */
export const PAYLOAD_SCHEMA: Readonly<Record<string, Readonly<Record<string, PayloadKind>>>> = Object.freeze({
  TASK_CREATED: { dueOn: "day", origin: "token", link: "token", seriesSequence: "int" },
  TASK_EDITED: { fields: "tokens" },
  TASK_RESCHEDULED: { from: "day", to: "day" },
  TASK_SNOOZED: { from: "day", to: "day" },
  TASK_COMPLETED: { dueOn: "day", lateDays: "int", nextTaskId: "int" },
  TASK_CANCELED: { closeReason: "token", nextTaskId: "int" },
  TASK_REOPENED: { withdrawnTaskId: "int", from: "token" },
  OCCURRENCES_MISSED: { count: "int", dates: "days" },
  SERIES_CREATED: { ruleKind: "token", firstTaskId: "int", startOn: "day" },
  SERIES_CHANGED: { fields: "tokens", ruleKind: "token", closedTaskId: "int", nextTaskId: "int" },
  SERIES_PAUSED: {},
  SERIES_RESUMED: { createdTaskId: "int" },
  SERIES_ENDED: {},
  SOURCE_ITEM_ACKNOWLEDGED: { dayKey: "day", evidenceVersion: "token" },
  SOURCE_ITEM_SNOOZED: { until: "day" },
  SOURCE_ITEM_DISMISSED: {},
  SOURCE_ITEM_PINNED: {},
  SOURCE_ITEM_UNPINNED: {},
  SOURCE_DISABLED: { sourceKind: "token" },
  SOURCE_ENABLED: { sourceKind: "token" },
  SOURCE_CLOSED_OBSERVED: { evidenceVersion: "token" },
  PREFERENCES_CHANGED: { fields: "tokens" },
});

export type PayloadProblem = { key: string; problem: "UNKNOWN_EVENT" | "UNKNOWN_KEY" | "WRONG_TYPE" | "NOT_A_TOKEN" };

function valueFits(kind: PayloadKind, v: unknown): "WRONG_TYPE" | "NOT_A_TOKEN" | null {
  switch (kind) {
    case "day":
      return isDayKey(v) ? null : "WRONG_TYPE";
    case "days":
      return Array.isArray(v) && v.length <= MISSED_DATES_LIMIT && v.every(isDayKey) ? null : "WRONG_TYPE";
    case "int":
      return Number.isInteger(v) ? null : "WRONG_TYPE";
    case "bool":
      return typeof v === "boolean" ? null : "WRONG_TYPE";
    case "token":
      if (typeof v !== "string") return "WRONG_TYPE";
      return PAYLOAD_TOKEN.test(v) ? null : "NOT_A_TOKEN";
    case "tokens":
      if (!Array.isArray(v) || v.length > 32) return "WRONG_TYPE";
      return v.every((x) => typeof x === "string" && PAYLOAD_TOKEN.test(x)) ? null : "NOT_A_TOKEN";
  }
}

/** Null when the payload fits its event type's closed schema (T-P3: the service refuses before the DB does). */
export function validatePayload(eventType: string, payload: Record<string, unknown>): PayloadProblem | null {
  const schema = PAYLOAD_SCHEMA[eventType];
  if (!schema) return { key: eventType, problem: "UNKNOWN_EVENT" };
  for (const [key, value] of Object.entries(payload)) {
    const kind = schema[key];
    if (!kind) return { key, problem: "UNKNOWN_KEY" };
    if (value === undefined) continue;
    const bad = valueFits(kind, value);
    if (bad) return { key, problem: bad };
  }
  return null;
}

/** Drop undefined values so the stored JSON carries only what was said. */
export function compactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined));
}

// ── Series rows and their cadence, in the owner's words ─────────────────────────────────────────

/** The rule a stored series carries (TaskSeries columns). */
export function ruleOfSeries(s: { ruleKind: string; ruleWeekdays: number[]; ruleMonthDay: number | null; ruleIntervalDays: number | null }): SeriesRule {
  switch (s.ruleKind) {
    case "WEEKDAYS": return { kind: "WEEKDAYS", weekdays: s.ruleWeekdays };
    case "MONTH_DAY": return { kind: "MONTH_DAY", monthDay: s.ruleMonthDay ?? 1 };
    case "EVERY_N_DAYS": return { kind: "EVERY_N_DAYS", intervalDays: s.ruleIntervalDays ?? 2 };
    default: return { kind: "DAILY" };
  }
}

const WEEKDAY_FULL = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
const WEEKDAY_SHORT = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];

/** "כל יום" · "כל יום שלישי" · "בימים א׳, ה׳" · "כל 15 בחודש" · "בסוף כל חודש" · "כל 3 ימים". */
export function cadenceLabel(rule: SeriesRule): string {
  switch (rule.kind) {
    case "DAILY": return "כל יום";
    case "WEEKDAYS": {
      const days = [...new Set(rule.weekdays)].sort((a, b) => a - b);
      if (days.length === 7) return "כל יום";
      return days.length === 1 ? `כל יום ${WEEKDAY_FULL[days[0]]}` : `בימים ${days.map((d) => WEEKDAY_SHORT[d]).join(", ")}`;
    }
    case "MONTH_DAY": return rule.monthDay === 31 ? "בסוף כל חודש" : `כל ${rule.monthDay} בחודש`;
    case "EVERY_N_DAYS": return `כל ${rule.intervalDays} ימים`;
  }
}
