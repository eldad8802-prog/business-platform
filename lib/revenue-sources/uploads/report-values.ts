/**
 * Revenue report uploads — reading one printed value (an amount, a date) the way every parser must: exactly, or not
 * at all. docs/revenue-report-uploads.md "Reading values"
 *
 * Format-independent on purpose: no vendor is known yet (the registry ships empty), so nothing here guesses a
 * vendor's layout. A parser states what its export uses (the decimal mark, the date order) and these helpers refuse
 * anything that does not fit, with a code — never a best guess. Money is integer minor units (bigint), never a float.
 *
 * Pure: no database, no network, no clock.
 */
import { isCalendarDay } from "./core";

export type AmountRead = { ok: true; minor: bigint; negative: boolean } | { ok: false; code: AmountReadError };
export type AmountReadError = "EMPTY" | "NOT_A_NUMBER" | "TOO_MANY_DECIMALS" | "SEPARATOR_MISMATCH" | "TOO_LARGE";

export type AmountFormat = {
  /** The export's decimal mark. "." → "1,234.50"; "," → "1.234,50". Never inferred. */
  decimal: "." | ",";
};

/** Same ceiling as the store (core.ts MAX_MINOR): 10^15 minor units. */
const MAX_MINOR = BigInt("1000000000000000");

/** Currency marks, direction marks and spaces a printed amount may carry around its digits. */
const NOISE = /[\s ‎‏‪-‮₪$€]|ש["״']ח|\bNIS\b|\bILS\b|\bUSD\b|\bEUR\b/gi;

/**
 * One printed amount → minor units.
 * Sign: a leading or trailing minus (also "−" U+2212) or parentheses. Thousands marks must sit in groups of three;
 * at most two decimals. "12,50" with decimal "." is refused (SEPARATOR_MISMATCH) — never read as 1250 or 12.5.
 */
export function readAmount(raw: unknown, format: AmountFormat = { decimal: "." }): AmountRead {
  if (typeof raw !== "string" && typeof raw !== "number") return { ok: false, code: "EMPTY" };
  let s = String(raw).replace(NOISE, "").replace(/−/g, "-");
  if (s === "") return { ok: false, code: "EMPTY" };

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1);
  } else if (s.startsWith("+")) s = s.slice(1);
  if (s === "") return { ok: false, code: "NOT_A_NUMBER" };

  const thousands = format.decimal === "." ? "," : ".";
  const parts = s.split(format.decimal);
  if (parts.length > 2) return { ok: false, code: "SEPARATOR_MISMATCH" };
  const [whole, frac = ""] = parts;
  if (frac.includes(thousands)) return { ok: false, code: "SEPARATOR_MISMATCH" };
  if (!/^\d*$/.test(frac)) return { ok: false, code: "NOT_A_NUMBER" };
  if (frac.length > 2) return { ok: false, code: "TOO_MANY_DECIMALS" };
  if (parts.length === 2 && frac.length === 0) return { ok: false, code: "NOT_A_NUMBER" };

  let digits: string;
  if (whole.includes(thousands)) {
    const re = thousands === "," ? /^\d{1,3}(?:,\d{3})+$/ : /^\d{1,3}(?:\.\d{3})+$/;
    if (!re.test(whole)) return { ok: false, code: "SEPARATOR_MISMATCH" };
    digits = whole.split(thousands).join("");
  } else {
    if (!/^\d+$/.test(whole) && !(whole === "" && frac !== "")) return { ok: false, code: "NOT_A_NUMBER" };
    digits = whole === "" ? "0" : whole;
  }

  const minor = BigInt(digits) * BigInt(100) + BigInt((frac + "00").slice(0, 2));
  if (minor > MAX_MINOR) return { ok: false, code: "TOO_LARGE" };
  return { ok: true, minor: negative ? -minor : minor, negative };
}

/**
 * A deduction line (refund / void / discount / fee) as the contract stores it: a magnitude (≥ 0). Reports print
 * these both ways ("150.00" and "-150.00"); either is the same deduction. The draft's own total check
 * (total = gross − discount − refund − void; net = gross − fee − other) is what catches a column read the wrong way.
 */
export function asDeduction(read: AmountRead): AmountRead {
  if (!read.ok) return read;
  return { ok: true, minor: read.minor < BigInt(0) ? -read.minor : read.minor, negative: read.negative };
}

export type DateRead = { ok: true; day: string; time: string | null } | { ok: false; code: DateReadError };
export type DateReadError = "EMPTY" | "NOT_A_DATE" | "NOT_A_CALENDAR_DAY";

export type DateFormat = {
  /** The export's order. Israeli exports print day first; "YMD" is ISO. Month-first (US) is never read. */
  order: "DMY" | "YMD";
};

/**
 * One printed date (optionally followed by a time) → YYYY-MM-DD as printed. Separators "/", ".", "-".
 * A two-digit year is 20YY. The time, if printed, is returned as written (HH:MM or HH:MM:SS) and never moves the day:
 * the owner decided (D-10, 2026-11-03) that a Z belongs to the business day PRINTED in it — no cut-off hour; when the
 * report prints no day, the owner is asked (core.ts resolveZDrafts).
 */
export function readDate(raw: unknown, format: DateFormat = { order: "DMY" }): DateRead {
  if (typeof raw !== "string") return { ok: false, code: "EMPTY" };
  const s = raw.replace(/[‎‏‪-‮]/g, "").trim();
  if (s === "") return { ok: false, code: "EMPTY" };

  const m = /^(\d{1,4})([./-])(\d{1,2})\2(\d{2,4})(?:[ T,]+(\d{1,2}:\d{2}(?::\d{2})?))?$/.exec(s);
  if (!m) return { ok: false, code: "NOT_A_DATE" };
  const [, a, , b, c, time] = m;
  let y: string;
  let mo: string;
  let d: string;
  if (format.order === "YMD") {
    if (a.length !== 4) return { ok: false, code: "NOT_A_DATE" };
    [y, mo, d] = [a, b, c];
  } else {
    if (a.length > 2 || (c.length !== 2 && c.length !== 4)) return { ok: false, code: "NOT_A_DATE" };
    [d, mo, y] = [a, b, c.length === 2 ? `20${c}` : c];
  }
  const day = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  if (!isCalendarDay(day)) return { ok: false, code: "NOT_A_CALENDAR_DAY" };
  if (time) {
    const [hh, mm, ss = 0] = time.split(":").map(Number);
    if (hh > 23 || mm > 59 || ss > 59) return { ok: false, code: "NOT_A_DATE" };
  }
  return { ok: true, day, time: time ?? null };
}

/**
 * Tenders and VAT lines against the printed total — the cross-check a sample's fixture test must pass before a parser
 * ships. Returns the difference in minor units (0 = the lines add up). Never adjusts anything.
 */
export function linesDifference(totalMinor: bigint, lineMinors: readonly bigint[]): bigint {
  return lineMinors.reduce((sum, v) => sum + v, BigInt(0)) - totalMinor;
}
