/**
 * Canonical XLSX reader.
 *
 * An owner migrating from another system almost always has an .xlsx, not a
 * .csv — "export to Excel" is the button every competitor ships. Until now the
 * platform could WRITE xlsx (the Accountant Export) but could not READ one at
 * all, so the Import Center would have forced every owner through a manual
 * "save as CSV" step and inherited every encoding problem that comes with it.
 *
 * # The real work here is cell coercion
 *
 * ExcelJS does not hand back primitives. A single cell can arrive as a number,
 * a string, a Date, a boolean, a rich-text object, a hyperlink object, a
 * formula object carrying its cached result, a shared-formula object, or an
 * error object. Feeding any of those straight into the mapping layer would
 * produce `[object Object]` in the owner's preview. {@link normalizeCellValue}
 * is the one place that is resolved.
 *
 * A FORMULA cell is read as its cached RESULT, never as its formula text: the
 * owner's intent is the value they see in Excel. An ERROR cell (`#REF!`,
 * `#DIV/0!`) becomes `null` — an unreadable value is missing data, and the
 * preview must show it as missing rather than as the literal text of an error.
 */

import ExcelJS from "exceljs";
import type { SheetCell, SheetTable } from "./table.types";

type RichTextValue = { richText: Array<{ text?: unknown }> };
type FormulaValue = { formula?: unknown; sharedFormula?: unknown; result?: unknown };
type HyperlinkValue = { hyperlink?: unknown; text?: unknown };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Reduce any ExcelJS cell value to a {@link SheetCell}. */
export function normalizeCellValue(value: unknown): SheetCell {
  if (value == null) return null;

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (value instanceof Date) return value;

  if (isObject(value)) {
    // An error cell is missing data, not the text "#REF!".
    if ("error" in value) return null;

    // Formula (or shared formula): the owner's value is the cached result.
    if ("formula" in value || "sharedFormula" in value) {
      const formula = value as FormulaValue;
      return "result" in formula ? normalizeCellValue(formula.result) : null;
    }

    if ("richText" in value && Array.isArray((value as RichTextValue).richText)) {
      return (value as RichTextValue).richText
        .map((run) => (typeof run?.text === "string" ? run.text : ""))
        .join("");
    }

    if ("hyperlink" in value) {
      const link = value as HyperlinkValue;
      if (typeof link.text === "string") return link.text;
      return typeof link.hyperlink === "string" ? link.hyperlink : null;
    }
  }

  // Anything unforeseen becomes text rather than leaking an object shape.
  return String(value);
}

export type ReadXlsxOptions = {
  /** Read this worksheet by name. Defaults to the first non-hidden sheet. */
  sheetName?: string;
  /**
   * Maximum DATA rows to materialize (header excluded). Reaching it sets
   * `truncated` on the result — the read stops, it never throws.
   */
  maxRows?: number;
};

function pickWorksheet(
  workbook: ExcelJS.Workbook,
  sheetName?: string
): ExcelJS.Worksheet | null {
  if (sheetName) {
    return workbook.getWorksheet(sheetName) ?? null;
  }
  // A hidden sheet is usually scaffolding (lookup lists, pivot cache); the
  // owner means the sheet they were looking at.
  const visible = workbook.worksheets.find((ws) => ws.state === "visible");
  return visible ?? workbook.worksheets[0] ?? null;
}

/** Read an XLSX buffer into the canonical {@link SheetTable}. */
export async function readXlsxTable(
  buffer: Buffer,
  options?: ReadXlsxOptions
): Promise<SheetTable> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const worksheet = pickWorksheet(workbook, options?.sheetName);
  const empty: SheetTable = {
    sheetName: worksheet?.name ?? null,
    headers: [],
    rows: [],
    truncated: false,
    delimiter: null,
    encoding: null,
  };
  if (!worksheet) return empty;

  const width = Math.max(worksheet.actualColumnCount || 0, worksheet.columnCount || 0);
  if (width <= 0) return empty;

  const readRow = (rowNumber: number): SheetCell[] => {
    const row = worksheet.getRow(rowNumber);
    const values: SheetCell[] = new Array(width);
    for (let c = 1; c <= width; c++) {
      values[c - 1] = normalizeCellValue(row.getCell(c).value);
    }
    return values;
  };

  const hasContent = (values: readonly SheetCell[]): boolean =>
    values.some((v) => v !== null && v !== "");

  // Find the header row: the first row that carries anything. Real exports
  // often start with a blank row or a title row above the table.
  const lastRow = worksheet.rowCount;
  let headerRowNumber = 0;
  for (let r = 1; r <= lastRow; r++) {
    if (hasContent(readRow(r))) {
      headerRowNumber = r;
      break;
    }
  }
  if (headerRowNumber === 0) return empty;

  const headers = readRow(headerRowNumber).map((cell) =>
    cell == null ? "" : String(cell).trim()
  );

  const rows: SheetCell[][] = [];
  let truncated = false;
  const ceiling = options?.maxRows ?? Number.POSITIVE_INFINITY;

  for (let r = headerRowNumber + 1; r <= lastRow; r++) {
    const values = readRow(r);
    if (!hasContent(values)) continue;
    if (rows.length >= ceiling) {
      truncated = true;
      break;
    }
    rows.push(values);
  }

  return {
    sheetName: worksheet.name,
    headers,
    rows,
    truncated,
    delimiter: null,
    encoding: null,
  };
}
