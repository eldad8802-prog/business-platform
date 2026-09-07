/**
 * Documents export — the original files, plus an index that explains them.
 *
 * # What the owner is actually getting
 *
 * A ZIP they can open on any machine, take to another system, or hand to an
 * accountant, containing the ORIGINAL bytes Dubiz stored and one Hebrew
 * spreadsheet describing each one. Not a rendering, not extracted text, not a
 * regenerated PDF — the file they gave us, back.
 *
 * That is why nothing here converts, re-encodes or re-renders anything, and why
 * the fidelity test compares hashes rather than eyeballing a result.
 *
 * # Reused, not rebuilt
 *
 * The archive comes from `collectArchiveToBuffer` and the workbook from
 * `buildXlsxBuffer` — the same primitives the tabular export uses. The
 * accountant pack's *infrastructure* is shared; its *semantics* deliberately
 * are not. That pack answers a fiscal question (approved records for a period,
 * bucketed, with SUMIF totals). This answers a portability one: everything the
 * business holds, whatever its review state.
 *
 * # Memory is the binding constraint
 *
 * `collectArchiveToBuffer` builds the whole archive in memory, so the limit
 * that matters is BYTES, not file count. See the two ceilings below.
 */

import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { collectArchiveToBuffer } from "@/lib/archive/zip-buffer";
import { buildXlsxBuffer } from "@/lib/data-transfer/format/xlsx-writer";
import type { XlsxColumn } from "@/lib/data-transfer/format/xlsx-writer";
import type { SheetCell } from "@/lib/data-transfer/format/table.types";
import { israelDateStamp } from "@/lib/data-transfer/export/export-package";
import { readDocumentObject } from "@/lib/services/documents/document-storage.service";
import { StorageObjectNotFoundError } from "@/lib/storage/storage.errors";

/**
 * Most documents in one archive.
 *
 * The largest business in production holds 82 documents, so this is roughly
 * 3.5x the real ceiling. It is deliberately NOT the safety limit — at the 15MB
 * per-file maximum, 300 files would be 4.5GB. The byte ceiling below is what
 * makes this count safe to offer, exactly as in the batch import.
 */
export const DOCUMENTS_EXPORT_MAX_FILES = 300;

/**
 * Ceiling on the original bytes in one archive. THE safety limit.
 *
 * Measured against production rather than guessed. 177 documents across 8
 * businesses; only 11 rows carry a recorded size (the column arrived later),
 * and those average 1.19MB with a 3.4MB maximum. The largest business at that
 * average is roughly 98MB of originals.
 *
 * Peak memory is about twice the archive: the collector accumulates chunks and
 * then concatenates them, and originals are stored uncompressed because they
 * are already-compressed formats. 150MB of originals therefore peaks near
 * 300-350MB, which leaves real headroom under a 1GB serverless function while
 * comfortably covering the largest business that exists.
 *
 * It is enforced while READING, not from the database, because `sizeBytes` is
 * null for most historical rows — a limit computed from it would be a limit
 * that mostly does not apply.
 */
export const DOCUMENTS_EXPORT_MAX_TOTAL_BYTES = 150 * 1024 * 1024;

/** Rows per keyset page. Short reads, no transaction held across storage I/O. */
const PAGE_SIZE = 200;

/** ASCII, because archive tools and operating systems disagree about the rest. */
export const ARCHIVE_FILES_DIR = "documents";

export type DocumentsExportFilter = {
  /** Inclusive lower bound on the UPLOAD date. */
  from?: Date | null;
  /** Inclusive upper bound on the UPLOAD date. */
  to?: Date | null;
};

export type DocumentsExportResult = {
  body: Buffer;
  filename: string;
  contentType: string;
  summary: {
    total: number;
    included: number;
    missing: number;
    totalBytes: number;
  };
};

export class DocumentsExportTooLargeError extends Error {
  constructor(
    readonly reason: "TOO_MANY_FILES" | "TOO_LARGE",
    message: string
  ) {
    super(message);
    this.name = "DocumentsExportTooLargeError";
  }
}

export class NoDocumentsToExportError extends Error {
  constructor() {
    super("no documents matched the selection");
    this.name = "NoDocumentsToExportError";
  }
}

/* ============================ owner-facing words ======================== */

