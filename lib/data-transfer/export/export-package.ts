/**
 * The write half of the export engine: tables in, one downloadable file out.
 *
 * # The four shapes, and why
 *
 *   1 domain,  XLSX  -> one workbook, one sheet
 *   N domains, XLSX  -> ONE workbook, one sheet per domain
 *   1 domain,  CSV   -> one .csv
 *   N domains, CSV   -> one .zip holding one .csv per domain
 *
 * The multi-domain XLSX is a single workbook rather than several files in a zip
 * because that is what a workbook is FOR — the owner opens one file and clicks
 * between tabs. Zipping four .xlsx files would make them do the archive tool's
 * work for no reason. CSV cannot express tabs, so multi-domain CSV genuinely
 * needs a container; what it must NOT become is a single file with four tables
 * stacked inside it, which no spreadsheet can read back.
 *
 * # File names
 *
 * ASCII only, and no business name. A downloaded file crosses operating
 * systems, mail clients and archive tools; a Hebrew filename is where that trip
 * breaks, and putting the tenant's name in it would mean normalizing
 * owner-controlled text into a filename — a path-traversal and header-injection
 * surface bought for nothing.
 *
 * The date is the ISRAELI calendar day, via `Intl` with the `Asia/Jerusalem`
 * zone already used elsewhere in the tree (e.g. `lib/revenue/coupon-terms.ts`).
 * No new timezone arithmetic is introduced here — `Intl` owns the DST question.
 * `en-CA` is used purely because it formats as `YYYY-MM-DD`.
 */

import {
  buildXlsxBuffer,
  type XlsxSheetSpec,
} from "@/lib/data-transfer/format/xlsx-writer";
import { writeCsvBuffer } from "@/lib/data-transfer/format/csv-writer";
import { collectArchiveToBuffer } from "@/lib/archive/zip-buffer";
import type { ExportFormat } from "./export-request";
import type { ExportedDomainTable } from "./export-runner";

export type ExportArtifact = {
  body: Buffer;
  filename: string;
  contentType: string;
};

const ISRAEL_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jerusalem",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** `YYYY-MM-DD` for the Israeli calendar day containing `at`. */
export function israelDateStamp(at: Date): string {
  return ISRAEL_DAY.format(at);
}

/**
 * `dubiz-customers-2026-09-02.xlsx` for one domain,
 * `dubiz-export-2026-09-02.zip` for several.
 *
 * The slug comes from the descriptor (a fixed ASCII literal), never from user
 * data, so the result is always safe in a `Content-Disposition` header.
 */
export function buildExportFilename(
  tables: readonly ExportedDomainTable[],
  extension: string,
  at: Date
): string {
  const stamp = israelDateStamp(at);
  const subject =
    tables.length === 1 ? tables[0].descriptor.fileSlug : "export";
  return `dubiz-${subject}-${stamp}.${extension}`;
}

/** CSV entry name inside a multi-domain archive. */
function csvEntryName(table: ExportedDomainTable, at: Date): string {
  return `dubiz-${table.descriptor.fileSlug}-${israelDateStamp(at)}.csv`;
}

function toSheetSpec(table: ExportedDomainTable): XlsxSheetSpec {
  return {
    name: table.descriptor.sheetName,
    columns: table.descriptor.columns.map((c) => ({
      header: c.header,
      type: c.type,
      width: c.width,
    })),
    rows: table.rows,
    rightToLeft: true,
    freezeHeader: true,
    autoFilter: true,
  };
}

async function buildXlsxArtifact(
  tables: readonly ExportedDomainTable[],
  at: Date
): Promise<ExportArtifact> {
  const body = await buildXlsxBuffer(tables.map(toSheetSpec));
  return {
    body,
    filename: buildExportFilename(tables, "xlsx", at),
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
}

function csvBufferFor(table: ExportedDomainTable): Buffer {
  // Excel-friendly defaults, identical to the rest of the platform: UTF-8 BOM,
  // `sep=;` directive, CRLF, every field quoted and formula-guarded.
  return writeCsvBuffer(
    table.descriptor.columns.map((c) => c.header),
    table.rows,
    { delimiter: ";", excelSepDirective: true, eol: "\r\n" }
  );
}

async function buildCsvArtifact(
  tables: readonly ExportedDomainTable[],
  at: Date
): Promise<ExportArtifact> {
  if (tables.length === 1) {
    return {
      body: csvBufferFor(tables[0]),
      filename: buildExportFilename(tables, "csv", at),
      contentType: "text/csv; charset=utf-8",
    };
  }

  const body = await collectArchiveToBuffer(async (archive) => {
    for (const table of tables) {
      // `store: false` (the default) is right here: CSV is text and compresses
      // well, unlike the already-compressed originals in the accountant pack.
      archive.append(csvBufferFor(table), { name: csvEntryName(table, at) });
    }
  });

  return {
    body,
    filename: buildExportFilename(tables, "zip", at),
    contentType: "application/zip",
  };
}

/** Assemble the requested artifact. Pure: no DB, no tenant context, no I/O. */
export async function buildExportArtifact(
  tables: readonly ExportedDomainTable[],
  format: ExportFormat,
  at: Date
): Promise<ExportArtifact> {
  if (tables.length === 0) {
    throw new Error("buildExportArtifact: no domains selected");
  }
  return format === "csv"
    ? buildCsvArtifact(tables, at)
    : buildXlsxArtifact(tables, at);
}
