import { createHash } from "node:crypto";
import { collectArchiveToBuffer } from "@/lib/archive/zip-buffer";
import ExcelJS from "exceljs";
import {
  readDocumentObject,
  STORED_DOCUMENT_FILENAME_REGEX,
} from "@/lib/services/documents/document-storage.service";
import { readByKey } from "@/lib/services/billing/pdf/billing-pdf-storage";
import { StorageObjectNotFoundError } from "@/lib/storage/storage.errors";
import { CATEGORY_MAP } from "@/lib/constants/categories";
import {
  writeCsvBuffer,
  writeCsvText,
} from "@/lib/data-transfer/format/csv-writer";
import {
  dateTakenFromUpload,
  evaluateReadiness,
  type IssuedDocumentFact,
  type PeriodFacts,
  type Readiness,
  type ScannedRecordFact,
} from "@/lib/accountant/package-scope";
import { loadPeriodFacts } from "@/lib/accountant/period-facts";
import { resolveExportRequest, type ExportRequestBody, type PeriodRange } from "@/lib/accountant/period";

/**
 * The accountant package ZIP.
 *
 * CONTENTS (see lib/accountant/package-scope.ts for why each source is in or out)
 *   דוח_<period>.xlsx           sheet "דוח" — approved scanned documents (the shipped columns + notes);
 *                               "מסמכים שהופקו" — documents the business issued; "ממתינים"; and
 *                               "סיכום" — totals per issued type and per scanned direction, never mixed.
 *   approved/doc-<id>.<ext>     original files of the scanned documents.
 *   issued/<type>-<number>.pdf  final PDFs of issued documents — only those the delivery gate allows.
 *   סיכום.txt                   what is included, what is not, open items and warnings, in Hebrew.
 *   _meta/…                     the scanned CSV, a manifest and the missing-files list.
 *
 * The package never states that the accounting is complete: it states what Dubiz holds and what is
 * still open. Building it reads files only — nothing is rendered, signed or written here.
 */

export type AccountantPackBody = ExportRequestBody & {
  categories?: string[];
};

/** A request that names no valid period. The route answers 400 instead of exporting everything. */
export class AccountantExportRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AccountantExportRequestError";
  }
}

const CONFIDENCE_HE: Record<string, string> = {
  high: "גבוה",
  medium: "בינוני",
  low: "נמוך",
};

const ISSUED_TYPE_HE: Record<string, string> = {
  TAX_INVOICE: "חשבונית מס",
  TAX_INVOICE_RECEIPT: "חשבונית מס קבלה",
  RECEIPT: "קבלה",
  CREDIT_NOTE: "חשבונית זיכוי",
};

const ISSUED_FILE_SLUG: Record<string, string> = {
  TAX_INVOICE: "invoice",
  TAX_INVOICE_RECEIPT: "invoice-receipt",
  RECEIPT: "receipt",
  CREDIT_NOTE: "credit-note",
};

export function issuedTypeHe(t: string): string {
  return ISSUED_TYPE_HE[t] ?? t;
}

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

/** dd/mm/yyyy of the ISRAELI calendar day of an instant (not of the server's zone). */
export function formatDateIl(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(d);
  const at = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  return `${at("day")}/${at("month")}/${at("year")}`;
}

/** A Date whose local fields equal the Israeli calendar day (ExcelJS writes local date fields). */
function israeliDateCell(d: Date): Date {
  const [day, month, year] = formatDateIl(d).split("/").map(Number);
  return new Date(year, month - 1, day);
}

/** Same path pattern as files inside the ZIP (approved|pending/doc-<id>.<ext>). */
function sourceFileLabel(r: Pick<ScannedRecordFact, "documentId" | "documentStatus" | "fileUrl">): string {
  if (!r.fileUrl) return "";
  const folder = r.documentStatus === "approved" ? "approved" : "pending";
  const ext = r.fileUrl.split(".").pop() || "file";
  return `${folder}/doc-${r.documentId}.${ext}`;
}

export function issuedFileName(d: Pick<IssuedDocumentFact, "id" | "documentType" | "documentNumberFormatted">): string {
  const slug = ISSUED_FILE_SLUG[d.documentType] ?? "document";
  const number = (d.documentNumberFormatted ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60);
  return `issued/${slug}-${number || d.id}.pdf`;
}

