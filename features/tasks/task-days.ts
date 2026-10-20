/**
 * Calendar days as the owner reads them (Asia/Jerusalem), for the task screens. Pure — no server imports.
 * Day keys are "YYYY-MM-DD", the same keys the API takes and returns.
 */

const WEEKDAY_SHORT = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
const WEEKDAY_LONG = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
const MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];

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
export function chipLabel(key: string): string {
  return `יום ${WEEKDAY_SHORT[weekdayOf(key)]}, ${short(key)}`;
}

/** "יום שלישי, 13 באוקטובר" — the header line. */
export function longDate(key: string): string {
  return `יום ${WEEKDAY_LONG[weekdayOf(key)]}, ${Number(key.slice(8, 10))} ב${MONTHS[Number(key.slice(5, 7)) - 1]}`;
}

/** "היום" / "מחר" / "ביום שלישי, 20.10" — inside a sentence. */
export function whenPhrase(key: string, today: string): string {
  if (key === today) return "היום";
  if (key === addDays(today, 1)) return "מחר";
  return `ביום ${WEEKDAY_LONG[weekdayOf(key)]}, ${short(key)}`;
}

export function weekdayLong(d: number): string {
  return WEEKDAY_LONG[d];
}