/** Review state, in the owner's words. Raw enum values never leave the server. */
export function statusLabel(status: string): string {
  if (status === "approved") return "אושר";
  if (status === "needs_review") return "ממתין לאישור";
  if (status === "processing") return "בעיבוד";
  if (status === "failed") return "נכשל";
  return "לא ידוע";
}

/**
 * Where the document came from, only as far as the database can prove it.
 *
 * `Document.source` distinguishes the CHANNEL and nothing finer. A document
 * taken in through the Import Center is recorded as "file", exactly like one
 * uploaded on the documents screen, because no origin discriminator separates
 * them — so this column says "קובץ" for both rather than claiming a distinction
 * that is not stored. Nothing is inferred from filenames or storage paths.
 */
export function sourceLabel(source: string): string {
  if (source === "email") return 'דוא"ל';
  if (source === "whatsapp") return "וואטסאפ";
  if (source === "file") return "קובץ";
  return "אחר";
}

/** The file type as an owner reads it, from the stored MIME. */
export function fileKindLabel(mimeType: string): string {
  const m = String(mimeType || "").toLowerCase().trim();
  if (m === "application/pdf") return "PDF";
  if (m === "image/jpeg" || m === "image/jpg") return "JPG";
  if (m === "image/png") return "PNG";
  return "אחר";
}

/** Extension for the archive entry, taken from the MIME and never from a name. */
export function extensionForMime(mimeType: string): string {
  const m = String(mimeType || "").toLowerCase().trim();
  if (m === "application/pdf") return "pdf";
  if (m === "image/png") return "png";
  if (m === "image/jpeg" || m === "image/jpg") return "jpg";
  return "bin";
}

/* ========================= archive entry naming ========================= */

