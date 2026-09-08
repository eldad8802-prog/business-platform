/**
 * Fiscal date normalization for historical import.
 *
 * # Why this exists at all
 *
 * The four tabular domains that already import — customers, suppliers, leads,
 * inventory — have no date column between them, so the normalization toolkit
 * never needed one. Historical fiscal documents have exactly one date and it
 * decides which reporting period the document belongs to. Reading it wrong does
 * not corrupt a phone number; it moves an invoice into another month.
 *
 * # The rule that governs everything below
 *
 * `03/04/2024` is the 3rd of April in Israel and the 4th of March in the United
 * States, and NOTHING IN THE VALUE SAYS WHICH. A parser that picks one is
 * guessing, and a guess that lands in a tax period is the wrong kind of guess.
 *
 * So textual dates are read under an EXPLICIT format contract that the caller
 * supplies. There is no locale sniffing, no `new Date(userString)`, and no
 * "day-first because Israel". When the contract is absent, a value that could
 * be read two ways is REFUSED with a reason the owner can act on — the same
 * stance `normalizeNumber` already takes on the European decimal comma.
 *
 * A value that can only be read one way — `25/12/2024`, where 25 cannot be a
 * month — is accepted without a contract. Refusing it would be pedantry: there
 * is nothing to disambiguate.
 *
 * # Why the output is a string and not a Date
 *
 * A `Date` is an instant, and a fiscal date is a day. Converting between them
 * needs a timezone, and every timezone conversion is a chance for the 17th to
 * become the 16th. Jerusalem is UTC+2/+3, so a `Date` built from local midnight
 * and then serialised as UTC lands on the PREVIOUS day — silently, and only for
 * some readers, which is the worst kind of bug.
 *
 * The canonical value here is therefore `YYYY-MM-DD`: a calendar day, with no
 * instant and no zone to lose. {@link fiscalDateToUtcDate} is the ONE place
 * that turns it into the `Date` Prisma needs, and it pins the instant at UTC
 * midnight so the stored `TIMESTAMP(3)` reads back as the same calendar day.
 *
 * # What this file does NOT decide
 *
 * Whether a date is acceptable as BUSINESS input. A future-dated document is
 * perfectly parseable and probably a mistake; saying so is Analyze's job, and
 * the result below carries `isFuture` precisely so Analyze can warn without
 * re-parsing. Normalization answers "what day is this", validation answers
 * "should we accept it".
 */

/**
 * How textual dates in this file are to be read. Supplied by the owner at
 * mapping time; never inferred from the values.
 *
 *   `DMY`  03/04/2024 is the 3rd of April
 *   `MDY`  03/04/2024 is the 4th of March
 *
 * `null` means the owner has not said. Unambiguous values still parse; genuinely
 * ambiguous ones are refused rather than assumed.
 */
export type DateFormatContract = "DMY" | "MDY" | null;

export type FiscalDateResult =
  | {
      ok: true;
      /** Calendar day, `YYYY-MM-DD`. No time, no zone. */
      value: string;
      /** What the owner's cell held, as text. */
      original: string;
      /** How it was read, for the preview to show back. */
      display: string;
      /** Which rule accepted it. Useful evidence in a preview. */
      source: "excel" | "iso" | "textual";
      /**
       * True when the day is after `today`. NOT an error here — see the module
       * note. Analyze decides whether to warn.
       */
      isFuture: boolean;
    }
  | { ok: false; original: string; reason: string; code: FiscalDateErrorCode };

export type FiscalDateErrorCode =
  | "EMPTY"
  | "AMBIGUOUS_DATE"
  | "UNSUPPORTED_FORMAT"
  | "IMPOSSIBLE_DATE";

/** Text of a cell, whatever the reader handed us. */
function cellText(cell: unknown): string {
  if (cell == null) return "";
  if (cell instanceof Date) return cell.toISOString();
  return String(cell).trim();
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const TEXTUAL = /^(\d{1,2})([/.])(\d{1,2})\2(\d{4})$/;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `2024`,`3`,`17` -> `"2024-03-17"`. */
function format(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Is this a real calendar day?
 *
 * Built from the parts rather than by asking `Date` to normalise them, because
 * `Date` cheerfully turns the 31st of February into the 2nd of March. Leap
 * years are the Gregorian rule in full: 2024 yes, 2100 no, 2000 yes.
 */
export function isRealCalendarDay(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || year < 1900 || year > 2999) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1) return false;

  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= lengths[month - 1];
}

