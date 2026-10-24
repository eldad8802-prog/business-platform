/**
 * Daily Tasks — when a personal task is due and when to remind (migration 20261022090000). PURE: no database,
 * no clock of its own.
 *
 * A task carries a due DAY (dueOn), optionally a time of day (dueMinute, minutes after midnight in Israel) and,
 * only with a time, a reminder offset (remindOffsetMinutes: 0 = at the moment, up to 7 days before). The reminder
 * moment is derived — never typed in — so moving the day or the time moves the reminder with it:
 *
 *   remindAt = the Israeli wall-clock moment (dueOn, dueMinute) − remindOffsetMinutes
 *
 * The wall clock is resolved in Asia/Jerusalem (jerusalemInstantAt: daylight-saving aware), so "10:00" is 10:00 in
 * Israel on both sides of a clock change. The database holds the same shape rules (Task_schedule_shape).
 */
import { jerusalemClock, jerusalemDayKey, jerusalemInstantAt, type JerusalemDayKey } from "@/lib/utils/jerusalem-day";

export const MAX_REMIND_OFFSET_MINUTES = 7 * 24 * 60;
/** The offsets the form offers; the service accepts any whole number in range. */
export const REMIND_OFFSET_CHOICES: readonly { minutes: number; label: string }[] = [
  { minutes: 0, label: "בזמן המשימה" },
  { minutes: 15, label: "15 דקות לפני" },
  { minutes: 60, label: "שעה לפני" },
  { minutes: 1440, label: "יום לפני" },
];
/** A reminder may be snoozed at most this far ahead. */
export const MAX_SNOOZE_DAYS = 30;

export type Schedule = {
  dueOn: JerusalemDayKey | null;
  dueMinute: number | null;
  remindOffsetMinutes: number | null;
};

/** null when the shape is valid; otherwise the field and the problem (the service turns it into INVALID_INPUT). */
export function scheduleProblem(s: Schedule): { field: string; problem: string } | null {
  if (s.dueMinute != null) {
    if (!Number.isInteger(s.dueMinute) || s.dueMinute < 0 || s.dueMinute > 1439) return { field: "dueMinute", problem: "OUT_OF_RANGE" };
    if (!s.dueOn) return { field: "dueMinute", problem: "TIME_WITHOUT_DAY" };
  }
  if (s.remindOffsetMinutes != null) {
    if (!Number.isInteger(s.remindOffsetMinutes) || s.remindOffsetMinutes < 0 || s.remindOffsetMinutes > MAX_REMIND_OFFSET_MINUTES) {
      return { field: "remindOffsetMinutes", problem: "OUT_OF_RANGE" };
    }
    if (s.dueMinute == null) return { field: "remindOffsetMinutes", problem: "REMINDER_WITHOUT_TIME" };
  }
  return null;
}

/** The due moment as an instant (null without a time). */
export function dueAtOf(s: Pick<Schedule, "dueOn" | "dueMinute">): Date | null {
  if (!s.dueOn || s.dueMinute == null) return null;
  return jerusalemInstantAt(s.dueOn, Math.floor(s.dueMinute / 60), s.dueMinute % 60);
}

/** The reminder moment (null without a reminder). */
export function remindAtOf(s: Schedule): Date | null {
  const due = dueAtOf(s);
  if (!due || s.remindOffsetMinutes == null) return null;
  return new Date(due.getTime() - s.remindOffsetMinutes * 60_000);
}

/** "HH:MM" → minutes after midnight, or null when malformed. */
export function parseClock(value: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Minutes after midnight → "HH:MM". */
export function clockLabel(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export function offsetLabel(minutes: number): string {
  const choice = REMIND_OFFSET_CHOICES.find((c) => c.minutes === minutes);
  if (choice) return choice.label;
  if (minutes % 1440 === 0) return `${minutes / 1440} ימים לפני`;
  if (minutes % 60 === 0) return `${minutes / 60} שעות לפני`;
  return `${minutes} דקות לפני`;
}

/**
 * A snooze target for a reminder: strictly in the future, at most MAX_SNOOZE_DAYS ahead, a whole minute (the
 * journal stores it as a token). Returns the normalised instant or a problem.
 */
export function snoozeTarget(untilIso: unknown, now: Date): { at: Date } | { problem: string } {
  if (typeof untilIso !== "string" || untilIso.length > 40) return { problem: "MALFORMED" };
  const at = new Date(untilIso);
  if (Number.isNaN(at.getTime())) return { problem: "MALFORMED" };
  at.setUTCSeconds(0, 0);
  if (at.getTime() <= now.getTime()) return { problem: "NOT_IN_FUTURE" };
  if (at.getTime() - now.getTime() > MAX_SNOOZE_DAYS * 86_400_000) return { problem: "TOO_FAR" };
  return { at };
}

/** The snooze presets the reminder offers ("10 דקות", "שעה", "מחר ב־09:00"), as instants. */
export function snoozePresets(now: Date): { key: "10m" | "1h" | "tomorrow"; label: string; at: Date }[] {
  const tomorrow = jerusalemDayKey(new Date(now.getTime() + 86_400_000));
  return [
    { key: "10m", label: "עוד 10 דקות", at: roundUpMinute(new Date(now.getTime() + 10 * 60_000)) },
    { key: "1h", label: "עוד שעה", at: roundUpMinute(new Date(now.getTime() + 60 * 60_000)) },
    { key: "tomorrow", label: "מחר ב־09:00", at: jerusalemInstantAt(tomorrow, 9, 0) },
  ];
}

function roundUpMinute(d: Date): Date {
  const x = new Date(d);
  if (x.getUTCSeconds() || x.getUTCMilliseconds()) x.setUTCMinutes(x.getUTCMinutes() + 1, 0, 0);
  return x;
}

/** The reminder moment as the owner reads it: "היום 09:45", "מחר 10:00", or "24.10 10:00". */
export function remindMomentLabel(at: Date, now: Date): string {
  const day = jerusalemDayKey(at);
  const today = jerusalemDayKey(now);
  const tomorrow = jerusalemDayKey(new Date(now.getTime() + 86_400_000));
  const { hours, minutes } = jerusalemClock(at);
  const clock = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  if (day === today) return `היום ${clock}`;
  if (day === tomorrow) return `מחר ${clock}`;
  const [, mm, dd] = day.split("-");
  return `${dd}.${mm} ${clock}`;
}
