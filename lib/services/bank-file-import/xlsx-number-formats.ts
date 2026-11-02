/**
 * Bank file import (B1) — the NUMBER FORMAT of the money cells of an Excel statement. SERVER-ONLY, no I/O beyond
 * the bytes it is handed.
 *
 * A dollar account's statement exported to Excel may hold plain numbers (1234.5) whose currency exists only in
 * the cell's number format ("$#,##0.00", "[$USD] #,##0.00"). The canonical reader (ExcelJS, through the
 * data-transfer readers) returns the values only, so this module reads the formats itself, straight from the
 * workbook's XML:
 *
 *   xl/workbook.xml + xl/_rels/workbook.xml.rels   which part holds the chosen sheet;
 *   xl/styles.xml                                   <numFmts> (custom format codes) and <cellXfs> (each style's
 *                                                   numFmtId) — a built-in id has NO code in the file;
 *   the sheet part                                  each cell's reference (r) and style (s).
 *
 * ExcelJS is not used for the formats on purpose: it reports nothing at all for the built-in currency formats
 * (ids 5–8, 42, 44, whose symbol is the viewer's locale), which would read as "no format" — exactly the case
 * that must be refused. The table's rows are mapped to sheet rows the same way the canonical reader picks
 * them (the first row with content is the header row, rows without content are skipped).
 *
 * Fail closed: anything that cannot be read reliably — the workbook parts, a cell without a reference, a style
 * index that does not exist, a money cell missing from the map — makes the result UNVERIFIABLE, never "plain".
 */
import ExcelJS from "exceljs";
import JSZip from "jszip";

import { normalizeCellValue } from "@/lib/data-transfer/format/xlsx-reader";
import type { SheetCell } from "@/lib/data-transfer/format";
import {
  classifyBuiltinNumberFormat,
  classifyNumberFormatCode,
  type BankMapping,
  type CurrencyCheck,
  type LocatedTable,
  type NumberFormatClass,
} from "./bank-file-core";

const CUSTOM_FORMAT_MIN_ID = 164;

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = unescapeXml(m[2]);
  return out;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

function columnNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export type CellFormatMap = {
  /** "row:col" (1-based sheet coordinates) ⇒ the class of the cell's number format. */
  byCell: Map<string, NumberFormatClass>;
};

/** The class of every styled cell of one sheet, or null when the workbook cannot be read reliably. */
export async function readCellFormats(bytes: Buffer, sheetName: string | null): Promise<CellFormatMap | null> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return null;
  }
  const text = async (path: string) => (zip.file(path) ? await zip.file(path)!.async("string") : null);
  const workbook = await text("xl/workbook.xml");
  const rels = await text("xl/_rels/workbook.xml.rels");
  if (!workbook || !rels) return null;

  const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map((m) => attrs(m[0]));
  if (sheets.length === 0) return null;
  const sheet =
    sheetName !== null
      ? sheets.find((s) => s.name === sheetName)
      : (sheets.find((s) => s.state !== "hidden" && s.state !== "veryHidden") ?? sheets[0]);
  const relId = sheet?.["r:id"];
  if (!relId) return null;
  const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => attrs(m[0])).find((r) => r.Id === relId);
  if (!rel?.Target) return null;
  const target = rel.Target.startsWith("/") ? rel.Target.slice(1) : `xl/${rel.Target.replace(/^\.\//, "")}`;
  const sheetXml = await text(target);
  if (!sheetXml) return null;

  // Styles: custom codes by id, and each cell style's numFmtId (index = the cell's s attribute).
  const styles = await text("xl/styles.xml");
  const customCodes = new Map<number, string>();
  const xfFormatIds: number[] = [];
  if (styles) {
    for (const m of styles.matchAll(/<numFmt\b[^>]*>/g)) {
      const a = attrs(m[0]);
      if (a.numFmtId !== undefined && a.formatCode !== undefined) customCodes.set(Number(a.numFmtId), a.formatCode);
    }
    const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles);
    if (cellXfs) for (const m of cellXfs[1].matchAll(/<xf\b[^>]*>/g)) xfFormatIds.push(Number(attrs(m[0]).numFmtId ?? 0));
  }
  const classOfStyle = (s: number): NumberFormatClass | null => {
    if (s === 0 && xfFormatIds.length === 0) return { kind: "PLAIN" };
    if (!Number.isInteger(s) || s < 0 || s >= xfFormatIds.length) return null;
    const id = xfFormatIds[s];
    if (!Number.isInteger(id)) return null;
    if (customCodes.has(id)) return classifyNumberFormatCode(customCodes.get(id));
    if (id >= CUSTOM_FORMAT_MIN_ID) return null; // a custom id with no code: unreadable
    return classifyBuiltinNumberFormat(id);
  };

  const byCell = new Map<string, NumberFormatClass>();
  for (const m of sheetXml.matchAll(/<c\b([^>]*?)(?:\/>|>)/g)) {
    const a = attrs(m[1]);
    const ref = /^([A-Z]+)(\d+)$/i.exec(a.r ?? "");
    if (!ref) return null; // a cell without a reference cannot be placed: unreliable
    const cls = classOfStyle(a.s === undefined ? 0 : Number(a.s));
    byCell.set(`${Number(ref[2])}:${columnNumber(ref[1])}`, cls ?? { kind: "UNVERIFIABLE", reason: "UNKNOWN_FORMAT_TOKEN" });
  }
  return { byCell };
}