/** Today as a calendar day in Israel, so "future" means what the owner means. */
function israelToday(now: Date): string {
  // `en-CA` renders as YYYY-MM-DD, which is the shape we already use.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Normalize one cell into a fiscal calendar day.
 *
 * @param cell     the raw cell, as the XLSX or CSV reader produced it
 * @param contract how textual `d/m/y` values are to be read, if the owner said
 * @param now      injected so "is this in the future" is testable
 */
export function normalizeFiscalDate(
  cell: unknown,
  contract: DateFormatContract = null,
  now: Date = new Date()
): FiscalDateResult {
  const original = cellText(cell);

  // ── A. A real date cell from XLSX ────────────────────────────────────────
  // ExcelJS hands back a `Date` for a date-formatted cell. Its parts are read
  // in UTC, never locally: the cell means a day, and `getDate()` in a zone
  // behind UTC would report the one before.
  if (cell instanceof Date) {
    if (Number.isNaN(cell.getTime())) {
      return { ok: false, original, reason: "תא התאריך אינו תקין", code: "IMPOSSIBLE_DATE" };
    }
    const year = cell.getUTCFullYear();
    const month = cell.getUTCMonth() + 1;
    const day = cell.getUTCDate();
    if (!isRealCalendarDay(year, month, day)) {
      return { ok: false, original, reason: "תא התאריך אינו תקין", code: "IMPOSSIBLE_DATE" };
    }
    return accept(format(year, month, day), original, "excel", now);
  }

  if (original === "") {
    return { ok: false, original, reason: "תאריך חסר", code: "EMPTY" };
  }

  // ── B. ISO, which says what it means ─────────────────────────────────────
  const iso = ISO.exec(original);
  if (iso) {
    const [, y, m, d] = iso;
    const year = Number(y);
    const month = Number(m);
    const day = Number(d);
    if (!isRealCalendarDay(year, month, day)) {
      return {
        ok: false,
        original,
        reason: "התאריך אינו קיים בלוח השנה",
        code: "IMPOSSIBLE_DATE",
      };
    }
    return accept(format(year, month, day), original, "iso", now);
  }

  // ── C. Textual d/m/y or d.m.y, under the contract ────────────────────────
  const textual = TEXTUAL.exec(original);
  if (!textual) {
    return {
      ok: false,
      original,
      reason: "פורמט תאריך לא נתמך. כתבו 17/03/2024 או 2024-03-17",
      code: "UNSUPPORTED_FORMAT",
    };
  }

  const first = Number(textual[1]);
  const second = Number(textual[3]);
  const year = Number(textual[4]);

  const asDMY = isRealCalendarDay(year, second, first);
  const asMDY = isRealCalendarDay(year, first, second);

  if (!asDMY && !asMDY) {
    return {
      ok: false,
      original,
      reason: "התאריך אינו קיים בלוח השנה",
      code: "IMPOSSIBLE_DATE",
    };
  }

  // The contract decides, when there is one — and only among readings that are
  // real days, so a contract cannot force a 31st of February.
  if (contract === "DMY" && asDMY) {
    return accept(format(year, second, first), original, "textual", now);
  }
  if (contract === "MDY" && asMDY) {
    return accept(format(year, first, second), original, "textual", now);
  }
  if (contract !== null) {
    return {
      ok: false,
      original,
      reason: "התאריך אינו קיים בלוח השנה לפי פורמט התאריך שנבחר",
      code: "IMPOSSIBLE_DATE",
    };
  }

  // No contract. One reading is fine; two is a coin toss we refuse to make.
  if (asDMY && asMDY) {
    return {
      ok: false,
      original,
      reason:
        "לא ברור אם זה יום/חודש או חודש/יום. בחרו את פורמט התאריך של הקובץ, או כתבו 2024-03-17",
      code: "AMBIGUOUS_DATE",
    };
  }
  return asDMY
    ? accept(format(year, second, first), original, "textual", now)
    : accept(format(year, first, second), original, "textual", now);
}

function accept(
  value: string,
  original: string,
  source: "excel" | "iso" | "textual",
  now: Date
): FiscalDateResult {
  const [year, month, day] = value.split("-");
  return {
    ok: true,
    value,
    original,
    // Shown back to the owner in the form they wrote dates in.
    display: `${day}/${month}/${year}`,
    source,
    isFuture: value > israelToday(now),
  };
}

/**
 * The ONE crossing from a fiscal calendar day to the `Date` Prisma stores.
 *
 * `originalIssueDate` is `DateTime?`, which PostgreSQL holds as `TIMESTAMP(3)`
 * — no zone. Prisma serialises a JS `Date` as UTC, so pinning the instant at
 * UTC midnight makes the stored value read back as the same calendar day
 * wherever the reader happens to be. Building the `Date` any other way (local
 * midnight, or `new Date("2024-03-17")` under a runtime that treats it as
 * local) is how a document silently changes day.
 *
 * Nothing in I-8B.1 writes a row. This is the documented boundary that
 * I-8B.4 Execute will use, defined here beside the value it converts.
 */
export function fiscalDateToUtcDate(fiscalDate: string): Date {
  const match = ISO.exec(fiscalDate);
  if (!match) {
    throw new Error(`Not a canonical fiscal date: ${fiscalDate}`);
  }
  const [, y, m, d] = match;
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
}
