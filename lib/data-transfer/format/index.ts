/**
 * Dubiz data-transfer FORMAT layer — the byte/text boundary of the
 * Import & Export Center (הגדרות → ייבוא וייצוא).
 *
 * This layer knows about CSV and XLSX and about nothing else. It has no Prisma
 * import, no tenant context, no domain vocabulary and no network access, which
 * is exactly why its verifier runs in the BLOCKING CI-1 job.
 *
 * Layer boundary (deliberate):
 *   format/     bytes  <-> SheetTable          <- this module
 *   normalize/  cell   <-> domain value        (later increment)
 *   mapping/    header <-> domain field        (later increment)
 *   domains/    SheetTable <-> domain service  (later increment)
 */

export type {
  CsvDelimiter,
  SheetCell,
  SheetTable,
  TableEncoding,
} from "./table.types";

export {
  CSV_FORMULA_GUARD_PREFIX,
  CSV_FORMULA_TRIGGER_CHARS,
  UTF8_BOM_BYTES,
  escapeCsvField,
  guardCsvFormula,
  needsCsvFormulaGuard,
  writeCsvBuffer,
  writeCsvRow,
  writeCsvText,
  type CsvWriteOptions,
} from "./csv-writer";

export {
  decodeTableBuffer,
  detectCsvDelimiter,
  parseDelimitedText,
  readCsvTable,
  type CsvParseOptions,
  type ReadCsvOptions,
} from "./csv-reader";

export {
  buildXlsxBuffer,
  sanitizeSheetName,
  type XlsxColumn,
  type XlsxColumnType,
  type XlsxSheetSpec,
} from "./xlsx-writer";

export {
  normalizeCellValue,
  readXlsxTable,
  type ReadXlsxOptions,
} from "./xlsx-reader";