/** User-facing column order (XLSX + Meta CSV). "הערות" carries the warnings of a row. */
const REPORT_COLUMN_HEADERS = [
  "תאריך עסקה",
  "ספק",
  "קטגוריה",
  "סכום",
  "כיוון",
  "סטטוס מסמך",
  "רמת ביטחון בנתונים",
  "קובץ מקור",
  "הערות",
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

function categoryLabel(value: string): string {
  return CATEGORY_MAP[value] ?? value;
}

export type RowNotes = Map<number, string[]>;

export function rowNotes(facts: PeriodFacts, readiness: Pick<Readiness, "warnings">): RowNotes {
  const notes: RowNotes = new Map();
  const add = (id: number, note: string) => notes.set(id, [...(notes.get(id) ?? []), note]);
  for (const r of facts.scanned) {
    if (dateTakenFromUpload(r)) add(r.id, "התאריך נלקח ממועד ההעלאה");
  }
  const issuedById = new Map(facts.issued.map((d) => [d.id, d]));
  for (const w of readiness.warnings) {
    if (w.kind !== "POSSIBLE_DUPLICATE_INCOME") continue;
    for (const p of w.pairs) {
      const doc = issuedById.get(p.billingDocumentId);
      add(p.recordId, `ייתכן כפול למסמך שהופק ${doc?.documentNumberFormatted ?? p.billingDocumentId}`);
    }
  }
  return notes;
}

/** Column order matches REPORT_COLUMN_HEADERS exactly. */
function toAccountantCsvRow(r: ScannedRecordFact, notes: RowNotes): (string | number)[] {
  return [
    formatDateIl(r.date),
    r.vendorName,
    categoryLabel(r.category),
    r.amount,
    mapDirectionHe(r.direction),
    mapStatusHe(r.documentStatus),
    mapConfidenceHe(r.confidenceLabel, r.confidenceScore),
    sourceFileLabel(r),
    (notes.get(r.id) ?? []).join(" · "),
  ];
}

/** Exported for the deterministic regression proof; not part of the ZIP API. */
export function buildAccountantCsvText(records: ScannedRecordFact[], notes: RowNotes = new Map()): string {
  return writeCsvText(REPORT_COLUMN_HEADERS, records.map((r) => toAccountantCsvRow(r, notes)), {
    delimiter: ACCOUNTANT_CSV_SEP,
    excelSepDirective: true,
    eol: "\r\n",
  });
}

/** Exported for the deterministic regression proof; not part of the ZIP API. */
export function buildAccountantCsvBuffer(records: ScannedRecordFact[], notes: RowNotes = new Map()): Buffer {
  return writeCsvBuffer(REPORT_COLUMN_HEADERS, records.map((r) => toAccountantCsvRow(r, notes)), {
    delimiter: ACCOUNTANT_CSV_SEP,
    excelSepDirective: true,
    eol: "\r\n",
  });
}

const COL_WIDTHS = [14, 28, 16, 12, 12, 14, 22, 36, 36];

function rtlSheet(workbook: ExcelJS.Workbook, name: string) {
  return workbook.addWorksheet(name, {
    views: [{ rightToLeft: true, state: "frozen", ySplit: 1, xSplit: 0 }],
  });
}

function header(ws: ExcelJS.Worksheet, titles: readonly string[], widths: number[]) {
  const row = ws.getRow(1);
  titles.forEach((title, i) => {
    row.getCell(i + 1).value = title;
    row.getCell(i + 1).font = { bold: true };
    ws.getColumn(i + 1).width = widths[i] ?? 16;
  });
}

const PENDING_STATUS_HE: Record<string, string> = {
  needs_review: "ממתין לבדיקה",
  processing: "בעיבוד",
  failed: "נכשל בעיבוד",
};

async function buildAccountantXlsxBuffer(
  facts: PeriodFacts,
  readiness: Readiness,
  notes: RowNotes,
  issuedIncluded: Set<number>
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  // ── דוח: approved scanned documents ──
  const ws = rtlSheet(workbook, "דוח");
  header(ws, REPORT_COLUMN_HEADERS, COL_WIDTHS);
  const records = facts.scanned;
  let rowNum = 2;
  for (const r of records) {
    const row = ws.getRow(rowNum);
    row.getCell(1).value = israeliDateCell(r.date);
    row.getCell(1).numFmt = "dd/mm/yyyy";
    row.getCell(2).value = r.vendorName;
    row.getCell(3).value = categoryLabel(r.category);
    row.getCell(4).value = Number(r.amount);
    row.getCell(4).numFmt = "#,##0.00";
    row.getCell(5).value = mapDirectionHe(r.direction);
    row.getCell(6).value = mapStatusHe(r.documentStatus);
    row.getCell(7).value = mapConfidenceHe(r.confidenceLabel, r.confidenceScore);
    row.getCell(8).value = sourceFileLabel(r);
    row.getCell(9).value = (notes.get(r.id) ?? []).join(" · ");
    rowNum += 1;
  }

  const lastDataRow = records.length + 1;
  if (records.length > 0) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: lastDataRow, column: REPORT_COLUMN_HEADERS.length } };

    // Direction-aware totals: income and expense must never be summed into one
    // figure on an accountant-facing report (they are opposing signs).
    const sumExpense = records.reduce((acc, rec) => acc + (rec.direction === "income" ? 0 : Number(rec.amount)), 0);
    const sumIncome = records.reduce((acc, rec) => acc + (rec.direction === "income" ? Number(rec.amount) : 0), 0);

    // "expense" bucket intentionally uses the same catch-all the data rows use:
    // anything that is not income renders as הוצאה/לא ידוע. SUMIF on הוצאה would
    // silently drop "לא ידוע" rows, so the expense total subtracts income instead.
    const expenseRow = ws.getRow(lastDataRow + 1);
    expenseRow.getCell(1).value = "סה״כ הוצאות";
    expenseRow.getCell(1).font = { bold: true };
    expenseRow.getCell(4).value = {
      formula: `SUM(D2:D${lastDataRow})-SUMIF(E2:E${lastDataRow},"הכנסה",D2:D${lastDataRow})`,
      result: sumExpense,
    };
    expenseRow.getCell(4).numFmt = "#,##0.00";
    expenseRow.getCell(4).font = { bold: true };

    const incomeRow = ws.getRow(lastDataRow + 2);
    incomeRow.getCell(1).value = "סה״כ הכנסות";
    incomeRow.getCell(1).font = { bold: true };
    incomeRow.getCell(4).value = {
      formula: `SUMIF(E2:E${lastDataRow},"הכנסה",D2:D${lastDataRow})`,
      result: sumIncome,
    };
    incomeRow.getCell(4).numFmt = "#,##0.00";
    incomeRow.getCell(4).font = { bold: true };
  }

  // ── מסמכים שהופקו: documents the business issued ──
  const issuedHeaders = ["מספר", "סוג", "תאריך הפקה", "לקוח", "לפני מע״מ", "מע״מ", "סה״כ", "מטבע", "מסמך מקור", "קובץ"] as const;
  const wi = rtlSheet(workbook, "מסמכים שהופקו");
  header(wi, issuedHeaders, [16, 18, 14, 28, 14, 12, 14, 8, 16, 36]);
  const issuedById = new Map(facts.issued.map((d) => [d.id, d]));
  facts.issued.forEach((d, i) => {
    const row = wi.getRow(i + 2);
    row.getCell(1).value = d.documentNumberFormatted ?? `#${d.id}`;
    row.getCell(2).value = issuedTypeHe(d.documentType);
    row.getCell(3).value = israeliDateCell(d.issuedAt);
    row.getCell(3).numFmt = "dd/mm/yyyy";
    row.getCell(4).value = d.customerName ?? "";
    row.getCell(5).value = Number(d.subtotalAmount);
    row.getCell(6).value = Number(d.vatAmount);
    row.getCell(7).value = Number(d.totalAmount);
    [5, 6, 7].forEach((c) => (row.getCell(c).numFmt = "#,##0.00"));
    row.getCell(8).value = d.currency;
    const ref = d.referenceDocumentId ? issuedById.get(d.referenceDocumentId) : undefined;
    row.getCell(9).value = d.referenceDocumentId ? (ref?.documentNumberFormatted ?? `#${d.referenceDocumentId}`) : "";
    row.getCell(10).value = issuedIncluded.has(d.id) ? issuedFileName(d) : "הקובץ הסופי עדיין אינו זמין";
  });

  // ── ממתינים: not reviewed yet (listed, never counted) ──
  const wp = rtlSheet(workbook, "ממתינים");
  header(wp, ["מזהה מסמך", "מצב", "הועלה בתאריך", "תאריך שזוהה"], [14, 14, 16, 16]);
  facts.pending.forEach((p, i) => {
    const row = wp.getRow(i + 2);
    row.getCell(1).value = p.id;
    row.getCell(2).value = PENDING_STATUS_HE[p.status] ?? p.status;
    row.getCell(3).value = israeliDateCell(p.createdAt);
    row.getCell(3).numFmt = "dd/mm/yyyy";
    if (p.extractedDate) {
      row.getCell(4).value = israeliDateCell(p.extractedDate);
      row.getCell(4).numFmt = "dd/mm/yyyy";
    }
  });

  // ── סיכום: totals per issued type; scanned per direction; never mixed ──
  const wsum = rtlSheet(workbook, "סיכום");
  header(wsum, ["קבוצה", "מספר מסמכים", "סה״כ", "מע״מ"], [36, 14, 16, 14]);
  let s = 2;
  for (const t of readiness.issuedTotals) {
    const row = wsum.getRow(s++);
    row.getCell(1).value = `${issuedTypeHe(t.documentType)} (הופקו בדוביז)`;
    row.getCell(2).value = t.count;
    row.getCell(3).value = Number(t.totalAmount);
    row.getCell(4).value = Number(t.vatAmount);
    [3, 4].forEach((c) => (row.getCell(c).numFmt = "#,##0.00"));
  }
  const scannedExpense = records.filter((r) => r.direction !== "income");
  const scannedIncome = records.filter((r) => r.direction === "income");
  for (const [label, rows] of [
    ["הוצאות (מסמכים סרוקים שאושרו)", scannedExpense],
    ["הכנסות (מסמכים סרוקים שאושרו)", scannedIncome],
  ] as const) {
    const row = wsum.getRow(s++);
    row.getCell(1).value = label;
    row.getCell(2).value = rows.length;
    row.getCell(3).value = rows.reduce((acc, r) => acc + Number(r.amount), 0);
    row.getCell(3).numFmt = "#,##0.00";
  }

  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