/**
 * The sheet row number (1-based) of every row of the canonical table's grid (grid row 0 = its header row), picked
 * exactly as `readXlsxTable` picks them: rows with content, from the first one on.
 */
async function contentRowNumbers(bytes: Buffer, sheetName: string | null): Promise<number[] | null> {
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
    const ws = sheetName !== null ? wb.getWorksheet(sheetName) : (wb.worksheets.find((w) => w.state === "visible") ?? wb.worksheets[0]);
    if (!ws) return null;
    const width = Math.max(ws.actualColumnCount || 0, ws.columnCount || 0);
    const out: number[] = [];
    for (let r = 1; r <= ws.rowCount; r += 1) {
      const row = ws.getRow(r);
      let has = false;
      for (let c = 1; c <= width && !has; c += 1) {
        const v: SheetCell = normalizeCellValue(row.getCell(c).value);
        has = v !== null && v !== "";
      }
      if (has) out.push(r);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * The currency guard for the NUMBER FORMATS of an Excel statement's money cells (amount, debit, credit, balance):
 * every numeric money cell's format must be plain or shekel. A foreign format ⇒ FOREIGN; a locale currency
 * format, an unknown token, or formats that cannot be read ⇒ UNVERIFIABLE. Text cells are left to the text
 * checks (checkFileCurrency); empty cells carry no money.
 */
export async function checkXlsxMoneyFormats(
  bytes: Buffer,
  sheetName: string | null,
  located: LocatedTable,
  mapping: BankMapping
): Promise<CurrencyCheck> {
  const moneyCols = (["amount", "debit", "credit", "balance"] as const).flatMap((f) => (mapping[f] !== undefined ? [mapping[f] as number] : []));
  const numericCells = located.rows.flatMap(({ rowNumber, cells }) =>
    moneyCols.filter((c) => typeof cells[c] === "number").map((c) => ({ rowNumber, col: c }))
  );
  if (numericCells.length === 0) return { ok: true };

  const unverifiable = (rowNumber: number | null): CurrencyCheck => ({
    ok: false,
    verdict: "UNVERIFIABLE",
    signal: "NUMBER_FORMAT",
    currency: "UNKNOWN",
    rowNumber,
  });
  const [formats, rows] = await Promise.all([readCellFormats(bytes, sheetName), contentRowNumbers(bytes, sheetName)]);
  if (!formats || !rows) return unverifiable(null);

  for (const { rowNumber, col } of numericCells) {
    // Grid row g = rowNumber - 1 (see locateHeader); its sheet row is the g-th row with content.
    const sheetRow = rows[rowNumber - 1];
    const cls = sheetRow === undefined ? undefined : formats.byCell.get(`${sheetRow}:${col + 1}`);
    if (!cls) return unverifiable(rowNumber);
    if (cls.kind === "FOREIGN") return { ok: false, verdict: "FOREIGN", signal: "NUMBER_FORMAT", currency: cls.currency, rowNumber };
    if (cls.kind === "UNVERIFIABLE") return unverifiable(rowNumber);
  }
  return { ok: true };
}
