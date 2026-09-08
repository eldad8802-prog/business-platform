/**
 * Decimal-safe money normalization for historical import.
 *
 * # Why the existing number normalizer is not enough here
 *
 * `normalizeNumber` in the tabular import returns a JavaScript `number`, and
 * for an inventory cost that is fine. For a fiscal amount it is not: binary
 * floating point cannot hold `0.1`, `1170.35` or `8005.05` exactly, and the
 * error appears at the two-decimal boundary that fiscal arithmetic is made of.
 * `0.1 + 0.2` is the famous one; `1170.35 * 100` is `117034.99999999999`, which
 * is how a rounded amount arrives one agora short.
 *
 * The column is `Decimal(18,2)`. So the canonical value here is a DECIMAL
 * STRING, and the parsing is done by `Prisma.Decimal` — the same library
 * `billing-authority-approval-payload.ts` already uses to validate fiscal
 * amounts before they reach the Tax Authority. No `Number()`, no `parseFloat`,
 * no arithmetic in JavaScript numbers anywhere in this file.
 *
 * # What is accepted, and what is refused
 *
 * Accepted, because real exports contain them:
 *
 *     1170        1170.00      1,170.00      ₪1,170.00      1,170.00 ₪
 *     -117.00     0            0.00          +7.50
 *
 * Refused, on purpose:
 *
 *   `1,50`   Some European exports mean one and a half; some mean a hundred and
 *            fifty. Nothing in the value says which, and being wrong is a
 *            factor of a hundred on an invoice. This is the same refusal
 *            `normalizeNumber` already makes, kept identical so the two
 *            surfaces cannot disagree.
 *
 *   `1170.355`  More than two decimals. The column holds two, so accepting this
 *            means CHANGING a number the source recorded. Historical import
 *            copies what another system says; it does not round it into shape.
 *            An owner who meant 1170.36 can write 1170.36.
 *
 * # Sign, and why it is preserved exactly
 *
 * A credit note may arrive positive (the type carries the meaning) or negative
 * (the sign carries it). Both are real conventions and this file takes no view:
 * `-117.00` stays `-117.00`, `117.00` stays `117.00`. Deciding what a sign
 * means on a credit is Analyze's business, with the owner watching.
 *
 * `-0` is not a fiscal quantity. It normalises to `0.00`, which is the same
 * amount written the way every reader agrees on.
 */

import { Prisma } from "@prisma/client";

/** What `Decimal(18,2)` can actually hold: 16 integer digits and 2 decimals. */
export const MONEY_MAX_INTEGER_DIGITS = 16;
export const MONEY_DECIMAL_PLACES = 2;

export type FiscalAmountResult =
  | {
      ok: true;
      /** Canonical decimal string, always with exactly two decimals. */
      value: string;
      /** What the owner's cell held, as text. */
      original: string;
      /** Grouped for reading back in a preview: `1,170.00`. */
      display: string;
    }
  | { ok: false; original: string; reason: string; code: FiscalAmountErrorCode };

export type FiscalAmountErrorCode =
  | "EMPTY"
  | "AMBIGUOUS_DECIMAL_COMMA"
  | "NOT_A_NUMBER"
  | "TOO_MANY_DECIMALS"
  | "OUT_OF_RANGE";

const SHEKEL = /[₪]/g;
const THOUSANDS = /,/g;
/** Optional sign, digits, optional dot and digits. Nothing else. */
const NUMERIC = /^[+-]?(\d+(\.\d+)?|\.\d+)$/;
/** The classic European decimal comma: one comma, no dot, exactly two digits. */
const EUROPEAN_COMMA = /^[+-]?\d+,\d{2}$/;

function cellText(cell: unknown): string {
  if (cell == null) return "";
  if (cell instanceof Date) return cell.toISOString();
  return String(cell).trim();
}

/** `1170.00` -> `1,170.00`. Grouping only; the digits are never touched. */
function group(canonical: string): string {
  const negative = canonical.startsWith("-");
  const bare = negative ? canonical.slice(1) : canonical;
  const [whole, fraction] = bare.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}.${fraction}`;
}

/**
 * Normalize one cell into a fiscal amount.
 *
 * A blank cell is `ok` with a `null`-shaped absence expressed by the caller:
 * this function refuses it with `EMPTY` and the field contract decides whether
 * absence is allowed, because "may this be blank" is a contract question and
 * not a parsing one.
 */
export function normalizeFiscalAmount(cell: unknown): FiscalAmountResult {
  // A numeric XLSX cell is already a number, and by the time it reached us the
  // reader has ALREADY put it through binary floating point. Rendering it back
  // to text is the closest honest reading of what the sheet held; `toFixed`
  // would hide a value that had more precision than the column can carry.
  const original =
    typeof cell === "number" && Number.isFinite(cell) ? String(cell) : cellText(cell);

  if (original === "") {
    return { ok: false, original, reason: "סכום חסר", code: "EMPTY" };
  }

  const stripped = original.replace(SHEKEL, "").trim();

  if (EUROPEAN_COMMA.test(stripped) && !stripped.includes(".")) {
    return {
      ok: false,
      original,
      reason: 'לא ברור אם הפסיק הוא נקודה עשרונית. כתבו 1234.50 עם נקודה',
      code: "AMBIGUOUS_DECIMAL_COMMA",
    };
  }

  const cleaned = stripped.replace(THOUSANDS, "");
  if (!NUMERIC.test(cleaned)) {
    return { ok: false, original, reason: "לא סכום תקין", code: "NOT_A_NUMBER" };
  }

  let decimal: Prisma.Decimal;
  try {
    decimal = new Prisma.Decimal(cleaned);
  } catch {
    return { ok: false, original, reason: "לא סכום תקין", code: "NOT_A_NUMBER" };
  }
  if (!decimal.isFinite()) {
    return { ok: false, original, reason: "לא סכום תקין", code: "NOT_A_NUMBER" };
  }

  if (decimal.decimalPlaces() > MONEY_DECIMAL_PLACES) {
    return {
      ok: false,
      original,
      reason: "סכום עם יותר משתי ספרות אחרי הנקודה. תקנו את הערך במקור",
      code: "TOO_MANY_DECIMALS",
    };
  }

  // 16 integer digits is what Decimal(18,2) leaves once the scale is taken.
  // Measured on the absolute value so the sign is not counted as a digit.
  const integerDigits = decimal.abs().truncated().toFixed(0);
  if (integerDigits !== "0" && integerDigits.length > MONEY_MAX_INTEGER_DIGITS) {
    return {
      ok: false,
      original,
      reason: "הסכום גדול מדי",
      code: "OUT_OF_RANGE",
    };
  }

  // Exactly two decimals, and never a negative zero: -0.00 and 0.00 are the
  // same amount, and only one of them is a number a person would write.
  let value = decimal.toFixed(MONEY_DECIMAL_PLACES);
  if (value === "-0.00") value = "0.00";

  return { ok: true, value, original, display: group(value) };
}

/**
 * The ONE crossing from a canonical amount to what Prisma writes.
 *
 * `Prisma.Decimal` accepts the decimal string exactly, so the value that
 * reaches `Decimal(18,2)` is the value the owner's file held — no float ever
 * sits between them. Nothing in I-8B.1 writes a row; this is the documented
 * boundary I-8B.4 Execute will use.
 */
export function fiscalAmountToDecimal(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}
