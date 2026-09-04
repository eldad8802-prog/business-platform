/**
 * The ONE tabular shape every Dubiz data-transfer reader produces and every
 * writer consumes.
 *
 * Why a single shape: the Import wizard (analyze -> propose mapping -> preview)
 * must behave identically whether the owner uploaded a CSV exported from a
 * competitor or an XLSX saved from Excel. Anything format-specific (delimiter,
 * encoding, sheet name) is reported as METADATA on the table, never as a
 * different type the callers must branch on.
 *
 * Deliberate design notes:
 *
 *  - Rows are POSITIONAL (`SheetCell[]`), not records. Real exports routinely
 *    carry duplicate or empty header labels; collapsing to `Record<string,...>`
 *    would silently drop columns. Mapping happens by column INDEX.
 *  - Cell values keep their source type when the source has one (XLSX numbers
 *    and dates stay `number` / `Date`). CSV has no types, so a CSV table is
 *    all-`string`. The normalize layer (a later increment) is what turns a
 *    cell into a domain value — the format layer never guesses.
 *  - Values are NOT trimmed here. Trimming is a normalization decision and it
 *    is lossy; only HEADERS are trimmed, because they are matched as labels.
 */

/** A single cell as read from the source, before any domain normalization. */
export type SheetCell = string | number | boolean | Date | null;

/** Text encoding a reader detected (or was told to assume) for a byte source. */
export type TableEncoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1255";

/** Column separator of a delimited text source. */
export type CsvDelimiter = "," | ";" | "\t";

/** A parsed tabular source: header labels plus positional rows. */
export type SheetTable = {
  /** Worksheet name for XLSX; `null` for a delimited text source. */
  sheetName: string | null;
  /** First non-empty row, trimmed. May contain duplicate or empty labels. */
  headers: string[];
  /** Data rows (header row excluded). Ragged rows are padded to `headers.length`. */
  rows: SheetCell[][];
  /** True when `maxRows` stopped the read before the source was exhausted. */
  truncated: boolean;
  /** Detected delimiter — delimited text sources only. */
  delimiter: CsvDelimiter | null;
  /** Detected encoding — byte sources only. */
  encoding: TableEncoding | null;
};
