import ExcelJS from "exceljs";
import type { Prisma } from "@prisma/client";
import {
  readDocumentObject,
  STORED_DOCUMENT_FILENAME_REGEX,
} from "@/lib/services/documents/document-storage.service";
import { StorageObjectNotFoundError } from "@/lib/storage/storage.errors";

/**
 * Accountant Package — Phase A.2: real Exceptions Report (02_Exceptions_Report.xlsx).
 *
 * Built ONLY from data that already exists in the system:
 *   • approved FinancialRecords in the period (+ their Document),
 *   • pending (not-approved) Documents whose extracted date falls in the period,
 *   • the set of documents whose source file could not be packaged.
 *
 * It intentionally does NOT invent exceptions that have no proven data source
 * (bank-without-document, payment matching, advanced VAT gaps, allocation
 * numbers, OCR numbering gaps). Tax-ID checking is NOT AVAILABLE because the
 * extraction layer does not persist a vendor tax id — that is surfaced honestly
 * as a single Info row rather than fabricated per record.
 */

export type ExceptionSeverity = "Critical" | "Warning" | "Info";

export type ExceptionTypeKey =
  | "MISSING_AMOUNT"
  | "MISSING_DATE"
  | "MISSING_SOURCE_FILE"
  | "MISSING_VENDOR"
  | "PENDING_NOT_APPROVED"
  | "MISSING_VENDOR_TAX_ID"
  | "MISSING_DOCUMENT_NUMBER";

export type ExceptionRow = {
  severity: ExceptionSeverity;
  typeKey: ExceptionTypeKey;
  typeLabel: string;
  recordType: "FinancialRecord" | "Document";
  recordId: number;
  date: Date | null;
  vendor: string | null;
  amount: number | null;
  description: string;
  suggestedAction: string;
};

export type ExceptionsSummaryRow = {
  typeKey: ExceptionTypeKey;
  typeLabel: string;
  count: number;
  criticalCount: number;
  warningCount: number;
};

export type ExceptionsResult = {
  rows: ExceptionRow[];
  summary: ExceptionsSummaryRow[];
  totals: { critical: number; warning: number; info: number; total: number };
};

const TYPE_LABEL: Record<ExceptionTypeKey, string> = {
  MISSING_AMOUNT: "חסר סכום",
  MISSING_DATE: "חסר תאריך",
  MISSING_SOURCE_FILE: "קובץ מקור חסר",
  MISSING_VENDOR: "חסר ספק",
  PENDING_NOT_APPROVED: "מסמך לא מאושר",
  MISSING_VENDOR_TAX_ID: "חסר ח.פ/ע.מ",
  MISSING_DOCUMENT_NUMBER: "חסר מספר מסמך",
};

const SEVERITY_LABEL: Record<ExceptionSeverity, string> = {
  Critical: "קריטי",
  Warning: "אזהרה",
  Info: "מידע",
};

// Inputs are typed structurally so callers can pass already-loaded rows
// (export path) or freshly-loaded rows (close path) without coupling.
export type ApprovedRecordInput = {
  id: number;
  amount: number;
  date: Date;
  vendorName: string;
  vendorTaxId: string | null;
  documentNumber: string | null;
  document: { id: number; status: string; fileUrl: string | null } | null;
};

export type PendingDocInput = {
  id: number;
  status: string;
  fileUrl: string | null;
  extractedData: {
    amount: number | null;
    date: Date | null;
    vendorName: string | null;
    vendorTaxId: string | null;
    documentNumber: string | null;
  } | null;
};

export type ExceptionInputs = {
  approvedRecords: ApprovedRecordInput[];
  pendingDocs: PendingDocInput[];
  /** Document ids whose source file is missing / could not be packaged. */
  missingFileDocIds: ReadonlySet<number>;
};

function hasValidAmount(amount: number | null | undefined): boolean {
  return typeof amount === "number" && Number.isFinite(amount) && amount > 0;
}

function hasVendor(vendor: string | null | undefined): boolean {
  return Boolean(vendor && vendor.trim().length > 0);
}

function hasValidDate(date: Date | null | undefined): boolean {
  return date instanceof Date && !Number.isNaN(date.getTime());
}

