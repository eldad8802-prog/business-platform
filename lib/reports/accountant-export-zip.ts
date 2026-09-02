import archiver from "archiver";
import { collectArchiveToBuffer } from "@/lib/archive/zip-buffer";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { getTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

// D2/P7-W4D: ctx-aware short tenant tx per DB step (no global fallback under
// an established context; direct reads only for context-less unit tests).
async function dbStep<T>(fn: (db: typeof prisma) => Promise<T>): Promise<T> {
  if (getTenantContext() !== undefined) {
    return withTenantTransaction((tx) => fn(tx as unknown as typeof prisma));
  }
  return fn(prisma);
}
import {
  readDocumentObject,
  STORED_DOCUMENT_FILENAME_REGEX,
} from "@/lib/services/documents/document-storage.service";
import { StorageObjectNotFoundError } from "@/lib/storage/storage.errors";
import { CATEGORY_MAP } from "@/lib/constants/categories";
import {
  writeCsvBuffer,
  writeCsvText,
} from "@/lib/data-transfer/format/csv-writer";

export type AccountantPackBody = {
  type: "month" | "quarter" | "year";
  month?: string;
  year?: string;
  quarter?: string;
  categories?: string[];
};

const CONFIDENCE_HE: Record<string, string> = {
  high: "גבוה",
  medium: "בינוני",
  low: "נמוך",
};

function mapDirectionHe(d: string): string {
  if (d === "expense") return "הוצאה";
  if (d === "income") return "הכנסה";
  if (d === "unknown") return "לא ידוע";
  return d || "לא ידוע";
}

function mapStatusHe(status: string | undefined): string {
  return status === "approved" ? "מאושר" : "ממתין";
}

function mapConfidenceHe(
  label: string | null | undefined,
  score: number | null | undefined
): string {
  const l = (label || "").toLowerCase();
  if (l && CONFIDENCE_HE[l]) return CONFIDENCE_HE[l];
  if (score != null && !Number.isNaN(Number(score))) {
    return `${Math.round(Number(score) * 100)}%`;
  }
  return "לא ידוע";
}

function formatDateIl(d: Date): string {
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const y = d.getFullYear();
  return `${day}/${month}/${y}`;
}

/** Same path pattern as files inside the ZIP (approved|pending/doc-<id>.<ext>). */
function sourceFileLabel(
  doc:
    | { id: number; status: string; fileUrl: string | null }
    | null
    | undefined
): string {
  if (!doc?.fileUrl) return "";
  const folder = doc.status === "approved" ? "approved" : "pending";
  const ext = doc.fileUrl.split(".").pop() || "file";
  return `${folder}/doc-${doc.id}.${ext}`;
}

/** User-facing column order (XLSX + Meta CSV). */
const REPORT_COLUMN_HEADERS = [
  "תאריך עסקה",
  "ספק",
  "קטגוריה",
  "סכום",
  "כיוון",
  "סטטוס מסמך",
  "רמת ביטחון בנתונים",
  "קובץ מקור",
] as const;

/**
 * Semicolon — `_meta` CSV for scripts / debug.
 *
 * The BOM / `sep=;` / CRLF / always-quote behaviour first proven here is now
 * owned by the canonical writer (`lib/data-transfer/format/csv-writer.ts`),
 * which this file delegates to. The byte layout is unchanged for ordinary data.
 *
 * SECURITY (intentional behaviour change): the local `escapeCsvField` that this
 * replaced quoted every field but did NOT neutralize spreadsheet formulas.
 * Quoting is a CSV-PARSING rule, not a formula-EVALUATION rule, so an OCR'd
 * `vendorName` beginning with `=`, `+`, `@`, TAB or CR became executable
 * content the moment the accountant opened the pack. The canonical writer
 * prefixes such a value with `'`. Plain numbers are exempt, so every negative
 * `amount` still exports as a real number.
 */
const ACCOUNTANT_CSV_SEP = ";";

export function resolveExportDateRange(body: AccountantPackBody): {
  fromDate: Date | undefined;
  toDate: Date | undefined;
  periodLabel: string;
} {
  const { type, month, year, quarter } = body;
  let fromDate: Date | undefined;
  let toDate: Date | undefined;
  let periodLabel = "unknown";

  if (type === "month" && month) {
    const [y, m] = month.split("-").map(Number);
    fromDate = new Date(y, m - 1, 1);
    toDate = new Date(y, m, 0, 23, 59, 59);
    periodLabel = month;
  }

  if (type === "year") {
    const currentYear = new Date().getFullYear() - 1;
    fromDate = new Date(currentYear, 0, 1);
    toDate = new Date(currentYear, 11, 31, 23, 59, 59);
    periodLabel = String(currentYear);
  }

  if (type === "quarter" && year && quarter) {
    const q = Number(quarter);
    const y = Number(year);
    const startMonth = (q - 1) * 3;
    const endMonth = startMonth + 2;
    fromDate = new Date(y, startMonth, 1);
    toDate = new Date(y, endMonth + 1, 0, 23, 59, 59);
    periodLabel = `${year}-Q${quarter}`;
  }

  return { fromDate, toDate, periodLabel };
}

function categoryLabel(value: string): string {
  return CATEGORY_MAP[value] ?? value;
}

function transactionDateOnly(d: Date): Date {
  const x = new Date(d);
  return new Date(x.getFullYear(), x.getMonth(), x.getDate());
}

function loadRecordsForExport(
  businessId: number,
  fromDate: Date | undefined,
  toDate: Date | undefined,
  categories: string[] | undefined
) {
  return dbStep((db) => db.financialRecord.findMany({
    where: {
      businessId,
      ...(fromDate && toDate
        ? {
            date: {
              gte: fromDate,
              lte: toDate,
            },
          }
        : {}),
      ...(categories && categories.length > 0
        ? {
            category: {
              in: categories,
            },
          }
        : {}),
    },
    include: {
      document: {
        include: {
          extractedData: true,
        },
      },
    },
    orderBy: { date: "asc" },
  }));
}

/** Column order matches REPORT_COLUMN_HEADERS exactly. */
function toAccountantCsvRow(
  r: Awaited<ReturnType<typeof loadRecordsForExport>>[number]
): (string | number)[] {
  const doc = r.document;
  const ex = doc?.extractedData;
  const confidence = mapConfidenceHe(
    ex?.amountConfidence ?? undefined,
    ex?.confidenceScore ?? undefined
  );
  return [
    formatDateIl(new Date(r.date)),
    r.vendorName,
    categoryLabel(r.category),
    r.amount,
    mapDirectionHe(r.direction),
    mapStatusHe(doc?.status),
    confidence,
    sourceFileLabel(doc ?? undefined),
  ];
}

/** Exported for the deterministic regression proof; not part of the ZIP API. */
export function buildAccountantCsvText(
  records: Awaited<ReturnType<typeof loadRecordsForExport>>
): string {
  return writeCsvText(REPORT_COLUMN_HEADERS, records.map(toAccountantCsvRow), {
    delimiter: ACCOUNTANT_CSV_SEP,
    excelSepDirective: true,
    eol: "\r\n",
  });
}

/** Exported for the deterministic regression proof; not part of the ZIP API. */
export function buildAccountantCsvBuffer(
  records: Awaited<ReturnType<typeof loadRecordsForExport>>
): Buffer {
  return writeCsvBuffer(REPORT_COLUMN_HEADERS, records.map(toAccountantCsvRow), {
    delimiter: ACCOUNTANT_CSV_SEP,
    excelSepDirective: true,
    eol: "\r\n",
  });
}

const COL_WIDTHS = [14, 28, 16, 12, 12, 14, 22, 36];

async function buildAccountantXlsxBuffer(
  records: Awaited<ReturnType<typeof loadRecordsForExport>>
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet("דוח", {
    views: [
      {
        rightToLeft: true,
        state: "frozen",
        ySplit: 1,
        xSplit: 0,
      },
    ],
  });

  for (let c = 1; c <= COL_WIDTHS.length; c++) {
    ws.getColumn(c).width = COL_WIDTHS[c - 1];
  }

  const headerRow = ws.getRow(1);
  REPORT_COLUMN_HEADERS.forEach((title, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = title;
    cell.font = { bold: true };
  });

  let rowNum = 2;
  for (const r of records) {
    const doc = r.document;
    const ex = doc?.extractedData;
    const confidence = mapConfidenceHe(
      ex?.amountConfidence ?? undefined,
      ex?.confidenceScore ?? undefined
    );

    const row = ws.getRow(rowNum);
    row.getCell(1).value = transactionDateOnly(new Date(r.date));
    row.getCell(1).numFmt = "dd/mm/yyyy";

    row.getCell(2).value = r.vendorName;
    row.getCell(3).value = categoryLabel(r.category);

    row.getCell(4).value = Number(r.amount);
    row.getCell(4).numFmt = "#,##0.00";

    row.getCell(5).value = mapDirectionHe(r.direction);
    row.getCell(6).value = mapStatusHe(doc?.status);
    row.getCell(7).value = confidence;
    row.getCell(8).value = sourceFileLabel(doc ?? undefined);

    rowNum += 1;
  }

  const lastDataRow = records.length + 1;

  if (records.length > 0) {
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: lastDataRow, column: 8 },
    };

    // Direction-aware totals: income and expense must never be summed into one
    // figure on an accountant-facing report (they are opposing signs).
    const sumExpense = records.reduce(
      (acc, rec) => acc + (rec.direction === "income" ? 0 : Number(rec.amount)),
      0
    );
    const sumIncome = records.reduce(
      (acc, rec) => acc + (rec.direction === "income" ? Number(rec.amount) : 0),
      0
    );

    const writeTotalRow = (
      rowIndex: number,
      label: string,
      directionHe: string,
      cached: number
    ) => {
      const row = ws.getRow(rowIndex);
      row.getCell(1).value = label;
      row.getCell(1).font = { bold: true };
      row.getCell(4).value = {
        formula: `SUMIF(E2:E${lastDataRow},"${directionHe}",D2:D${lastDataRow})`,
        result: cached,
      };
      row.getCell(4).numFmt = "#,##0.00";
      row.getCell(4).font = { bold: true };
    };

    // "expense" bucket intentionally uses the same catch-all the data rows use:
    // anything that is not income renders as הוצאה/לא ידוע. SUMIF on הוצאה would
    // silently drop "לא ידוע" rows, so the expense total subtracts income instead.
    const expenseRowIndex = lastDataRow + 1;
    const incomeRowIndex = lastDataRow + 2;
    const expenseRow = ws.getRow(expenseRowIndex);
    expenseRow.getCell(1).value = "סה״כ הוצאות";
    expenseRow.getCell(1).font = { bold: true };
    expenseRow.getCell(4).value = {
      formula: `SUM(D2:D${lastDataRow})-SUMIF(E2:E${lastDataRow},"הכנסה",D2:D${lastDataRow})`,
      result: sumExpense,
    };
    expenseRow.getCell(4).numFmt = "#,##0.00";
    expenseRow.getCell(4).font = { bold: true };
    writeTotalRow(incomeRowIndex, "סה״כ הכנסות", "הכנסה", sumIncome);
  }

  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

