/**
 * Canonical delimited-text reader.
 *
 * # Why the existing parser was not reusable
 *
 * `lib/services/supplier-connectors/csv/csv-parser.ts` splits on newlines FIRST
 * and only then handles quotes. That makes three real-world files unreadable:
 * a quoted field containing a newline (any multi-line address), a file using
 * `;` (what Excel he-IL writes), and a file carrying a UTF-8 BOM (what Excel
 * always writes). It is also comma-only. It stays where it is, serving its one
 * supplier-connector caller; this reader is the one the Import Center uses.
 *
 * # What this reader handles
 *
 *  - UTF-8 (with or without BOM), UTF-16 LE/BE (BOM-detected), and a
 *    windows-1255 fallback for Hebrew CSVs saved by older Windows tooling.
 *  - `sep=;` / `sep=,` Excel directive on the first line (consumed, not data).
 *  - Delimiter auto-detection across `,` `;` TAB, counted OUTSIDE quotes.
 *  - RFC 4180 quoting: doubled-quote escapes, embedded delimiters, embedded
 *    newlines.
 *  - CRLF, LF and lone-CR line endings.
 *  - Ragged rows (padded), fully-empty rows (skipped).
 *  - A `maxRows` ceiling so a hostile file cannot exhaust memory unnoticed;
 *    the result reports `truncated` instead of failing silently.
 *
 * Values are returned UNTRIMMED and as strings — delimited text has no types.
 * Only headers are trimmed, because they are matched as labels.
 */

import type { CsvDelimiter, SheetTable, TableEncoding } from "./table.types";

const DELIMITER_CANDIDATES: readonly CsvDelimiter[] = [",", ";", "\t"];

const BOM_UTF8 = [0xef, 0xbb, 0xbf];
const BOM_UTF16LE = [0xff, 0xfe];
const BOM_UTF16BE = [0xfe, 0xff];

function startsWithBytes(buf: Buffer, bytes: readonly number[]): boolean {
  if (buf.length < bytes.length) return false;
  return bytes.every((b, i) => buf[i] === b);
}

/**
 * Decode a byte source to text, reporting which encoding was used.
 *
 * Order matters: a BOM is authoritative, so it is checked first. With no BOM we
 * try STRICT UTF-8 — `fatal: true` is what makes this a real detection rather
 * than a guess, because invalid UTF-8 throws instead of silently producing
 * U+FFFD replacement characters (which is how Hebrew turns into gibberish).
 * Only then do we fall back to windows-1255, the legacy Hebrew code page.
 */
export function decodeTableBuffer(buffer: Buffer): {
  text: string;
  encoding: TableEncoding;
} {
  if (startsWithBytes(buffer, BOM_UTF8)) {
    return {
      text: buffer.subarray(BOM_UTF8.length).toString("utf8"),
      encoding: "utf-8",
    };
  }
  if (startsWithBytes(buffer, BOM_UTF16LE)) {
    return {
      text: new TextDecoder("utf-16le").decode(
        buffer.subarray(BOM_UTF16LE.length)
      ),
      encoding: "utf-16le",
    };
  }
  if (startsWithBytes(buffer, BOM_UTF16BE)) {
    return {
      text: new TextDecoder("utf-16be").decode(
        buffer.subarray(BOM_UTF16BE.length)
      ),
      encoding: "utf-16be",
    };
  }

  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(buffer),
      encoding: "utf-8",
    };
  } catch {
    return {
      text: new TextDecoder("windows-1255").decode(buffer),
      encoding: "windows-1255",
    };
  }
}

/** Strip a leading `sep=<char>` directive, returning the delimiter it declared. */
function consumeSepDirective(text: string): {
  text: string;
  declared: CsvDelimiter | null;
} {
  const match = /^sep=(.)(\r\n|\n|\r)/i.exec(text);
  if (!match) return { text, declared: null };
  const candidate = match[1] as CsvDelimiter;
  if (!DELIMITER_CANDIDATES.includes(candidate)) {
    // Unknown separator declared — drop the directive line (it is not data)
    // but fall back to detection rather than trusting it.
    return { text: text.slice(match[0].length), declared: null };
  }
  return { text: text.slice(match[0].length), declared: candidate };
}

/**
 * Pick the delimiter by counting candidates in the first LOGICAL line, ignoring
 * anything inside quotes. Counting inside quotes is how a naive detector picks
 * `,` for a `;`-file whose first cell is a quoted "city, country" value.
 */
