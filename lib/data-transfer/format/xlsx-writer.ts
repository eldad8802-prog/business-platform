/**
 * Canonical XLSX writer — the default Dubiz export format.
 *
 * # Why XLSX is the default and not CSV
 *
 * CSV has no encoding, no delimiter and no types: every one of those is a
 * negotiation with whatever the owner opens the file in, and in Hebrew each of
 * them is a way for the file to arrive as gibberish. XLSX carries its own
 * encoding, its own column types and its own sheet direction. The owner opens
 * it and it is simply correct.
 *
 * # What "friendly to a business owner" means here, concretely
 *
 *  - `rightToLeft` on the worksheet view, so column A is on the RIGHT.
 *  - Hebrew column labels, bold, frozen as row 1 while scrolling.
 *  - Real column types: a date is a date, an amount is a number formatted
 *    `#,##0.00`, currency carries the shekel sign. Sorting and SUM work.
 *  - Sensible widths, derived from the label when not given explicitly.
 *  - An auto-filter across the used range when there is data to filter.
 *
 * # Security note
 *
 * XLSX needs NO formula guard. A string written as a cell VALUE stays a string
 * in the sheet — a formula only exists when a cell is written as `{ formula }`,
 * which this writer never does. `"=1+1"` round-trips as the four characters,
 * not as `2`. That is asserted in the verifier so a future edit cannot quietly
 * introduce formula cells from untrusted values.
 *
 * The Accountant Export (`lib/reports/accountant-export-zip.ts`) deliberately
 * keeps its own bespoke sheet builder: it emits SUMIF total rows that are not a
 * generic table feature, and rewriting it here would change a shipped fiscal
 * artifact for no benefit. This writer is for the new Import/Export Center.
 */

import ExcelJS from "exceljs";
import type { SheetCell } from "./table.types";

/**
 * How a column should be TYPED in the sheet. This is presentation + cell type,
 * not validation: the domain layer decides what a value means, this decides how
 * the spreadsheet stores and shows it.
 */
export type XlsxColumnType =
  | "text"
  | "integer"
  | "number"
  | "currency"
  | "date"
  | "datetime";

export type XlsxColumn = {
  /** Owner-facing label. Hebrew — never an internal/Prisma field name. */
  header: string;
  /** Explicit width in characters. Derived from the label when omitted. */
  width?: number;
  /** Cell type. Defaults to `"text"`. */
  type?: XlsxColumnType;
};

export type XlsxSheetSpec = {
  /** Worksheet name. Excel forbids `[]:*?/\` and caps the name at 31 chars. */
  name: string;
  columns: readonly XlsxColumn[];
  rows: readonly (readonly SheetCell[])[];
  /** Right-to-left sheet view. Default `true` (Dubiz is Hebrew-first). */
  rightToLeft?: boolean;
  /** Auto-filter across the used range when there is at least one data row. */
  autoFilter?: boolean;
  /** Freeze the header row. Default `true`. */
  freezeHeader?: boolean;
};

/** Number formats, one place. `he-IL` conventions. */
const NUM_FMT: Record<XlsxColumnType, string | null> = {
  text: null,
  integer: "#,##0",
  number: "#,##0.00",
  currency: '#,##0.00 "₪"',
  date: "dd/mm/yyyy",
  datetime: "dd/mm/yyyy hh:mm",
};

const MIN_WIDTH = 10;
const MAX_WIDTH = 50;

/** Excel rejects these characters in a sheet name and caps it at 31 chars. */
export function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[[\]:*?/\\]/g, " ").trim();
  const safe = cleaned.length > 0 ? cleaned : "Sheet1";
  return safe.slice(0, 31);
}

function resolveWidth(column: XlsxColumn): number {
  if (typeof column.width === "number" && column.width > 0) {
    return Math.min(column.width, MAX_WIDTH);
  }
  // Hebrew labels render wider than their character count suggests; the +4 is
  // padding so a bold header is never clipped by its own filter arrow.
  return Math.min(Math.max(column.header.length + 4, MIN_WIDTH), MAX_WIDTH);
}

/**
 * Coerce one value into what ExcelJS should store.
 *
 * A `null` stays an empty cell rather than the text "null". A numeric column
 * that receives a non-numeric string keeps the STRING — silently writing 0 or
 * NaN would fabricate data, and a visibly wrong cell is recoverable while a
 * fabricated zero is not.
 */
function toCellValue(
  value: SheetCell,
  type: XlsxColumnType
): ExcelJS.CellValue {
  if (value == null || value === "") return null;

  if (type === "date" || type === "datetime") {
    if (value instanceof Date) return value;
    return value as ExcelJS.CellValue;
  }

  if (type === "integer" || type === "number" || type === "currency") {
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      return Number.isFinite(parsed) && value.trim() !== "" ? parsed : value;
    }
    return value as ExcelJS.CellValue;
  }

  if (value instanceof Date) return value;
  return value as ExcelJS.CellValue;
}

function addSheet(workbook: ExcelJS.Workbook, spec: XlsxSheetSpec): void {
  const rightToLeft = spec.rightToLeft ?? true;
  const freezeHeader = spec.freezeHeader ?? true;

  const worksheet = workbook.addWorksheet(sanitizeSheetName(spec.name), {
    views: [
      freezeHeader
        ? { rightToLeft, state: "frozen", xSplit: 0, ySplit: 1 }
        : { rightToLeft },
    ],
  });

  spec.columns.forEach((column, index) => {
    worksheet.getColumn(index + 1).width = resolveWidth(column);
  });

  const headerRow = worksheet.getRow(1);
  spec.columns.forEach((column, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = column.header;
    cell.font = { bold: true };
  });
  headerRow.commit();

  spec.rows.forEach((row, rowIndex) => {
    const sheetRow = worksheet.getRow(rowIndex + 2);
    spec.columns.forEach((column, colIndex) => {
      const type = column.type ?? "text";
      const cell = sheetRow.getCell(colIndex + 1);
      cell.value = toCellValue(row[colIndex] ?? null, type);
      const fmt = NUM_FMT[type];
      // Only format when the cell actually holds the type it was declared as —
      // a date format on a leftover string renders as a confusing artefact.
      if (fmt && cell.value != null && typeof cell.value !== "string") {
        cell.numFmt = fmt;
      }
    });
    sheetRow.commit();
  });

  const autoFilter = spec.autoFilter ?? true;
  if (autoFilter && spec.rows.length > 0 && spec.columns.length > 0) {
    worksheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: spec.rows.length + 1, column: spec.columns.length },
    };
  }
}

/** Build a workbook (one or more sheets) as an in-memory XLSX buffer. */
export async function buildXlsxBuffer(
  sheets: XlsxSheetSpec | readonly XlsxSheetSpec[]
): Promise<Buffer> {
  const specs = Array.isArray(sheets)
    ? (sheets as readonly XlsxSheetSpec[])
    : [sheets as XlsxSheetSpec];

  const workbook = new ExcelJS.Workbook();
  for (const spec of specs) {
    addSheet(workbook, spec);
  }

  const written = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(written) ? written : Buffer.from(written);
}
