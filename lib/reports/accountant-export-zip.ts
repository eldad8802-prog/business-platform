import type archiver from "archiver";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import {
  readDocumentObject,
  STORED_DOCUMENT_FILENAME_REGEX,
} from "@/lib/services/documents/document-storage.service";
import { StorageObjectNotFoundError } from "@/lib/storage/storage.errors";
import { CATEGORY_MAP } from "@/lib/constants/categories";
import {
  buildExceptionsXlsxBuffer,
  computeExceptionRows,
  loadPendingDocsForPeriod,
  summarizeExceptions,
} from "@/lib/reports/exceptions-report";
import { markPackageGenerated } from "@/lib/services/accounting/month-close.service";

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

/** Semicolon — `_meta` CSV for scripts / debug. */
const ACCOUNTANT_CSV_SEP = ";";

const EXCEL_SEPARATOR_DIRECTIVE = "sep=;";

const UTF8_BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf]);

function escapeCsvField(value: string | number): string {
  const s = String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

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
  return prisma.financialRecord.findMany({
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
  });
}

function buildAccountantCsvText(
  records: Awaited<ReturnType<typeof loadRecordsForExport>>
): string {
  const headerLine = REPORT_COLUMN_HEADERS.map(escapeCsvField).join(
    ACCOUNTANT_CSV_SEP
  );
  const lines: string[] = [EXCEL_SEPARATOR_DIRECTIVE, headerLine];

  for (const r of records) {
    const doc = r.document;
    const ex = doc?.extractedData;
    const confidence = mapConfidenceHe(
      ex?.amountConfidence ?? undefined,
      ex?.confidenceScore ?? undefined
    );
    const row = [
      formatDateIl(new Date(r.date)),
      r.vendorName,
      categoryLabel(r.category),
      r.amount,
      mapDirectionHe(r.direction),
      mapStatusHe(doc?.status),
      confidence,
      sourceFileLabel(doc ?? undefined),
    ].map(escapeCsvField);
    lines.push(row.join(ACCOUNTANT_CSV_SEP));
  }

  return lines.join("\r\n");
}