export function detectCsvDelimiter(text: string): CsvDelimiter {
  const counts = new Map<CsvDelimiter, number>(
    DELIMITER_CANDIDATES.map((d) => [d, 0])
  );
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    if (!inQuotes && counts.has(ch as CsvDelimiter)) {
      counts.set(ch as CsvDelimiter, (counts.get(ch as CsvDelimiter) ?? 0) + 1);
    }
  }

  let best: CsvDelimiter = ",";
  let bestCount = 0;
  for (const candidate of DELIMITER_CANDIDATES) {
    const count = counts.get(candidate) ?? 0;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

export type CsvParseOptions = {
  /** Force a delimiter instead of detecting one. */
  delimiter?: CsvDelimiter;
  /**
   * Maximum DATA rows to materialize (header excluded). Reaching it sets
   * `truncated` — the read stops, it never throws and never silently drops.
   */
  maxRows?: number;
};

/**
 * RFC 4180 state machine over the WHOLE text (not line-by-line) — that is what
 * makes embedded newlines inside quoted fields work.
 *
 * Leniency, on purpose: a double quote that appears in the middle of an
 * UNQUOTED field is kept as a literal character instead of raising. Real
 * exports contain values such as a 12-inch screen written with an inch mark,
 * and refusing the whole file over one stray quote would be a worse outcome
 * for the owner than reading it faithfully.
 */
export function parseDelimitedText(
  text: string,
  options?: CsvParseOptions
): { rows: string[][]; delimiter: CsvDelimiter; truncated: boolean } {
  const stripped = consumeSepDirective(text);
  const delimiter =
    options?.delimiter ?? stripped.declared ?? detectCsvDelimiter(stripped.text);
  const body = stripped.text;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;
  let truncated = false;
  // maxRows counts DATA rows; the header row is row index 0 and is always read.
  const rowCeiling =
    options?.maxRows == null ? Number.POSITIVE_INFINITY : options.maxRows + 1;

  const endField = () => {
    row.push(field);
    field = "";
    fieldStarted = false;
  };

  const endRow = (): boolean => {
    endField();
    // A row of nothing but empty strings carries no data — skip it rather than
    // emitting a phantom record for every blank line in the file.
    if (row.some((v) => v.length > 0)) {
      rows.push(row);
    }
    row = [];
    if (rows.length >= rowCeiling) {
      truncated = true;
      return false;
    }
    return true;
  };

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];

    if (inQuotes) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i++;
          continue;
        }
        inQuotes = false;
        continue;
      }
      field += ch;
      continue;
    }

    if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      continue;
    }

    if (ch === delimiter) {
      endField();
      continue;
    }

    if (ch === "\r") {
      if (body[i + 1] === "\n") i++;
      if (!endRow()) break;
      continue;
    }

    if (ch === "\n") {
      if (!endRow()) break;
      continue;
    }

    field += ch;
    fieldStarted = true;
  }

  // Trailing content with no final line ending.
  if (!truncated && (field.length > 0 || row.length > 0)) {
    endRow();
  }

  return { rows, delimiter, truncated };
}

export type ReadCsvOptions = CsvParseOptions & {
  /** Skip detection and decode with this encoding (byte sources only). */
  encoding?: TableEncoding;
};

/**
 * Read a delimited-text source into the canonical {@link SheetTable}.
 * The first row that carries any content becomes the header row.
 */
export function readCsvTable(
  source: Buffer | string,
  options?: ReadCsvOptions
): SheetTable {
  let text: string;
  let encoding: TableEncoding | null = null;

  if (typeof source === "string") {
    text = source;
  } else if (options?.encoding) {
    encoding = options.encoding;
    text =
      encoding === "utf-8"
        ? decodeTableBuffer(source).text
        : new TextDecoder(encoding).decode(source);
  } else {
    const decoded = decodeTableBuffer(source);
    text = decoded.text;
    encoding = decoded.encoding;
  }

  const parsed = parseDelimitedText(text, options);
  const [headerRow, ...dataRows] = parsed.rows;

  if (!headerRow) {
    return {
      sheetName: null,
      headers: [],
      rows: [],
      truncated: parsed.truncated,
      delimiter: parsed.delimiter,
      encoding,
    };
  }

  const headers = headerRow.map((h) => h.trim());
  const width = headers.length;
  const rows = dataRows.map((r) => {
    const padded: string[] = new Array(width);
    for (let c = 0; c < width; c++) padded[c] = r[c] ?? "";
    return padded;
  });

  return {
    sheetName: null,
    headers,
    rows,
    truncated: parsed.truncated,
    delimiter: parsed.delimiter,
    encoding,
  };
}
