/**
 * Cell -> domain value, with the evidence kept.
 *
 * Every normalizer returns BOTH what the owner wrote and what Dubiz would
 * store. The preview shows the pair, because "050-123-4567 → 972501234567" is
 * the difference between an owner trusting the import and an owner wondering
 * what happened to their phone numbers.
 *
 * # Nothing here writes, and nothing here guesses
 *
 * A value that cannot be read deterministically is returned as an ERROR with a
 * reason, never as a best guess. The rule that matters most:
 *
 *   A comma is only ever a THOUSANDS separator, never a decimal separator.
 *
 * "1,234" is one thousand two hundred and thirty four. Some European exports
 * mean 1.234 by that, and there is no way to tell from the value alone — so the
 * template states the contract (dot for decimals) and anything that would need
 * the other reading is refused rather than silently halved or multiplied by a
 * thousand.
 */

import { normalizeCustomerPhone } from "@/lib/services/integrations/whatsapp/phone";
import { formatPhoneForDisplay } from "@/lib/format/phone-display";

/** What a normalizer produces: a value, or a refusal with a reason. */
export type NormalizeResult<T> =
  | { ok: true; value: T; original: string; display: string }
  | { ok: false; original: string; reason: string };

/** Raw cell -> the text the owner actually typed. Never null. */
export function cellText(cell: unknown): string {
  if (cell == null) return "";
  if (cell instanceof Date) return cell.toISOString();
  return String(cell).trim();
}

/** True when the cell holds nothing at all. */
export function isBlank(cell: unknown): boolean {
  return cellText(cell).length === 0;
}

/* --------------------------------------------------------------- text --- */

export function normalizeText(cell: unknown, max: number): NormalizeResult<string | null> {
  const original = cellText(cell);
  if (original === "") {
    return { ok: true, value: null, original, display: "" };
  }
  if (original.length > max) {
    return {
      ok: false,
      original,
      reason: `הערך ארוך מדי (עד ${max} תווים)`,
    };
  }
  return { ok: true, value: original, original, display: original };
}

/* -------------------------------------------------------------- phone --- */

/**
 * Canonicalizes through the SAME function every Customer write uses, so the
 * preview cannot promise a value the importer would store differently. The
 * display form is the readable one the rest of Dubiz shows.
 */
export function normalizePhone(cell: unknown): NormalizeResult<string | null> {
  const original = cellText(cell);
  if (original === "") {
    return { ok: true, value: null, original, display: "" };
  }
  const canonical = normalizeCustomerPhone(original);
  if (canonical === null) {
    return {
      ok: false,
      original,
      reason: "מספר טלפון קצר או לא תקין",
    };
  }
  return {
    ok: true,
    value: canonical,
    original,
    display: formatPhoneForDisplay(canonical),
  };
}

/* -------------------------------------------------------------- email --- */

/**
 * The same pragmatic shape the Leads domain already enforces: something before
 * an `@`, a dotted domain after it, no whitespace, no second `@`. Deliberately
 * not RFC 5322 — the job is to catch "not-an-email", not to litigate the grammar.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function normalizeEmail(cell: unknown, max: number): NormalizeResult<string | null> {
  const original = cellText(cell);
  if (original === "") {
    return { ok: true, value: null, original, display: "" };
  }
  if (original.length > max) {
    return { ok: false, original, reason: `הערך ארוך מדי (עד ${max} תווים)` };
  }
  if (!EMAIL_SHAPE.test(original)) {
    return { ok: false, original, reason: "כתובת אימייל לא תקינה" };
  }
  return { ok: true, value: original, original, display: original };
}

/* ------------------------------------------------------------- number --- */

/** Currency marks and separators that carry no numeric meaning. */
const SHEKEL = /[₪]/g;
const THOUSANDS = /,/g;

/**
 * Accepts the forms the template promises:
 *   1234.50   1,234.50   1,234   ₪1,234.50   1,234.50 ₪   -50   +7
 *
 * REFUSES anything where a comma would have to be a decimal separator
 * ("1,50" with no dot and exactly two trailing digits is the classic European
 * form) — silently reading it either way is a factor-of-1000 error in an
 * inventory cost.
 */
export function normalizeNumber(cell: unknown): NormalizeResult<number | null> {
  if (typeof cell === "number" && Number.isFinite(cell)) {
    const original = String(cell);
    return { ok: true, value: cell, original, display: original };
  }

  const original = cellText(cell);
  if (original === "") {
    return { ok: true, value: null, original, display: "" };
  }

  const stripped = original.replace(SHEKEL, "").trim();

  // Ambiguous European decimal comma: exactly one comma, no dot, and two
  // digits after it. Could be 1.5 or 150 — refuse rather than pick.
  if (/^[+-]?\d+,\d{2}$/.test(stripped) && !stripped.includes(".")) {
    return {
      ok: false,
      original,
      reason: 'לא ברור אם הפסיק הוא נקודה עשרונית. כתבו 1234.50 עם נקודה',
    };
  }

  const cleaned = stripped.replace(THOUSANDS, "");
  if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(cleaned)) {
    return { ok: false, original, reason: "לא מספר תקין" };
  }

  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) {
    return { ok: false, original, reason: "לא מספר תקין" };
  }

  return { ok: true, value: parsed, original, display: String(parsed) };
}

/** A number that must not be negative (quantities, prices, day counts). */
export function normalizeNonNegativeNumber(
  cell: unknown
): NormalizeResult<number | null> {
  const result = normalizeNumber(cell);
  if (!result.ok || result.value === null) return result;
  if (result.value < 0) {
    return { ok: false, original: result.original, reason: "הערך אינו יכול להיות שלילי" };
  }
  return result;
}

/** A whole, non-negative number (payment terms in days, lead time in days). */
export function normalizeNonNegativeInteger(
  cell: unknown
): NormalizeResult<number | null> {
  const result = normalizeNonNegativeNumber(cell);
  if (!result.ok || result.value === null) return result;
  if (!Number.isInteger(result.value)) {
    return { ok: false, original: result.original, reason: "נדרש מספר שלם" };
  }
  return result;
}

/* -------------------------------------------------- controlled values --- */

/**
 * Match a Hebrew business value against the allowed vocabulary. Case- and
 * whitespace-insensitive; nothing fuzzier, because picking the "closest" status
 * is exactly the kind of guess that silently mislabels a record.
 */
export function normalizeEnum(
  cell: unknown,
  allowed: readonly string[]
): NormalizeResult<string | null> {
  const original = cellText(cell);
  if (original === "") {
    return { ok: true, value: null, original, display: "" };
  }
  const needle = original.replace(/\s+/g, " ").trim().toLowerCase();
  const hit = allowed.find(
    (a) => a.replace(/\s+/g, " ").trim().toLowerCase() === needle
  );
  if (!hit) {
    return {
      ok: false,
      original,
      reason: `ערך לא מוכר. הערכים המותרים: ${allowed.join(" · ")}`,
    };
  }
  return { ok: true, value: hit, original, display: hit };
}
