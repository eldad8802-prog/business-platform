/**
 * Shared presentation helpers for the money-out surfaces (Secretary and
 * Payables). Pure functions only, so they can be verified without a browser.
 *
 * House rule (see lib/payables/payables-client.ts): every amount arrives as
 * the server's decimal string. These helpers FORMAT it; they never add,
 * subtract or round money into a new figure.
 */

export const ISRAEL_TZ = "Asia/Jerusalem";

/**
 * One money format for every screen: "3,545 ₪", and "15.50 ₪" when the value
 * has agorot. Whole amounts drop the ".00"; a fractional amount always shows
 * both digits, so 15.5 never reads as "15.5".
 */
export function formatAmount(amount: string | number, currency = "ILS"): string {
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) return String(amount);
  const whole = Math.abs(n - Math.trunc(n)) < 1e-9;
  try {
    return new Intl.NumberFormat("he-IL", {
      style: "currency",
      currency: currency || "ILS",
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    }).format(n);
  } catch {
    return n.toLocaleString("he-IL", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }) + " " + currency;
  }
}

/** yyyy-mm-dd of an instant as a calendar day in Israel. */
export function israelDayKey(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ISRAEL_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

function dayKeyToUtcNoon(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12);
}

/**
 * Whole calendar days from today (Israel) to the day of `iso` (Israel).
 * Negative = in the past. This is a DATE fact for display ("לפני 36 ימים");
 * whether an item counts as overdue always comes from the server's own state.
 */
export function civilDaysFromToday(iso: string, now: Date = new Date()): number | null {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  const diff = dayKeyToUtcNoon(israelDayKey(when)) - dayKeyToUtcNoon(israelDayKey(now));
  return Math.round(diff / 86_400_000);
}

/** "היום" · "מחר" · "אתמול" · "בעוד 5 ימים" · "לפני 36 ימים". */
export function relativeDayText(days: number): string {
  if (days === 0) return "היום";
  if (days === 1) return "מחר";
  if (days === -1) return "אתמול";
  if (days === 2) return "בעוד יומיים";
  if (days === -2) return "לפני יומיים";
  return days > 0 ? `בעוד ${days} ימים` : `לפני ${-days} ימים`;
}

/** 15.09.2026 */
export function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: ISRAEL_TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

/** 15 בספטמבר */
export function formatDayMonth(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("he-IL", { timeZone: ISRAEL_TZ, day: "numeric", month: "long" }).format(d);
}

/** יום רביעי, 21 באוקטובר */
export function formatLongDay(instant: Date = new Date()): string {
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: ISRAEL_TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(instant);
}

/** Hebrew count phrase with the right singular form: "תשלום אחד" / "3 תשלומים". */
export function countPhrase(n: number, one: string, many: string): string {
  return n === 1 ? one : `${n.toLocaleString("he-IL")} ${many}`;
}

/* ─────────────────────────────── errors ──────────────────────────────────── */

const HEBREW = /[֐-׿]/;

/**
 * Server rule messages that reach the browser in English, translated for the
 * owner. Matching is on stable fragments of the server text; anything not
 * listed falls back to the caller's Hebrew sentence. The raw message is never
 * shown when it has no Hebrew in it.
 */
const KNOWN_ERRORS: Array<[RegExp, string]> = [
  [/decimal with at most 2 places/i, "הסכום צריך להיות מספר, עם עד שתי ספרות אחרי הנקודה."],
  [/at least 2 installments/i, "בפריסת תשלומים צריך לפחות 2 תשלומים."],
  [/payee name is required/i, "צריך לרשום למי משלמים."],
  [/already recorded/i, "התשלום הזה כבר נרשם."],
  [/after a payment|has a payment|already (has|been) paid/i, "אי אפשר לשנות את זה אחרי שנרשם תשלום."],
  [/saved payee/i, "השם מגיע ממוטב שמור. את השם משנים במוטב עצמו."],
  [/not active|is (closed|released|ended)/i, "ההתחייבות כבר לא פעילה, ולכן אי אפשר לבצע את הפעולה."],
  [/not found/i, "הפריט לא נמצא. ייתכן שכבר עודכן או הוסר."],
  [/in the future|future date/i, "התאריך לא יכול להיות בעתיד."],
  [/cadence|recurrence/i, "אי אפשר לשנות את התדירות של התחייבות שכבר יש לה כמה מועדים."],
];

export function hebrewErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!raw) return fallback;
  if (HEBREW.test(raw)) return raw;
  for (const [pattern, message] of KNOWN_ERRORS) {
    if (pattern.test(raw)) return message;
  }
  return fallback;
}
