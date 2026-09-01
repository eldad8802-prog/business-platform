/**
 * CSV body for the legacy `/api/reports/export` endpoint.
 *
 * # Why this is a module and not four lines inside the route
 *
 * The endpoint used to build its CSV with `r.join(",")`. That is not an
 * escaping bug, it is three separate defects at once:
 *
 *  1. CORRUPTION — a `vendorName` or `category` containing a comma, a double
 *     quote or a newline shifts or breaks every following column. The file
 *     opens, looks plausible, and is wrong. That is worse than failing.
 *  2. FORMULA INJECTION — a value beginning with `=`, `+`, `-`, `@`, TAB or CR
 *     is executed by the spreadsheet. `vendorName` is OCR-derived, i.e. it is
 *     attacker-influenced content on the expense side.
 *  3. NO BOM — Excel reads the bytes as the local code page, so Hebrew vendor
 *     names arrive as gibberish.
 *
 * All three are fixed by routing the rows through the canonical writer. Pulling
 * the pure part out of `route.ts` is what makes the fix PROVABLE: this module
 * imports no Prisma, no auth and no tenant context, so its verifier runs in the
 * blocking CI job with no database.
 *
 * # Compatibility contract (deliberately preserved)
 *
 * This endpoint predates the Import/Export Center and may have existing
 * consumers, so the wire format is changed as little as the fix allows:
 *
 *  - delimiter stays `,`            (NOT the `;` the Accountant pack uses)
 *  - NO `sep=` directive            (adding a line would change row offsets)
 *  - line ending stays `\n`         (not CRLF)
 *  - headers stay the same five English labels, in the same order
 *  - the value of every column is derived exactly as before
 *
 * The only intentional byte-level additions are the UTF-8 BOM and the quoting /
 * formula guard the writer applies. Owner-facing Hebrew column labels are NOT
 * introduced here — that belongs to the new Export surface (I-3), not to a
 * security fix on a legacy endpoint.
 */

import { writeCsvBuffer } from "@/lib/data-transfer/format/csv-writer";

/** Structural shape only — deliberately not the Prisma model type. */
export type FinancialRecordCsvRow = {
  date: Date | string;
  vendorName: string;
  category: string;
  amount: number;
  direction: string;
};

/** The five legacy column labels, unchanged. */
export const FINANCIAL_RECORDS_CSV_HEADERS = [
  "Date",
  "Vendor",
  "Category",
  "Amount",
  "Direction",
] as const;

/** Writer configuration that reproduces the legacy wire format. */
export const FINANCIAL_RECORDS_CSV_OPTIONS = {
  delimiter: "," as const,
  excelSepDirective: false,
  eol: "\n" as const,
};

/** Row projection, value-for-value identical to the pre-fix route. */
export function toFinancialRecordCsvRow(
  record: FinancialRecordCsvRow
): (string | number)[] {
  return [
    new Date(record.date).toISOString().split("T")[0],
    record.vendorName,
    record.category,
    record.amount,
    record.direction,
  ];
}

/** Full CSV document as UTF-8 bytes, BOM first. */
export function buildFinancialRecordsCsvBuffer(
  records: readonly FinancialRecordCsvRow[]
): Buffer {
  return writeCsvBuffer(
    FINANCIAL_RECORDS_CSV_HEADERS,
    records.map(toFinancialRecordCsvRow),
    FINANCIAL_RECORDS_CSV_OPTIONS
  );
}
