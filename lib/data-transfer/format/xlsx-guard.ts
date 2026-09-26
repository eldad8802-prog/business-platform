/**
 * XLSX resource limits (L-5) — enforced BEFORE ExcelJS loads the workbook.
 *
 * ExcelJS (via JSZip) inflates every part of the archive into memory, and the
 * reader then walked columnCount × rowCount cells. Both are attacker-shaped:
 * a 10MB upload can declare gigabytes of XML (zip bomb), and one
 * one styled cell at XFD1 plus one row at 1048576 made the reader loop
 * 17 billion times. This guard reads the ZIP central directory, inflates the
 * worksheet parts under a hard cap, and refuses the file with a specific code
 * when any bound is crossed. The reader then re-checks rows, cells and time
 * while it scans (defence in depth — the counts here are of XML elements).
 */

import {
  inflateZipEntry,
  looksLikeZip,
  readZipCentralDirectory,
  ZipInspectError,
  type ZipEntryInfo,
} from "@/lib/security/zip-inspect";

export const XLSX_LIMITS = {
  /** Compressed archive ceiling (the import route also caps at 10MB). */
  maxCompressedBytes: 10 * 1024 * 1024,
  maxEntries: 2_000,
  /** Sum of DECLARED uncompressed sizes across every part. */
  maxTotalUncompressedBytes: 120 * 1024 * 1024,
  /** Any single part. */
  maxEntryUncompressedBytes: 60 * 1024 * 1024,
  /** Per-part inflation ratio, applied to parts larger than 1MB inflated. */
  maxCompressionRatio: 250,
  /** Sheet dimension (<dimension ref>, <col max>) bounds. */
  maxColumns: 1_024,
  maxRows: 250_000,
  /** Scan bounds (XML <row>/<c> elements across all sheets; reader loop). */
  maxRowsScanned: 250_000,
  maxCellsScanned: 5_000_000,
  /** Wall-clock budget for guard + load + scan. */
  timeBudgetMs: 20_000,
} as const;

export type XlsxLimitCode =
  | "XLSX_NOT_ZIP"
  | "XLSX_COMPRESSED_TOO_LARGE"
  | "XLSX_MALFORMED_ZIP"
  | "XLSX_TOO_MANY_ENTRIES"
  | "XLSX_UNCOMPRESSED_TOO_LARGE"
  | "XLSX_COMPRESSION_RATIO"
  | "XLSX_DIMENSION_TOO_LARGE"
  | "XLSX_TOO_MANY_ROWS_SCANNED"
  | "XLSX_TOO_MANY_CELLS"
  | "XLSX_TIME_BUDGET";

export class XlsxLimitError extends Error {
  constructor(readonly code: XlsxLimitCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "XlsxLimitError";
  }
}

export type XlsxLimits = { -readonly [K in keyof typeof XLSX_LIMITS]: number };

const COLUMN_RE = /^([A-Z]{1,3})(\d{1,7})$/;