function buildAccountantCsvBuffer(
  records: Awaited<ReturnType<typeof loadRecordsForExport>>
): Buffer {
  return Buffer.concat([
    UTF8_BOM_BYTES,
    Buffer.from(buildAccountantCsvText(records), "utf8"),
  ]);
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

    const sumAmount = records.reduce(
      (acc, rec) => acc + Number(rec.amount),
      0
    );
    const totalRowIndex = lastDataRow + 1;
    const totalRow = ws.getRow(totalRowIndex);
    totalRow.getCell(1).value = "סה״כ";
    totalRow.getCell(1).font = { bold: true };
    totalRow.getCell(4).value = {
      formula: `SUM(D2:D${lastDataRow})`,
      result: sumAmount,
    };
    totalRow.getCell(4).numFmt = "#,##0.00";
    totalRow.getCell(4).font = { bold: true };
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
  exceptionsCritical: number;
  exceptionsWarning: number;
}): string {
  const lines = [
    "חבילת רואה חשבון",
    `תקופה: ${params.periodLabel}`,
    `נוצר: ${new Date().toLocaleString("he-IL")}`,
    `רשומות בדוח: ${params.recordCount}`,
    `קבצים בתיקיית מאושרים: ${params.approvedFiles}`,
    `קבצים בתיקיית ממתינים: ${params.pendingFiles}`,
    `קבצים חסרים באחסון: ${params.missingCount}`,
    `חריגים קריטיים: ${params.exceptionsCritical}`,
    `חריגים (אזהרה): ${params.exceptionsWarning}`,
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
  // Stable, MVP-canonical name for the monthly summary. Kept ALONGSIDE the
  // legacy localized name so existing consumers do not break.
  const summaryCanonicalName = "01_Monthly_Summary.xlsx";
  const exceptionsName = "02_Exceptions_Report.xlsx";
  const metaCsvPath = `_meta/${reportBase}.csv`;

  const xlsxBuf = await buildAccountantXlsxBuffer(records);
  archive.append(xlsxBuf, { name: xlsxName });
  archive.append(xlsxBuf, { name: summaryCanonicalName });

  archive.append(buildAccountantCsvBuffer(records), { name: metaCsvPath });

  const manifestFiles: string[] = [
    summaryCanonicalName,
    xlsxName,
    exceptionsName,
    "סיכום.txt",
    metaCsvPath,
  ];
  const missingLines: string[] = [];

  let approvedFiles = 0;
  let pendingFiles = 0;
  let missingCount = 0;

  const seenDocIds = new Set<number>();
  const missingFileDocIds = new Set<number>();

  for (const r of records) {
    const doc = r.document;
    if (!doc?.id || seenDocIds.has(doc.id)) continue;
    seenDocIds.add(doc.id);

    const folder = doc.status === "approved" ? "approved" : "pending";
    if (!doc.fileUrl) {
      missingLines.push(`document ${doc.id}: אין נתיב קובץ`);
      missingFileDocIds.add(doc.id);
      missingCount += 1;
      continue;
    }

    const basename = String(doc.fileUrl ?? "").trim();
    if (!STORED_DOCUMENT_FILENAME_REGEX.test(basename)) {
      missingLines.push(`document ${doc.id}: נתיב לא תקין (${doc.fileUrl})`);
      missingFileDocIds.add(doc.id);
      missingCount += 1;
      continue;
    }

    try {
      const buffer = await readDocumentObject(businessId, basename);
      const ext = basename.split(".").pop() || "file";
      const entryName = `${folder}/doc-${doc.id}.${ext}`;
      archive.append(buffer, { name: entryName });
      manifestFiles.push(entryName);
      if (folder === "approved") approvedFiles += 1;
      else pendingFiles += 1;
    } catch (e) {
      if (e instanceof StorageObjectNotFoundError) {
        missingLines.push(`document ${doc.id}: קובץ לא נמצא (${doc.fileUrl})`);
      } else {
        console.error("File read failed for export:", doc.id, doc.fileUrl, e);
        missingLines.push(`document ${doc.id}: כשל בקריאה (${doc.fileUrl})`);
      }
      missingFileDocIds.add(doc.id);
      missingCount += 1;
    }
  }

  if (approvedFiles === 0) {
    archive.append(Buffer.alloc(0), { name: "approved/.keep" });
  }
  if (pendingFiles === 0) {
    archive.append(Buffer.alloc(0), { name: "pending/.keep" });
  }

  // --- Exceptions Report (Phase A.2) ---
  // Reuses the records already loaded for the summary + the set of source files
  // that could not be packaged (no extra storage reads), and adds pending docs.
  const pendingDocs = await loadPendingDocsForPeriod(
    prisma,
    businessId,
    fromDate,
    toDate,
    categories
  );
  const exceptions = summarizeExceptions(
    computeExceptionRows({
      approvedRecords: records.map((r) => ({
        id: r.id,
        amount: r.amount,
        date: r.date,
        vendorName: r.vendorName,
        document: r.document
          ? {
              id: r.document.id,
              status: r.document.status,
              fileUrl: r.document.fileUrl,
            }
          : null,
      })),
      pendingDocs: pendingDocs.map((d) => ({
        id: d.id,
        status: d.status,
        fileUrl: d.fileUrl,
        extractedData: d.extractedData
          ? {
              amount: d.extractedData.amount,
              date: d.extractedData.date,
              vendorName: d.extractedData.vendorName,
            }
          : null,
      })),
      missingFileDocIds,
    })
  );
  const exceptionsBuf = await buildExceptionsXlsxBuffer(exceptions, periodLabel);
  archive.append(exceptionsBuf, { name: exceptionsName });

  const summaryFinal = buildSummaryText({
    periodLabel,
    recordCount: records.length,
    approvedFiles,
    pendingFiles,
    missingCount,
    exceptionsCritical: exceptions.totals.critical,
    exceptionsWarning: exceptions.totals.warning,
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

  // Best-effort: stamp packageGeneratedAt on a closed month (never blocks).
  if (body.type === "month" && body.month) {
    const [y, m] = body.month.split("-").map(Number);
    if (Number.isInteger(y) && Number.isInteger(m)) {
      await markPackageGenerated(prisma, businessId, y, m);
    }
  }
}