function row(
  partial: Omit<ExceptionRow, "typeLabel">
): ExceptionRow {
  return { ...partial, typeLabel: TYPE_LABEL[partial.typeKey] };
}

/**
 * Pure exception derivation. No IO — file existence is provided via
 * `missingFileDocIds` so this can run identically on both the export path and
 * the month-close gate.
 */
export function computeExceptionRows(inputs: ExceptionInputs): ExceptionRow[] {
  const { approvedRecords, pendingDocs, missingFileDocIds } = inputs;
  const rows: ExceptionRow[] = [];

  for (const r of approvedRecords) {
    const doc = r.document;

    if (!hasValidAmount(r.amount)) {
      rows.push(
        row({
          severity: "Critical",
          typeKey: "MISSING_AMOUNT",
          recordType: "FinancialRecord",
          recordId: r.id,
          date: r.date ?? null,
          vendor: r.vendorName ?? null,
          amount: null,
          description: "רשומה מאושרת ללא סכום תקין",
          suggestedAction: "פתח את המסמך ותקן את הסכום לפני סגירת החודש",
        })
      );
    }

    if (!hasValidDate(r.date)) {
      rows.push(
        row({
          severity: "Critical",
          typeKey: "MISSING_DATE",
          recordType: "FinancialRecord",
          recordId: r.id,
          date: null,
          vendor: r.vendorName ?? null,
          amount: hasValidAmount(r.amount) ? r.amount : null,
          description: "רשומה מאושרת ללא תאריך תקין",
          suggestedAction: "הוסף תאריך עסקה למסמך",
        })
      );
    }

    if (!hasVendor(r.vendorName)) {
      rows.push(
        row({
          severity: "Warning",
          typeKey: "MISSING_VENDOR",
          recordType: "FinancialRecord",
          recordId: r.id,
          date: r.date ?? null,
          amount: hasValidAmount(r.amount) ? r.amount : null,
          vendor: null,
          description: "רשומה מאושרת ללא שם ספק",
          suggestedAction: "השלם את שם הספק",
        })
      );
    }

    const fileMissing =
      !doc ||
      !doc.fileUrl ||
      !STORED_DOCUMENT_FILENAME_REGEX.test(String(doc.fileUrl).trim()) ||
      (doc.id != null && missingFileDocIds.has(doc.id));
    if (fileMissing) {
      rows.push(
        row({
          severity: "Critical",
          typeKey: "MISSING_SOURCE_FILE",
          recordType: "FinancialRecord",
          recordId: r.id,
          date: r.date ?? null,
          vendor: r.vendorName ?? null,
          amount: hasValidAmount(r.amount) ? r.amount : null,
          description: "קובץ המקור של המסמך חסר או לא נארז בחבילה",
          suggestedAction: "העלה מחדש את קובץ המקור של המסמך",
        })
      );
    }

    if (!hasVendor(r.vendorTaxId)) {
      rows.push(
        row({
          severity: "Warning",
          typeKey: "MISSING_VENDOR_TAX_ID",
          recordType: "FinancialRecord",
          recordId: r.id,
          date: r.date ?? null,
          vendor: r.vendorName ?? null,
          amount: hasValidAmount(r.amount) ? r.amount : null,
          description: "רשומה מאושרת ללא ח.פ/ע.מ של הספק",
          suggestedAction: "השלם את מספר העוסק/ח.פ של הספק",
        })
      );
    }

    if (!hasVendor(r.documentNumber)) {
      rows.push(
        row({
          severity: "Warning",
          typeKey: "MISSING_DOCUMENT_NUMBER",
          recordType: "FinancialRecord",
          recordId: r.id,
          date: r.date ?? null,
          vendor: r.vendorName ?? null,
          amount: hasValidAmount(r.amount) ? r.amount : null,
          description: "רשומה מאושרת ללא מספר מסמך",
          suggestedAction: "השלם את מספר החשבונית/קבלה",
        })
      );
    }
  }

  for (const d of pendingDocs) {
    const ex = d.extractedData;

    rows.push(
      row({
        severity: "Warning",
        typeKey: "PENDING_NOT_APPROVED",
        recordType: "Document",
        recordId: d.id,
        date: ex?.date ?? null,
        vendor: ex?.vendorName ?? null,
        amount: hasValidAmount(ex?.amount) ? (ex?.amount as number) : null,
        description: "מסמך בתקופה שעדיין לא אומת/אושר",
        suggestedAction: "אמת את המסמך כדי שייכלל בדוח החודשי",
      })
    );

    if (!hasValidAmount(ex?.amount)) {
      rows.push(
        row({
          severity: "Critical",
          typeKey: "MISSING_AMOUNT",
          recordType: "Document",
          recordId: d.id,
          date: ex?.date ?? null,
          vendor: ex?.vendorName ?? null,
          amount: null,
          description: "מסמך ממתין ללא סכום תקין",
          suggestedAction: "השלם את הסכום במסך האימות",
        })
      );
    }

    if (!hasValidDate(ex?.date ?? null)) {
      rows.push(
        row({
          severity: "Critical",
          typeKey: "MISSING_DATE",
          recordType: "Document",
          recordId: d.id,
          date: null,
          vendor: ex?.vendorName ?? null,
          amount: hasValidAmount(ex?.amount) ? (ex?.amount as number) : null,
          description: "מסמך ממתין ללא תאריך תקין",
          suggestedAction: "הוסף תאריך עסקה במסך האימות",
        })
      );
    }

    if (!hasVendor(ex?.vendorName)) {
      rows.push(
        row({
          severity: "Warning",
          typeKey: "MISSING_VENDOR",
          recordType: "Document",
          recordId: d.id,
          date: ex?.date ?? null,
          amount: hasValidAmount(ex?.amount) ? (ex?.amount as number) : null,
          vendor: null,
          description: "מסמך ממתין ללא שם ספק",
          suggestedAction: "השלם את שם הספק במסך האימות",
        })
      );
    }

    const fileMissing =
      !d.fileUrl ||
      !STORED_DOCUMENT_FILENAME_REGEX.test(String(d.fileUrl).trim()) ||
      missingFileDocIds.has(d.id);
    if (fileMissing) {
      rows.push(
        row({
          severity: "Critical",
          typeKey: "MISSING_SOURCE_FILE",
          recordType: "Document",
          recordId: d.id,
          date: ex?.date ?? null,
          vendor: ex?.vendorName ?? null,
          amount: hasValidAmount(ex?.amount) ? (ex?.amount as number) : null,
          description: "קובץ המקור של המסמך הממתין חסר",
          suggestedAction: "העלה מחדש את קובץ המקור של המסמך",
        })
      );
    }

    if (!hasVendor(ex?.vendorTaxId)) {
      rows.push(
        row({
          severity: "Warning",
          typeKey: "MISSING_VENDOR_TAX_ID",
          recordType: "Document",
          recordId: d.id,
          date: ex?.date ?? null,
          vendor: ex?.vendorName ?? null,
          amount: hasValidAmount(ex?.amount) ? (ex?.amount as number) : null,
          description: "מסמך ממתין ללא ח.פ/ע.מ של הספק",
          suggestedAction: "השלם את מספר העוסק/ח.פ של הספק במסך האימות",
        })
      );
    }

    if (!hasVendor(ex?.documentNumber)) {
      rows.push(
        row({
          severity: "Warning",
          typeKey: "MISSING_DOCUMENT_NUMBER",
          recordType: "Document",
          recordId: d.id,
          date: ex?.date ?? null,
          vendor: ex?.vendorName ?? null,
          amount: hasValidAmount(ex?.amount) ? (ex?.amount as number) : null,
          description: "מסמך ממתין ללא מספר מסמך",
          suggestedAction: "השלם את מספר החשבונית/קבלה במסך האימות",
        })
      );
    }
  }

  return rows;
}

