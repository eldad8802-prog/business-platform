/**
 * Calendar days as the owner reads them (Asia/Jerusalem), for the task screens. Pure — no server imports.
 * Day keys are "YYYY-MM-DD", the same keys the API takes and returns.
 *
 * Words come from the i18n dictionary (tasks.days.*). Every function takes an optional translator; without
 * one it speaks Hebrew — exactly the text these helpers produced before i18n.
 */
import { he } from "@/lib/i18n/messages/he";
import { createTranslator, type MessageKey, type Translator } from "@/lib/i18n/translate";

const HE: Translator = createTranslator(he);

const WEEKDAY_SHORT: readonly MessageKey[] = [
  "tasks.days.short.sun",
  "tasks.days.short.mon",
  "tasks.days.short.tue",
  "tasks.days.short.wed",
  "tasks.days.short.thu",
  "tasks.days.short.fri",
  "tasks.days.short.sat",
];
const WEEKDAY_LONG: readonly MessageKey[] = [
  "tasks.days.long.sun",
  "tasks.days.long.mon",
  "tasks.days.long.tue",
  "tasks.days.long.wed",
  "tasks.days.long.thu",
  "tasks.days.long.fri",
  "tasks.days.long.sat",
];
const MONTHS: readonly MessageKey[] = [
  "tasks.days.month.jan",
  "tasks.days.month.feb",
  "tasks.days.month.mar",
  "tasks.days.month.apr",
  "tasks.days.month.may",
  "tasks.days.month.jun",
  "tasks.days.month.jul",
  "tasks.days.month.aug",
  "tasks.days.month.sep",
  "tasks.days.month.oct",
  "tasks.days.month.nov",
  "tasks.days.month.dec",
];

export function todayKey(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDays(key: string, n: number): string {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(key: string): number {
  return new Date(`${key}T12:00:00Z`).getUTCDay();
}

/** "20.10" */
export function short(key: string): string {
  return `${key.slice(8, 10)}.${key.slice(5, 7)}`;
}

/** "יום ג׳, 20.10" */
export function chipLabel(key: string, t: Translator = HE): string {
  return t("tasks.days.chipLabel", { weekday: t(WEEKDAY_SHORT[weekdayOf(key)]), date: short(key) });
}

/** "יום שלישי, 13 באוקטובר" — the header line. */
export function longDate(key: string, t: Translator = HE): string {
  return t("tasks.days.longDate", {
    weekday: t(WEEKDAY_LONG[weekdayOf(key)]),
    day: Number(key.slice(8, 10)),
    month: t(MONTHS[Number(key.slice(5, 7)) - 1]),
  });
}

/** "היום" / "מחר" / "ביום שלישי, 20.10" — inside a sentence. */
export function whenPhrase(key: string, today: string, t: Translator = HE): string {
  if (key === today) return t("tasks.days.today");
  if (key === addDays(today, 1)) return t("tasks.days.tomorrow");
  return t("tasks.days.onDay", { weekday: t(WEEKDAY_LONG[weekdayOf(key)]), date: short(key) });
}

export function weekdayLong(d: number, t: Translator = HE): string {
  return t(WEEKDAY_LONG[d]);
}
