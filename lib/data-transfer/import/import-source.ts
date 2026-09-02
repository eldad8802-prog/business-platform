/**
 * Uploaded file -> a table, or a clear refusal.
 *
 * Reuses the I-1 readers exactly — there is no second parser. All this adds is
 * the decisions a reader should not make: which file types are accepted, how
 * big is too big, and WHICH SHEET is the data.
 *
 * # Sheet selection is never a guess
 *
 *   Dubiz template    a sheet literally named "ייבוא" wins outright. The
 *                     companion "הוראות" sheet is instructions, and importing
 *                     it as data would produce a table of help text.
 *   single sheet      use it.
 *   several sheets    ASK. Picking "the first" is how an owner silently imports
 *                     the wrong tab of their workbook.
 *
 * "Several sheets" means several sheets WITH DATA: an export with three empty
 * scratch tabs should not force a question that has only one real answer.
 */

import {
  readCsvTable,
  readXlsxTable,
  type SheetTable,
} from "@/lib/data-transfer/format";
import {
  TEMPLATE_DATA_SHEET,
  TEMPLATE_GUIDE_SHEET,
} from "@/lib/data-transfer/templates/template-builder";
import {
  IMPORT_ACCEPTED_EXTENSIONS,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_ROWS,
} from "./import-config";

export type ImportSourceError =
  | "FILE_MISSING"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_TYPE"
  | "EMPTY_FILE"
  | "UNREADABLE_FILE"
  | "NO_HEADERS"
  | "TOO_MANY_ROWS"
  | "SHEET_CHOICE_REQUIRED"
  | "SHEET_NOT_FOUND";

export type ImportSourceResult =
  | {
      ok: true;
      table: SheetTable;
      /** Sheet actually read; null for CSV. Signed into the preview token. */
      sheetName: string | null;
      /** Sheets that hold data, when the caller may need to choose. */
      availableSheets: string[];
      kind: "xlsx" | "csv";
    }
  | {
      ok: false;
      code: ImportSourceError;
      message: string;
      /** Present for SHEET_CHOICE_REQUIRED so the UI can offer the list. */
      availableSheets?: string[];
    };

function fail(
  code: ImportSourceError,
  message: string,
  availableSheets?: string[]
): ImportSourceResult {
  return { ok: false, code, message, availableSheets };
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

/** Extension decides, not the declared MIME — browsers disagree about CSV. */
export function classifyUpload(filename: string): "xlsx" | "csv" | null {
  const ext = extensionOf(filename);
  if (!(IMPORT_ACCEPTED_EXTENSIONS as readonly string[]).includes(ext)) {
    return null;
  }
  return ext === ".xlsx" ? "xlsx" : "csv";
}

/** XLSX files are ZIP archives; every one starts with the local-header magic. */
function looksLikeXlsx(bytes: Buffer): boolean {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

async function listSheetsWithData(bytes: Buffer): Promise<string[]> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  return workbook.worksheets
    .filter((ws) => ws.state === "visible" || ws.state === undefined)
    .filter((ws) => (ws.actualRowCount ?? ws.rowCount ?? 0) > 0)
    .map((ws) => ws.name);
}

export type ReadImportSourceInput = {
  filename: string;
  bytes: Buffer;
  /** Explicit sheet choice, once the owner has made one. */
  sheetName?: string | null;
};

/**
 * Read an upload into a table. Fails CLOSED with a code the UI can explain —
 * a malformed file must never become a partially-read table.
 */
export async function readImportSource(
  input: ReadImportSourceInput
): Promise<ImportSourceResult> {
  const { filename, bytes } = input;

  if (!bytes || bytes.length === 0) {
    return fail("EMPTY_FILE", "הקובץ ריק");
  }
  // Size is checked against the BYTES, not a client-declared length.
  if (bytes.length > IMPORT_MAX_FILE_BYTES) {
    const mb = Math.round(IMPORT_MAX_FILE_BYTES / 1024 / 1024);
    return fail("FILE_TOO_LARGE", `הקובץ גדול מדי (עד ${mb}MB)`);
  }

  const kind = classifyUpload(filename);
  if (kind === null) {
    return fail("UNSUPPORTED_TYPE", "סוג קובץ לא נתמך (נדרש XLSX או CSV)");
  }

  if (kind === "csv") {
    // A .csv that is actually a zip is a renamed xlsx — reading it as text
    // would produce a table of binary garbage.
    if (looksLikeXlsx(bytes)) {
      return fail("UNSUPPORTED_TYPE", "הקובץ אינו CSV. שמרו אותו כ-CSV או כ-XLSX");
    }
    let table: SheetTable;
    try {
      table = readCsvTable(bytes, { maxRows: IMPORT_MAX_ROWS + 1 });
    } catch {
      return fail("UNREADABLE_FILE", "לא הצלחנו לקרוא את הקובץ");
    }
    if (table.headers.length === 0) {
      return fail("NO_HEADERS", "לא נמצאה שורת כותרות בקובץ");
    }
    if (table.rows.length > IMPORT_MAX_ROWS) {
      return fail(
        "TOO_MANY_ROWS",
        `יותר מדי שורות (עד ${IMPORT_MAX_ROWS.toLocaleString("he-IL")}). פצלו את הקובץ`
      );
    }
    return { ok: true, table, sheetName: null, availableSheets: [], kind };
  }

  if (!looksLikeXlsx(bytes)) {
    return fail("UNSUPPORTED_TYPE", "הקובץ אינו XLSX תקין");
  }

  let sheets: string[];
  try {
    sheets = await listSheetsWithData(bytes);
  } catch {
    return fail("UNREADABLE_FILE", "לא הצלחנו לקרוא את קובץ ה-Excel");
  }

  if (sheets.length === 0) {
    return fail("EMPTY_FILE", "אין גיליון עם נתונים בקובץ");
  }

  let chosen: string;
  if (input.sheetName) {
    if (!sheets.includes(input.sheetName)) {
      return fail("SHEET_NOT_FOUND", "הגיליון שנבחר לא נמצא בקובץ", sheets);
    }
    chosen = input.sheetName;
  } else if (sheets.includes(TEMPLATE_DATA_SHEET)) {
    // A Dubiz template: the data sheet is named, and the guide sheet beside it
    // is instructions, never data.
    chosen = TEMPLATE_DATA_SHEET;
  } else {
    const candidates = sheets.filter((s) => s !== TEMPLATE_GUIDE_SHEET);
    if (candidates.length === 1) {
      chosen = candidates[0];
    } else {
      return fail(
        "SHEET_CHOICE_REQUIRED",
        "בקובץ יש כמה גיליונות עם נתונים. בחרו איזה מהם לייבא",
        candidates
      );
    }
  }

  let table: SheetTable;
  try {
    table = await readXlsxTable(bytes, {
      sheetName: chosen,
      maxRows: IMPORT_MAX_ROWS + 1,
    });
  } catch {
    return fail("UNREADABLE_FILE", "לא הצלחנו לקרוא את הגיליון שנבחר");
  }

  if (table.headers.length === 0) {
    return fail("NO_HEADERS", "לא נמצאה שורת כותרות בגיליון");
  }
  if (table.rows.length > IMPORT_MAX_ROWS) {
    return fail(
      "TOO_MANY_ROWS",
      `יותר מדי שורות (עד ${IMPORT_MAX_ROWS.toLocaleString("he-IL")}). פצלו את הקובץ`
    );
  }

  return { ok: true, table, sheetName: chosen, availableSheets: sheets, kind };
}