function buildSummaryText(params: {
  periodLabel: string;
  recordCount: number;
  approvedFiles: number;
  pendingFiles: number;
  missingCount: number;
}): string {
  const lines = [
    "חבילת רואה חשבון",
    `תקופה: ${params.periodLabel}`,
    `נוצר: ${new Date().toLocaleString("he-IL")}`,
    `רשומות בדוח: ${params.recordCount}`,
    `קבצים בתיקיית מאושרים: ${params.approvedFiles}`,
    `קבצים בתיקיית ממתינים: ${params.pendingFiles}`,
    `קבצים חסרים באחסון: ${params.missingCount}`,
  ];
  return lines.join("\n");
}

export async function appendAccountantPackToArchive(
  archive: archiver.Archiver,
  businessId: number,
  body: AccountantPackBody
): Promise<void> {
  const { fromDate, toDate, periodLabel } = resolveExportDateRange(body);
  const categories = body.categories;

  const records = await loadRecordsForExport(
    businessId,
    fromDate,
    toDate,
    categories
  );

  const reportBase = `דוח_${periodLabel}`;
  const xlsxName = `${reportBase}.xlsx`;
  const metaCsvPath = `_meta/${reportBase}.csv`;

  const xlsxBuf = await buildAccountantXlsxBuffer(records);
  archive.append(xlsxBuf, { name: xlsxName });

  archive.append(buildAccountantCsvBuffer(records), { name: metaCsvPath });

  const manifestFiles: string[] = [xlsxName, "סיכום.txt", metaCsvPath];
  const missingLines: string[] = [];

  let approvedFiles = 0;
  let pendingFiles = 0;
  let missingCount = 0;

  const seenDocIds = new Set<number>();

  type FetchTarget = {
    docId: number;
    folder: "approved" | "pending";
    basename: string;
  };

  const targets: FetchTarget[] = [];

  for (const r of records) {
    const doc = r.document;
    if (!doc?.id || seenDocIds.has(doc.id)) continue;
    seenDocIds.add(doc.id);

    const folder = doc.status === "approved" ? "approved" : "pending";
    if (!doc.fileUrl) {
      missingLines.push(`document ${doc.id}: אין נתיב קובץ`);
      missingCount += 1;
      continue;
    }

    const basename = String(doc.fileUrl ?? "").trim();
    if (!STORED_DOCUMENT_FILENAME_REGEX.test(basename)) {
      missingLines.push(`document ${doc.id}: נתיב לא תקין (${doc.fileUrl})`);
      missingCount += 1;
      continue;
    }

    targets.push({ docId: doc.id, folder, basename });
  }

  // Storage reads run with bounded concurrency: a real month is dozens of
  // originals, and fetching them one-by-one puts N×RTT on a serverless clock.
  // Order of ZIP entries is preserved by appending from the ordered results.
  const fetched = await mapWithConcurrency(
    targets,
    EXPORT_FILE_FETCH_CONCURRENCY,
    async (t) => {
      try {
        return { t, buffer: await readDocumentObject(businessId, t.basename) };
      } catch (e) {
        return { t, buffer: null, error: e as unknown };
      }
    }
  );

  for (const item of fetched) {
    const { t } = item;
    if (item.buffer) {
      const ext = t.basename.split(".").pop() || "file";
      const entryName = `${t.folder}/doc-${t.docId}.${ext}`;
      // store: originals are already-compressed media (PDF/JPEG/PNG) —
      // re-DEFLATE-ing them burns CPU for ~0% size gain.
      archive.append(item.buffer, { name: entryName, store: true });
      manifestFiles.push(entryName);
      if (t.folder === "approved") approvedFiles += 1;
      else pendingFiles += 1;
    } else {
      if (item.error instanceof StorageObjectNotFoundError) {
        missingLines.push(`document ${t.docId}: קובץ לא נמצא (${t.basename})`);
      } else {
        console.error(
          "File read failed for export:",
          t.docId,
          t.basename,
          item.error
        );
        missingLines.push(`document ${t.docId}: כשל בקריאה (${t.basename})`);
      }
      missingCount += 1;
    }
  }

  if (approvedFiles === 0) {
    archive.append(Buffer.alloc(0), { name: "approved/.keep" });
  }
  if (pendingFiles === 0) {
    archive.append(Buffer.alloc(0), { name: "pending/.keep" });
  }

  const summaryFinal = buildSummaryText({
    periodLabel,
    recordCount: records.length,
    approvedFiles,
    pendingFiles,
    missingCount,
  });
  archive.append(summaryFinal, { name: "סיכום.txt" });

  const manifest = {
    period: periodLabel,
    generatedAt: new Date().toISOString(),
    recordCount: records.length,
    approvedFiles,
    pendingFiles,
    missingFiles: missingCount,
    entries: [
      ...manifestFiles,
      "_meta/manifest.json",
      "_meta/missing-files.txt",
    ].sort(),
  };
  archive.append(JSON.stringify(manifest, null, 2), {
    name: "_meta/manifest.json",
  });

  const missingBody =
    missingLines.length > 0
      ? missingLines.join("\n") + "\n"
      : "(אין קבצים חסרים)\n";
  archive.append(missingBody, { name: "_meta/missing-files.txt" });
}

const EXPORT_FILE_FETCH_CONCURRENCY = 5;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, Math.max(items.length, 1)) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

/**
 * Re-exported from `lib/archive/zip-buffer.ts`, where the implementation now
 * lives unchanged. It moved because the Import/Export Center needs the same
 * collector for multi-domain CSV archives, and importing it from THIS module
 * would have pulled Prisma, object storage and ExcelJS into a path that needs
 * none of them. Existing callers and tests import it from here and are
 * unaffected.
 */
export { collectArchiveToBuffer };

/** Builds the full accountant pack as a single in-memory ZIP Buffer. */
export async function buildAccountantPackZipBuffer(
  businessId: number,
  body: AccountantPackBody
): Promise<Buffer> {
  return collectArchiveToBuffer((archive) =>
    appendAccountantPackToArchive(archive, businessId, body)
  );
}