export function summarizeExceptions(rows: ExceptionRow[]): ExceptionsResult {
  const byType = new Map<ExceptionTypeKey, ExceptionsSummaryRow>();
  let critical = 0;
  let warning = 0;
  let info = 0;

  for (const r of rows) {
    if (r.severity === "Critical") critical += 1;
    else if (r.severity === "Warning") warning += 1;
    else info += 1;

    const existing =
      byType.get(r.typeKey) ??
      ({
        typeKey: r.typeKey,
        typeLabel: r.typeLabel,
        count: 0,
        criticalCount: 0,
        warningCount: 0,
      } satisfies ExceptionsSummaryRow);
    existing.count += 1;
    if (r.severity === "Critical") existing.criticalCount += 1;
    if (r.severity === "Warning") existing.warningCount += 1;
    byType.set(r.typeKey, existing);
  }

  return {
    rows,
    summary: [...byType.values()],
    totals: { critical, warning, info, total: rows.length },
  };
}

function formatDateIl(d: Date | null): string {
  if (!d) return "";
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${d.getFullYear()}`;
}

const SUMMARY_HEADERS = [
  "סוג חריגה",
  "סה״כ",
  "קריטי",
  "אזהרה",
] as const;

const DETAIL_HEADERS = [
  "חומרה",
  "סוג חריגה",
  "סוג רשומה",
  "מזהה רשומה",
  "תאריך",
  "ספק",
  "סכום",
  "תיאור",
  "פעולה מומלצת",
] as const;

const SUMMARY_WIDTHS = [22, 10, 10, 10];
const DETAIL_WIDTHS = [10, 18, 16, 12, 14, 26, 12, 40, 40];

export async function buildExceptionsXlsxBuffer(
  result: ExceptionsResult,
  periodLabel: string
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  // --- Summary sheet ---
  const summaryWs = workbook.addWorksheet("Summary", {
    views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }],
  });
  SUMMARY_WIDTHS.forEach((w, i) => (summaryWs.getColumn(i + 1).width = w));

  const sTitle = summaryWs.getRow(1);
  SUMMARY_HEADERS.forEach((title, i) => {
    const cell = sTitle.getCell(i + 1);
    cell.value = title;
    cell.font = { bold: true };
  });

  let sRow = 2;
  for (const s of result.summary) {
    const r = summaryWs.getRow(sRow);
    r.getCell(1).value = s.typeLabel;
    r.getCell(2).value = s.count;
    r.getCell(3).value = s.criticalCount;
    r.getCell(4).value = s.warningCount;
    sRow += 1;
  }
  const totalRow = summaryWs.getRow(sRow + 1);
  totalRow.getCell(1).value = "סה״כ";
  totalRow.getCell(1).font = { bold: true };
  totalRow.getCell(2).value = result.totals.total;
  totalRow.getCell(3).value = result.totals.critical;
  totalRow.getCell(4).value = result.totals.warning;
  totalRow.font = { bold: true };

  const metaRow = summaryWs.getRow(sRow + 3);
  metaRow.getCell(1).value = `תקופה: ${periodLabel}`;
  summaryWs.getRow(sRow + 4).getCell(1).value =
    `נוצר: ${new Date().toLocaleString("he-IL")}`;

  // --- Details sheet ---
  const detailWs = workbook.addWorksheet("Details", {
    views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }],
  });
  DETAIL_WIDTHS.forEach((w, i) => (detailWs.getColumn(i + 1).width = w));

  const dTitle = detailWs.getRow(1);
  DETAIL_HEADERS.forEach((title, i) => {
    const cell = dTitle.getCell(i + 1);
    cell.value = title;
    cell.font = { bold: true };
  });

  let dRow = 2;
  for (const e of result.rows) {
    const r = detailWs.getRow(dRow);
    r.getCell(1).value = SEVERITY_LABEL[e.severity];
    r.getCell(2).value = e.typeLabel;
    r.getCell(3).value =
      e.recordType === "FinancialRecord" ? "רשומה פיננסית" : "מסמך";
    r.getCell(4).value = e.recordId > 0 ? e.recordId : "";
    r.getCell(5).value = formatDateIl(e.date);
    r.getCell(6).value = e.vendor ?? "";
    if (e.amount != null) {
      r.getCell(7).value = e.amount;
      r.getCell(7).numFmt = "#,##0.00";
    }
    r.getCell(8).value = e.description;
    r.getCell(9).value = e.suggestedAction;
    dRow += 1;
  }

  if (result.rows.length > 0) {
    detailWs.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: result.rows.length + 1, column: DETAIL_HEADERS.length },
    };
  }

  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

// ---------------------------------------------------------------------------
// Loaders (used by the month-close gate; the export path reuses its own
// already-loaded records and only adds pending docs + the packaged-missing set).
// ---------------------------------------------------------------------------

export function loadApprovedRecordsForPeriod(
  db: Prisma.TransactionClient,
  businessId: number,
  fromDate: Date | undefined,
  toDate: Date | undefined,
  categories: string[] | undefined
) {
  return db.financialRecord.findMany({
    where: {
      businessId,
      ...(fromDate && toDate ? { date: { gte: fromDate, lte: toDate } } : {}),
      ...(categories && categories.length > 0
        ? { category: { in: categories } }
        : {}),
    },
    include: { document: true },
    orderBy: { date: "asc" },
  });
}

export function loadPendingDocsForPeriod(
  db: Prisma.TransactionClient,
  businessId: number,
  fromDate: Date | undefined,
  toDate: Date | undefined,
  categories: string[] | undefined
) {
  return db.document.findMany({
    where: {
      businessId,
      status: { not: "approved" },
      financialRecord: { is: null },
      extractedData: {
        is: {
          ...(fromDate && toDate ? { date: { gte: fromDate, lte: toDate } } : {}),
          ...(categories && categories.length > 0
            ? { category: { in: categories } }
            : {}),
        },
      },
    },
    include: { extractedData: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Resolves which documents have a missing/unreadable source file by probing
 * storage. Used by the month-close gate (the export path already learns this
 * while packaging and passes its own set instead).
 */
export async function resolveMissingSourceFiles(
  businessId: number,
  docs: { id: number; fileUrl: string | null }[]
): Promise<Set<number>> {
  const missing = new Set<number>();
  const seen = new Set<number>();

  for (const doc of docs) {
    if (seen.has(doc.id)) continue;
    seen.add(doc.id);

    const basename = String(doc.fileUrl ?? "").trim();
    if (!basename || !STORED_DOCUMENT_FILENAME_REGEX.test(basename)) {
      missing.add(doc.id);
      continue;
    }
    try {
      await readDocumentObject(businessId, basename);
    } catch (e) {
      if (e instanceof StorageObjectNotFoundError) {
        missing.add(doc.id);
      } else {
        // Unknown read failure — treat as missing for the close gate (fail-safe).
        console.error("Exceptions file probe failed:", doc.id, doc.fileUrl, e);
        missing.add(doc.id);
      }
    }
  }

  return missing;
}

/**
 * Full exception computation for a period, including storage probing. Used by
 * the month-close gate to decide whether Critical exceptions block the close.
 */
export async function computeExceptionsForPeriod(
  db: Prisma.TransactionClient,
  input: {
    businessId: number;
    fromDate: Date | undefined;
    toDate: Date | undefined;
    categories: string[] | undefined;
  }
): Promise<ExceptionsResult> {
  const { businessId, fromDate, toDate, categories } = input;

  const [approvedRecords, pendingDocs] = await Promise.all([
    loadApprovedRecordsForPeriod(db, businessId, fromDate, toDate, categories),
    loadPendingDocsForPeriod(db, businessId, fromDate, toDate, categories),
  ]);

  const probeTargets: { id: number; fileUrl: string | null }[] = [
    ...approvedRecords
      .map((r) => r.document)
      .filter((d): d is NonNullable<typeof d> => Boolean(d))
      .map((d) => ({ id: d.id, fileUrl: d.fileUrl })),
    ...pendingDocs.map((d) => ({ id: d.id, fileUrl: d.fileUrl })),
  ];

  const missingFileDocIds = await resolveMissingSourceFiles(
    businessId,
    probeTargets
  );

  const rows = computeExceptionRows({
    approvedRecords: approvedRecords.map((r) => ({
      id: r.id,
      amount: r.amount,
      date: r.date,
      vendorName: r.vendorName,
      vendorTaxId: r.vendorTaxId,
      documentNumber: r.documentNumber,
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
            vendorTaxId: d.extractedData.vendorTaxId,
            documentNumber: d.extractedData.documentNumber,
          }
        : null,
    })),
    missingFileDocIds,
  });

  return summarizeExceptions(rows);
}