export function blockerLineHe(b: Readiness["blockers"][number]): string {
  if (b.kind === "DOCUMENTS_PENDING_REVIEW") return `${b.count} מסמכים עדיין ממתינים לבדיקה ואינם בדוח`;
  if (b.kind === "ISSUED_PDF_UNAVAILABLE") return `${b.count} מסמכים שהופקו — הקובץ הסופי שלהם עדיין אינו זמין`;
  return `${b.count} קבצי מקור לא נמצאו באחסון`;
}

export function warningLineHe(w: Readiness["warnings"][number]): string {
  if (w.kind === "DATE_FROM_UPLOAD_TIME") return `${w.count} רשומות שהתאריך שלהן נלקח ממועד ההעלאה`;
  return `${w.count} הכנסות סרוקות שייתכן שהן כפולות למסמך שהופק בדוביז`;
}

export function buildSummaryText(params: {
  periodLabel: string;
  generatedAt: Date;
  readiness: Readiness;
  approvedFiles: number;
  issuedFiles: number;
}): string {
  const { readiness } = params;
  const lines = [
    "חבילת רואה חשבון",
    `תקופה: ${params.periodLabel}`,
    `נוצר: ${params.generatedAt.toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" })}`,
    "",
    "מה כלול:",
    `- מסמכים סרוקים שאושרו: ${readiness.counts.scannedExpense + readiness.counts.scannedIncome} (קבצי מקור: ${params.approvedFiles})`,
    `- מסמכים שהופקו בדוביז: ${readiness.counts.issued} (קבצים: ${params.issuedFiles})`,
    "",
    "מה אינו כלול:",
    "- מסמכים שעדיין לא נבדקו (מופיעים ברשימת הממתינים בלבד)",
    "- תשלומים שנגבו בקישור תשלום (מופיעים כקבלה שהופקה, ולא בנפרד)",
    "- התחייבויות ותשלומים שנרשמו במזכירה",
    "- קובץ מבנה אחיד (מופק בנפרד)",
    "",
  ];
  if (readiness.blockers.length > 0) {
    lines.push("פתוח:");
    for (const b of readiness.blockers) lines.push(`- ${blockerLineHe(b)}`);
    lines.push("");
  }
  if (readiness.warnings.length > 0) {
    lines.push("לתשומת לב:");
    for (const w of readiness.warnings) lines.push(`- ${warningLineHe(w)}`);
    lines.push("");
  }
  lines.push("החבילה מרכזת את מה שקיים בדוביז לתקופה זו. היא אינה מאשרת שהנהלת החשבונות שלמה.");
  return lines.join("\n");
}