/** Characters no filesystem or archive tool should have to argue about. */
const UNSAFE_CHARS = /[\x00-\x1f\x7f<>:"/\\|?*]/g;
const MAX_BASE_LENGTH = 60;

/**
 * Turn an uploader's filename into something safe to put in an archive.
 *
 * The uploader's name is display text that happened to arrive from outside, so
 * it is treated as hostile: every path separator is removed rather than
 * escaped, `..` cannot survive, a leading dot cannot make a hidden file, and no
 * control character reaches the entry name. What comes out is a NAME, never a
 * path — the directory is added by the caller, not by anything the owner typed.
 *
 * The extension is taken from the stored MIME rather than from the name, so a
 * file called `invoice.pdf.exe` becomes `invoice.pdf.pdf` at worst, never an
 * executable-looking entry.
 */
export function sanitizeArchiveBaseName(raw: string | null): string {
  const withoutPath = String(raw ?? "")
    // Split on BOTH separators, so a Windows path is not treated as one name.
    .split(/[/\\]/)
    .pop()!;
  const cleaned = withoutPath
    .replace(UNSAFE_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    // A name that is only dots ("..", ".") must not survive as one.
    .replace(/^\.+/, "")
    .trim();

  // Drop the uploader's extension: the real one comes from the MIME.
  const withoutExt = cleaned.replace(/\.[A-Za-z0-9]{1,8}$/, "").trim();
  const base = withoutExt.length > 0 ? withoutExt : cleaned;
  return base.slice(0, MAX_BASE_LENGTH).trim();
}

/**
 * The entry name for one document: date, then a recognisable name.
 *
 * The date is the UPLOAD date, which every document has. Using the document's
 * own date would read better for an invoice and be absent for many rows, and a
 * name that is sometimes one date and sometimes another is worse than one that
 * is always the same thing. Both dates appear as columns in the index.
 */
export function buildArchiveEntryName(input: {
  uploadedAt: Date;
  originalFilename: string | null;
  mimeType: string;
  /** Names already used in this archive, lower-cased. Mutated. */
  taken: Set<string>;
}): string {
  const stamp = israelDateStamp(input.uploadedAt);
  const base = sanitizeArchiveBaseName(input.originalFilename);
  const ext = extensionForMime(input.mimeType);
  const stem = base ? `${stamp}_${base}` : stamp;

  let candidate = `${stem}.${ext}`;
  let n = 2;
  while (input.taken.has(candidate.toLowerCase())) {
    candidate = `${stem}_${n}.${ext}`;
    n += 1;
  }
  input.taken.add(candidate.toLowerCase());
  return candidate;
}

/* ============================== the index ============================== */

export const DOCUMENT_INDEX_SHEET = "מסמכים";

/**
 * The columns, and why each one is here.
 *
 * Every value is either a Document column or the approved/extracted reading of
 * it. Nothing is reverse-engineered out of an OCR blob, and nothing internal
 * appears: no database id, no business id, no storage key, no hash, no
 * confidence score, no model metadata. An owner opening this file learns what
 * they have, not how Dubiz stores it.
 *
 * Deliberately ABSENT, because the schema cannot support them honestly:
 * document number and currency have no field, so a column for either would be
 * empty or invented.
 */
export const DOCUMENT_INDEX_COLUMNS: readonly XlsxColumn[] = [
  { header: "שם הקובץ בארכיון", width: 34 },
  { header: "שם הקובץ המקורי", width: 30 },
  { header: "סוג הקובץ", width: 12 },
  { header: "תאריך העלאה", type: "date", width: 14 },
  { header: "תאריך המסמך", type: "date", width: 14 },
  { header: "ספק / בית עסק", width: 26 },
  { header: "סכום", type: "currency", width: 14 },
  { header: "קטגוריה", width: 18 },
  { header: "סטטוס", width: 16 },
  { header: "מקור", width: 12 },
  { header: "נכלל בארכיון", width: 16 },
] as const;

/** One document as the export sees it. No ids, by construction. */
export type ExportRow = {
  id: number;
  fileUrl: string;
  mimeType: string;
  status: string;
  source: string;
  originalFilename: string | null;
  createdAt: Date;
  vendorName: string | null;
  amount: number | null;
  documentDate: Date | null;
  category: string | null;
};

function toIndexRow(
  row: ExportRow,
  entryName: string,
  included: boolean
): readonly SheetCell[] {
  return [
    included ? entryName : "",
    row.originalFilename ?? "",
    fileKindLabel(row.mimeType),
    row.createdAt,
    row.documentDate,
    row.vendorName ?? "",
    row.amount,
    row.category ?? "",
    statusLabel(row.status),
    sourceLabel(row.source),
    included ? "כן" : "לא — הקובץ לא נמצא באחסון",
  ];
}

/* ============================== the read =============================== */

/**
 * Page through this business's documents, newest first.
 *
 * Short tenant-scoped transactions, keyset by id, and NOTHING held open across
 * the storage reads that follow. The approved reading wins over the extracted
 * one where both exist — the same precedence the duplicate check uses, so the
 * index agrees with what the owner sees in the app.
 */
async function readExportRows(
  businessId: number,
  filter: DocumentsExportFilter
): Promise<ExportRow[]> {
  const createdAt: { gte?: Date; lte?: Date } = {};
  if (filter.from) createdAt.gte = filter.from;
  if (filter.to) createdAt.lte = filter.to;

  const rows: ExportRow[] = [];
  let cursor: number | null = null;

  for (;;) {
    const page = await runWithTenantContext({ businessId }, () =>
      withTenantTransaction((tx) =>
        tx.document.findMany({
          where: {
            businessId,
            ...(filter.from || filter.to ? { createdAt } : {}),
            ...(cursor ? { id: { lt: cursor } } : {}),
          },
          orderBy: { id: "desc" },
          take: PAGE_SIZE,
          select: {
            id: true,
            fileUrl: true,
            mimeType: true,
            status: true,
            source: true,
            originalFilename: true,
            createdAt: true,
            extractedData: {
              select: { vendorName: true, amount: true, date: true, category: true },
            },
            financialRecord: {
              select: { vendorName: true, amount: true, date: true, category: true },
            },
          },
        })
      )
    );

    for (const d of page) {
      const known = d.financialRecord ?? d.extractedData;
      rows.push({
        id: d.id,
        fileUrl: d.fileUrl,
        mimeType: d.mimeType,
        status: d.status,
        source: d.source,
        originalFilename: d.originalFilename,
        createdAt: d.createdAt,
        vendorName: known?.vendorName ?? null,
        amount: known?.amount ?? null,
        documentDate: known?.date ?? null,
        category: known?.category ?? null,
      });
    }

    if (page.length < PAGE_SIZE) break;
    cursor = page[page.length - 1].id;

    // Refuse early, before any storage is touched, rather than paging forever.
    if (rows.length > DOCUMENTS_EXPORT_MAX_FILES) break;
  }

  return rows;
}

/* ============================== assembly =============================== */

/**
 * The two things this module reaches outside itself.
 *
 * The defaults ARE the canonical implementations, asserted structurally. They
 * are injectable so the archive can be driven end-to-end in a test — byte
 * fidelity, entry naming, a missing object, the ceilings — none of which can be
 * shown by reading the code, and none of which should need a live database and
 * object store to prove.
 */
export type DocumentsExportPorts = {
  readRows: typeof readExportRows;
  readObject: typeof readDocumentObject;
};

export const CANONICAL_EXPORT_PORTS: DocumentsExportPorts = {
  readRows: readExportRows,
  readObject: readDocumentObject,
};

export async function buildDocumentsExport(
  input: {
    businessId: number;
    filter?: DocumentsExportFilter;
    at?: Date;
  },
  ports: DocumentsExportPorts = CANONICAL_EXPORT_PORTS
): Promise<DocumentsExportResult> {
  const at = input.at ?? new Date();
  const rows = await ports.readRows(input.businessId, input.filter ?? {});

  if (rows.length === 0) throw new NoDocumentsToExportError();
  if (rows.length > DOCUMENTS_EXPORT_MAX_FILES) {
    throw new DocumentsExportTooLargeError(
      "TOO_MANY_FILES",
      `יש יותר מ-${DOCUMENTS_EXPORT_MAX_FILES} מסמכים בטווח שנבחר. בחרו טווח תאריכים קצר יותר.`
    );
  }

  const taken = new Set<string>();
  const indexRows: (readonly SheetCell[])[] = [];
  let includedCount = 0;
  let missingCount = 0;
  let totalBytes = 0;
  const missingLines: string[] = [];

  const body = await collectArchiveToBuffer(async (archive) => {
    for (const row of rows) {
      const entryName = buildArchiveEntryName({
        uploadedAt: row.createdAt,
        originalFilename: row.originalFilename,
        mimeType: row.mimeType,
        taken,
      });

      let bytes: Buffer | null = null;
      try {
        // The basename comes from the Document row, and the full storage path
        // is rebuilt from the AUTHENTICATED business — a stored name can never
        // address another tenant's object.
        bytes = await ports.readObject(input.businessId, row.fileUrl);
      } catch (error) {
        if (!(error instanceof StorageObjectNotFoundError)) {
          // A transient read failure is not a missing file, and quietly
          // shipping an archive that is short a document the owner believes is
          // backed up would be the worst outcome available.
          throw error;
        }
        bytes = null;
      }

      if (bytes === null) {
        missingCount += 1;
        missingLines.push(entryName);
        indexRows.push(toIndexRow(row, entryName, false));
        continue;
      }

      totalBytes += bytes.length;
      if (totalBytes > DOCUMENTS_EXPORT_MAX_TOTAL_BYTES) {
        const mb = Math.round(DOCUMENTS_EXPORT_MAX_TOTAL_BYTES / 1024 / 1024);
        throw new DocumentsExportTooLargeError(
          "TOO_LARGE",
          `הקבצים בטווח שנבחר גדולים מ-${mb}MB. בחרו טווח תאריכים קצר יותר.`
        );
      }

      // `store: true` — these are PDFs and photos, already compressed. Deflating
      // them again costs time and saves nothing.
      archive.append(bytes, { name: `${ARCHIVE_FILES_DIR}/${entryName}`, store: true });
      includedCount += 1;
      indexRows.push(toIndexRow(row, entryName, true));
    }

    const workbook = await buildXlsxBuffer({
      name: DOCUMENT_INDEX_SHEET,
      columns: DOCUMENT_INDEX_COLUMNS,
      rows: indexRows,
      rightToLeft: true,
      freezeHeader: true,
      autoFilter: true,
    });
    archive.append(workbook, { name: "index.xlsx" });

    if (missingLines.length > 0) {
      // Named so nobody has to open the spreadsheet to discover the archive is
      // short. The index says the same thing per row.
      archive.append(
        Buffer.from(
          ["קבצים שלא נמצאו באחסון ולכן אינם בארכיון:", "", ...missingLines].join(
            "\r\n"
          ),
          "utf8"
        ),
        { name: "MISSING-FILES.txt" }
      );
    }
  });

  return {
    body,
    filename: `dubiz-documents-${israelDateStamp(at)}.zip`,
    contentType: "application/zip",
    summary: {
      total: rows.length,
      included: includedCount,
      missing: missingCount,
      totalBytes,
    },
  };
}