/** "XFD" -> 16384. */
export function columnLettersToNumber(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** Parse one side of a ref like "A1" / "XFD1048576". */
function parseCellRef(ref: string): { col: number; row: number } | null {
  const m = COLUMN_RE.exec(ref.replace(/\$/g, "").trim().toUpperCase());
  if (!m) return null;
  return { col: columnLettersToNumber(m[1]), row: Number(m[2]) };
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

function mapZipError(error: ZipInspectError): XlsxLimitError {
  if (error.code === "ZIP_TOO_MANY_ENTRIES") {
    return new XlsxLimitError("XLSX_TOO_MANY_ENTRIES", error.message);
  }
  if (error.code === "ZIP_ENTRY_TOO_LARGE" || error.code === "ZIP_SIZE_MISMATCH") {
    return new XlsxLimitError("XLSX_UNCOMPRESSED_TOO_LARGE", error.message);
  }
  return new XlsxLimitError("XLSX_MALFORMED_ZIP", error.message);
}

function checkDeadline(deadline: number): void {
  if (Date.now() > deadline) {
    throw new XlsxLimitError("XLSX_TIME_BUDGET", "workbook took too long to inspect");
  }
}

/**
 * Throw XlsxLimitError if the workbook exceeds any bound. Returns the deadline
 * (epoch ms) the reader must also honour.
 */
export function assertXlsxWithinLimits(
  buffer: Buffer,
  overrides?: Partial<XlsxLimits>,
  startedAt: number = Date.now()
): { deadline: number } {
  const limits: XlsxLimits = { ...XLSX_LIMITS, ...overrides };
  const deadline = startedAt + limits.timeBudgetMs;

  if (buffer.length > limits.maxCompressedBytes) {
    throw new XlsxLimitError("XLSX_COMPRESSED_TOO_LARGE", `archive is ${buffer.length} bytes`);
  }
  if (!looksLikeZip(buffer)) {
    throw new XlsxLimitError("XLSX_NOT_ZIP", "not a ZIP container");
  }

  let entries: ZipEntryInfo[];
  try {
    entries = readZipCentralDirectory(buffer, { maxEntries: limits.maxEntries });
  } catch (error) {
    if (error instanceof ZipInspectError) throw mapZipError(error);
    throw error;
  }

  let total = 0;
  for (const e of entries) {
    if (e.uncompressedSize > limits.maxEntryUncompressedBytes) {
      throw new XlsxLimitError(
        "XLSX_UNCOMPRESSED_TOO_LARGE",
        `part ${e.name} declares ${e.uncompressedSize} bytes`
      );
    }
    total += e.uncompressedSize;
    if (total > limits.maxTotalUncompressedBytes) {
      throw new XlsxLimitError(
        "XLSX_UNCOMPRESSED_TOO_LARGE",
        `archive declares more than ${limits.maxTotalUncompressedBytes} bytes`
      );
    }
    if (
      e.uncompressedSize > 1024 * 1024 &&
      e.uncompressedSize / Math.max(1, e.compressedSize) > limits.maxCompressionRatio
    ) {
      throw new XlsxLimitError(
        "XLSX_COMPRESSION_RATIO",
        `part ${e.name} inflates ${Math.round(e.uncompressedSize / Math.max(1, e.compressedSize))}x`
      );
    }
  }

  // Worksheet parts: inflate under a hard cap and bound what ExcelJS will build.
  let rowsSeen = 0;
  let cellsSeen = 0;
  for (const e of entries) {
    if (!/^xl\/worksheets\/[^/]+\.xml$/i.test(e.name)) continue;
    checkDeadline(deadline);
    let xml: string;
    try {
      xml = inflateZipEntry(buffer, e, limits.maxEntryUncompressedBytes).toString("utf8");
    } catch (error) {
      if (error instanceof ZipInspectError) throw mapZipError(error);
      throw error;
    }

    const dim = /<dimension\b[^>]*\bref="([^"]+)"/.exec(xml);
    if (dim) {
      const last = parseCellRef(dim[1].split(":").pop() ?? "");
      if (last && (last.col > limits.maxColumns || last.row > limits.maxRows)) {
        throw new XlsxLimitError(
          "XLSX_DIMENSION_TOO_LARGE",
          `sheet ${e.name} dimension ${dim[1]}`
        );
      }
    }
    // `<col min max>` is NOT checked: Excel writes max="16384" for ordinary
    // whole-row formatting, and ExcelJS derives the scan width from CELLS,
    // which are bounded just below.
    const rowNum = /<row\b[^>]*\br="(\d+)"/g;
    for (let m = rowNum.exec(xml); m; m = rowNum.exec(xml)) {
      if (Number(m[1]) > limits.maxRows) {
        throw new XlsxLimitError("XLSX_DIMENSION_TOO_LARGE", `sheet ${e.name} row ${m[1]}`);
      }
    }
    const cellRef = /<c\b[^>]*\br="([A-Z]{1,3})\d+"/g;
    for (let m = cellRef.exec(xml); m; m = cellRef.exec(xml)) {
      if (columnLettersToNumber(m[1]) > limits.maxColumns) {
        throw new XlsxLimitError("XLSX_DIMENSION_TOO_LARGE", `sheet ${e.name} column ${m[1]}`);
      }
    }

    rowsSeen += countOccurrences(xml, "<row");
    cellsSeen += countOccurrences(xml, "<c ") + countOccurrences(xml, "<c>");
    if (rowsSeen > limits.maxRowsScanned) {
      throw new XlsxLimitError("XLSX_TOO_MANY_ROWS_SCANNED", `more than ${limits.maxRowsScanned} rows`);
    }
    if (cellsSeen > limits.maxCellsScanned) {
      throw new XlsxLimitError("XLSX_TOO_MANY_CELLS", `more than ${limits.maxCellsScanned} cells`);
    }
  }
  checkDeadline(deadline);
  return { deadline };
}