export type PackageManifest = {
  period: string;
  generatedAt: string;
  fingerprint: string;
  recordCount: number;
  issuedCount: number;
  pendingCount: number;
  approvedFiles: number;
  issuedFiles: number;
  missingFiles: number;
  missingOriginalDocumentIds: number[];
  missingIssuedDocumentIds: number[];
  entries: string[];
};

export type BuiltAccountantPackage = {
  buffer: Buffer;
  sha256: string;
  manifest: PackageManifest;
  /** Readiness re-evaluated with what storage actually held. */
  readiness: Readiness;
};

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

export type PackageFileReaders = {
  readOriginal: (businessId: number, basename: string) => Promise<Buffer>;
  /** Reads a stored issued PDF by key; the builder verifies its sha256 against the recorded hash. */
  readIssuedPdf: (storageKey: string) => Promise<Buffer>;
};

const defaultReaders: PackageFileReaders = {
  readOriginal: readDocumentObject,
  readIssuedPdf: readByKey,
};

/**
 * Builds the package for already-loaded facts. Reads files only — never renders, signs or writes.
 * The readiness it returns is re-evaluated with what storage actually held, so a file that turned
 * out to be missing becomes an open item instead of a silent gap.
 */
export async function buildAccountantPackage(params: {
  businessId: number;
  periodLabel: string;
  facts: PeriodFacts;
  generatedAt: Date;
  readers?: PackageFileReaders;
}): Promise<BuiltAccountantPackage> {
  const { businessId, periodLabel, facts, generatedAt } = params;
  const readers = params.readers ?? defaultReaders;

  // ── originals of scanned documents ──
  type FetchTarget = { docId: number; folder: "approved" | "pending"; basename: string };
  const targets: FetchTarget[] = [];
  const missingLines: string[] = [];
  const missingOriginal: number[] = [];
  const seen = new Set<number>();
  for (const r of facts.scanned) {
    if (seen.has(r.documentId)) continue;
    seen.add(r.documentId);
    const folder = r.documentStatus === "approved" ? "approved" : "pending";
    const basename = String(r.fileUrl ?? "").trim();
    if (!basename) {
      missingLines.push(`document ${r.documentId}: אין נתיב קובץ`);
      missingOriginal.push(r.documentId);
      continue;
    }
    if (!STORED_DOCUMENT_FILENAME_REGEX.test(basename)) {
      missingLines.push(`document ${r.documentId}: נתיב לא תקין`);
      missingOriginal.push(r.documentId);
      continue;
    }
    targets.push({ docId: r.documentId, folder, basename });
  }

  // Storage reads run with bounded concurrency: a real month is dozens of
  // originals, and fetching them one-by-one puts N×RTT on a serverless clock.
  // Order of ZIP entries is preserved by appending from the ordered results.
  const originals = await mapWithConcurrency(targets, EXPORT_FILE_FETCH_CONCURRENCY, async (t) => {
    try {
      return { t, buffer: await readers.readOriginal(businessId, t.basename) as Buffer | null, error: null as unknown };
    } catch (e) {
      return { t, buffer: null as Buffer | null, error: e as unknown };
    }
  });
  for (const item of originals) {
    if (item.buffer) continue;
    if (item.error instanceof StorageObjectNotFoundError) {
      missingLines.push(`document ${item.t.docId}: קובץ לא נמצא`);
    } else {
      console.error("[accountant-package] original read failed", { documentId: item.t.docId });
      missingLines.push(`document ${item.t.docId}: כשל בקריאה`);
    }
    missingOriginal.push(item.t.docId);
  }

  // ── final PDFs of issued documents (only those the delivery gate allows) ──
  const issuedFiles = await mapWithConcurrency(
    facts.issued.filter((d) => d.pdf.available),
    EXPORT_FILE_FETCH_CONCURRENCY,
    async (d) => {
      if (!d.pdf.available) return { d, buffer: null as Buffer | null };
      try {
        const buffer = await readers.readIssuedPdf(d.pdf.storageKey);
        const actual = createHash("sha256").update(buffer).digest("hex");
        // A stored object that is not the recorded artifact is treated as missing — never shipped.
        return { d, buffer: actual === d.pdf.sha256 ? buffer : null };
      } catch {
        return { d, buffer: null as Buffer | null };
      }
    }
  );
  const missingIssued = issuedFiles.filter((f) => !f.buffer).map((f) => f.d.id);
  for (const id of missingIssued) missingLines.push(`issued ${id}: הקובץ הסופי לא נמצא`);
  const issuedIncluded = new Set(issuedFiles.filter((f) => f.buffer).map((f) => f.d.id));

  // A stored PDF that turned out unreadable makes that document unavailable for this build.
  const effectiveFacts: PeriodFacts =
    missingIssued.length === 0
      ? facts
      : {
          ...facts,
          issued: facts.issued.map((d) =>
            missingIssued.includes(d.id) ? { ...d, pdf: { available: false, reason: "NOT_RENDERED" as const } } : d
          ),
        };
  const readiness = evaluateReadiness(effectiveFacts, missingOriginal);
  const notes = rowNotes(effectiveFacts, readiness);

  let manifest: PackageManifest | null = null;
  const buffer = await collectArchiveToBuffer(async (archive) => {
    const reportBase = `דוח_${periodLabel}`;
    const xlsxName = `${reportBase}.xlsx`;
    const metaCsvPath = `_meta/${reportBase}.csv`;
    archive.append(await buildAccountantXlsxBuffer(effectiveFacts, readiness, notes, issuedIncluded), { name: xlsxName });
    archive.append(buildAccountantCsvBuffer(effectiveFacts.scanned, notes), { name: metaCsvPath });

    const entries: string[] = [xlsxName, "סיכום.txt", metaCsvPath];
    let approvedFiles = 0;
    for (const item of originals) {
      if (!item.buffer) continue;
      const ext = item.t.basename.split(".").pop() || "file";
      const entryName = `${item.t.folder}/doc-${item.t.docId}.${ext}`;
      // store: originals are already-compressed media (PDF/JPEG/PNG) —
      // re-DEFLATE-ing them burns CPU for ~0% size gain.
      archive.append(item.buffer, { name: entryName, store: true });
      entries.push(entryName);
      approvedFiles += 1;
    }
    if (approvedFiles === 0) archive.append(Buffer.alloc(0), { name: "approved/.keep" });

    let issuedCount = 0;
    for (const f of issuedFiles) {
      if (!f.buffer) continue;
      const name = issuedFileName(f.d);
      archive.append(f.buffer, { name, store: true });
      entries.push(name);
      issuedCount += 1;
    }

    archive.append(
      buildSummaryText({ periodLabel, generatedAt, readiness, approvedFiles, issuedFiles: issuedCount }),
      { name: "סיכום.txt" }
    );

    manifest = {
      period: periodLabel,
      generatedAt: generatedAt.toISOString(),
      fingerprint: readiness.fingerprint,
      recordCount: effectiveFacts.scanned.length,
      issuedCount: effectiveFacts.issued.length,
      pendingCount: effectiveFacts.pending.length,
      approvedFiles,
      issuedFiles: issuedCount,
      missingFiles: missingOriginal.length + missingIssued.length,
      missingOriginalDocumentIds: [...new Set(missingOriginal)].sort((a, b) => a - b),
      missingIssuedDocumentIds: [...missingIssued].sort((a, b) => a - b),
      entries: [...entries, "_meta/manifest.json", "_meta/missing-files.txt"].sort(),
    };
    archive.append(JSON.stringify(manifest, null, 2), { name: "_meta/manifest.json" });
    archive.append(missingLines.length > 0 ? missingLines.join("\n") + "\n" : "(אין קבצים חסרים)\n", {
      name: "_meta/missing-files.txt",
    });
  });

  return {
    buffer,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    manifest: manifest as unknown as PackageManifest,
    readiness,
  };
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

/** Resolves the screen's request or throws AccountantExportRequestError (never an unbounded export). */
export function resolvePackRequest(body: AccountantPackBody): { label: string; range: PeriodRange } {
  const resolved = resolveExportRequest(body);
  if (!resolved.ok) throw new AccountantExportRequestError(resolved.error);
  return { label: resolved.label, range: resolved.range };
}

/**
 * The ad-hoc pack (month / quarter / year) of the accountant-pack screen, built in memory.
 * Must run inside the business's tenant context.
 */
export async function buildAccountantPackZipBuffer(
  businessId: number,
  body: AccountantPackBody
): Promise<Buffer> {
  const { label, range } = resolvePackRequest(body);
  const categories = Array.isArray(body.categories) ? body.categories.filter((c) => typeof c === "string") : [];
  const facts = await loadPeriodFacts(businessId, range, { categories });
  const built = await buildAccountantPackage({ businessId, periodLabel: label, facts, generatedAt: new Date() });
  return built.buffer;
}
