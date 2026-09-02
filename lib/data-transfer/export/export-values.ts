/**
 * Value formatting shared by every export descriptor.
 *
 * The rule these helpers exist to enforce: a spreadsheet cell should hold the
 * thing the owner would have typed. A date is a date (so it sorts and filters),
 * an amount is a number (so it sums), a status is a Hebrew word (so it reads),
 * and "not set" is an EMPTY cell — never the string "null", never 0, never a
 * dash that a later import would try to parse back into a value.
 */

import type { SheetCell } from "@/lib/data-transfer/format/table.types";

/** Text, or an empty cell when there is nothing. Never "null"/"undefined". */
export function text(value: string | null | undefined): SheetCell {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * A number, or an empty cell.
 *
 * `0` is preserved: a stock level of zero is a fact, and blanking it would tell
 * the owner "unknown" when the truth is "none left".
 */
export function num(value: number | null | undefined): SheetCell {
  if (value == null || !Number.isFinite(value)) return null;
  return value;
}

/** A real Date cell (so the spreadsheet can sort/filter), or empty. */
export function date(value: Date | null | undefined): SheetCell {
  if (!value) return null;
  const time = value.getTime();
  return Number.isFinite(time) ? value : null;
}

/**
 * Yes/no as Hebrew words.
 *
 * TRUE/FALSE would be a developer's answer, and a raw boolean renders as
 * "TRUE" in Excel regardless of locale.
 */
export function yesNo(value: boolean | null | undefined): SheetCell {
  if (value == null) return null;
  return value ? "כן" : "לא";
}

/**
 * Translate an internal enum to its Hebrew label.
 *
 * An unmapped value falls through to the raw code rather than to an empty
 * cell: silently blanking a value the owner has in their data is worse than
 * showing them a code they can ask about, and it makes a missing label
 * obvious instead of invisible.
 */
export function label<T extends string>(
  value: T | null | undefined,
  labels: Record<string, string>
): SheetCell {
  if (value == null) return null;
  return labels[value] ?? value;
}
