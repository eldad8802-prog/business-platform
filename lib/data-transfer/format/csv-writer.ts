/**
 * Canonical CSV writer — the single place Dubiz turns tabular data into a
 * .csv byte stream.
 *
 * # Why this file exists
 *
 * The Accountant Export already proved the three things an Israeli business
 * owner needs from a CSV: a UTF-8 BOM (so Excel does not mangle Hebrew), a
 * semicolon separator with the `sep=;` directive (so Excel he-IL splits the
 * columns), and CRLF line endings. That logic lived inline in
 * `lib/reports/accountant-export-zip.ts` and could not be reused. It is
 * extracted here verbatim in behaviour, with ONE security fix (below).
 *
 * # SECURITY: CSV / formula injection
 *
 * A spreadsheet application treats a cell whose text begins with `=`, `+`, `-`,
 * `@`, TAB or CR as a FORMULA, not as text — even when the field is quoted.
 * Quoting is a CSV-parsing rule; it is not a formula-evaluation rule. So a
 * customer named `=HYPERLINK("http://evil","click")`, or an OCR'd vendor name
 * beginning with `@`, becomes executable content the moment the owner opens
 * the export. The previous `escapeCsvField` quoted but did not neutralize.
 *
 * The fix: a value that STARTS with a trigger character is prefixed with a
 * single apostrophe (`'`), the standard "treat as text" marker every major
 * spreadsheet honours and hides in the cell display.
 *
 * The one exemption is deliberate and load-bearing: a value that is a PLAIN
 * NUMBER is never guarded. Without it every negative amount (`-187.77`) in a
 * financial export would be rewritten to `'-187.77` and stop being a number in
 * the accountant's spreadsheet — turning a security fix into a data-integrity
 * bug. `-` alone is NOT a plain number and IS guarded (it is rare, and `-2+3`
 * is a real formula).
 *
 * Round-trip note: {@link readCsvTable} does NOT strip the apostrophe. A value
 * that legitimately starts with `=` is vanishingly rare, while silent stripping
 * would corrupt any value that legitimately starts with `'`. The guard is
 * therefore visible and lossless-by-inspection rather than invisible and
 * ambiguous.
 */

import type { CsvDelimiter } from "./table.types";

/** UTF-8 byte-order mark. Excel needs it to read Hebrew CSV as UTF-8. */
export const UTF8_BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf]);

/** Marker prefix that forces a spreadsheet to treat a cell as literal text. */
export const CSV_FORMULA_GUARD_PREFIX = "'";

/**
 * Leading characters that make a spreadsheet evaluate a cell as a formula.
 * TAB and CR are included: both are legal inside a quoted CSV field and both
 * are stripped by Excel before the leading-character test, which is exactly
 * how a `\t=cmd` payload slips past a naive `=`-only check.
 */
export const CSV_FORMULA_TRIGGER_CHARS: readonly string[] = [
  "=",
  "+",
  "-",
  "@",
  "\t",
  "\r",
];

/** A value that is entirely a number — the ONE exemption from the guard. */
const PLAIN_NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export type CsvWriteOptions = {
  /** Column separator. Default `";"` — the proven Excel he-IL behaviour. */
  delimiter?: CsvDelimiter;
  /** Emit a leading `sep=<delimiter>` line for Excel. Default `true`. */
  excelSepDirective?: boolean;
  /** Line ending. Default `"\r\n"` (RFC 4180). */
  eol?: "\r\n" | "\n";
};

type ResolvedCsvWriteOptions = Required<CsvWriteOptions>;

function resolveOptions(options?: CsvWriteOptions): ResolvedCsvWriteOptions {
  return {
    delimiter: options?.delimiter ?? ";",
    excelSepDirective: options?.excelSepDirective ?? true,
    eol: options?.eol ?? "\r\n",
  };
}

/** True when `value` would be evaluated as a formula by a spreadsheet. */
export function needsCsvFormulaGuard(value: string): boolean {
  if (value.length === 0) return false;
  if (!CSV_FORMULA_TRIGGER_CHARS.includes(value[0])) return false;
  // A plain number is data, not a formula. Guarding it would break every
  // negative amount in a financial export.
  if (PLAIN_NUMBER.test(value)) return false;
  return true;
}

/** Neutralize a formula-triggering value. Returns non-triggering values as-is. */
export function guardCsvFormula(value: string): string {
  return needsCsvFormulaGuard(value)
    ? CSV_FORMULA_GUARD_PREFIX + value
    : value;
}

/**
 * Render one value as a CSV field: formula-guarded, then ALWAYS quoted with
 * `""` escaping. Always-quoting is intentional — it makes embedded delimiters,
 * quotes and newlines a non-question, and it is byte-identical to what the
 * Accountant Export already emitted.
 */
export function escapeCsvField(value: unknown): string {
  const raw = value == null ? "" : String(value);
  const guarded = guardCsvFormula(raw);
  return `"${guarded.replace(/"/g, '""')}"`;
}

/** Render a single row of values as one CSV line (no line ending). */
export function writeCsvRow(
  values: readonly unknown[],
  options?: CsvWriteOptions
): string {
  const { delimiter } = resolveOptions(options);
  return values.map(escapeCsvField).join(delimiter);
}

/**
 * Render a full CSV document as text. No trailing line ending — callers that
 * need one append it, and this preserves the exact Accountant Export bytes.
 */
export function writeCsvText(
  headers: readonly unknown[],
  rows: readonly (readonly unknown[])[],
  options?: CsvWriteOptions
): string {
  const resolved = resolveOptions(options);
  const lines: string[] = [];
  if (resolved.excelSepDirective) {
    lines.push(`sep=${resolved.delimiter}`);
  }
  lines.push(writeCsvRow(headers, resolved));
  for (const row of rows) {
    lines.push(writeCsvRow(row, resolved));
  }
  return lines.join(resolved.eol);
}

/** Render a full CSV document as UTF-8 bytes, BOM first. */
export function writeCsvBuffer(
  headers: readonly unknown[],
  rows: readonly (readonly unknown[])[],
  options?: CsvWriteOptions
): Buffer {
  return Buffer.concat([
    UTF8_BOM_BYTES,
    Buffer.from(writeCsvText(headers, rows, options), "utf8"),
  ]);
}
