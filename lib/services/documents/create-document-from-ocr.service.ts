/**
 * Materialize a Document whose extraction has ALREADY happened.
 *
 * This is the extraction-first half of the Documents lifecycle, and it is a
 * genuine peer of `ingestDocument`, not a lax copy of it:
 *
 *   ingestion-first   bytes arrive -> store -> Document(processing) -> OCR later
 *   extraction-first  bytes arrive -> store -> OCR now -> Document(needs_review)
 *
 * Both end at `needs_review` with `ExtractedData`. Forcing the inbound channels
 * through `ingestDocument` would re-run OCR they already ran and move the
 * document backwards into `processing`, so they keep this entry point.
 *
 * # What it does NOT own
 *
 * Bytes, storage, hashing and duplicate policy all stay with the caller. Each
 * channel legitimately differs on those — Gmail dedupes on its message and
 * attachment identity, WhatsApp on its message id — and pulling that in here
 * would grow channel policy inside a shared primitive.
 *
 * # One transaction, and why the caller can join it
 *
 * The Document, its `ExtractedData` and whatever record the CALLER uses to
 * recognise a retry now commit together. Gmail needs that: its
 * `EmailAttachmentImport` row is the only thing that makes a repeated import
 * recognisable, and while the two committed separately there was a window where
 * a Document existed that no retry could see — so the retry made another one.
 *
 * `withinTransaction` is the same principle I-7C proved for the import ledger:
 * the record and the thing that protects it commit together or not at all. It
 * runs LAST here rather than first, because the caller's row needs the id of
 * the Document it points at.
 *
 * # Documents with no extraction
 *
 * `ocrText: null` is a first-class case, not an error. Gmail deliberately keeps
 * an attachment whose OCR returned nothing: the file is real and the owner can
 * type the details in, so it becomes a `needs_review` Document with no
 * `ExtractedData`. The alternative — inventing empty extracted fields — would
 * put a fabricated reading in front of the owner as though it had been read.
 */

import { prisma } from "@/lib/prisma";
import { getTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction, type TenantTx } from "@/lib/tenant/transaction";
import { runUnifiedDocumentIntelligence } from "@/lib/services/documents/unified-extraction-engine.service";
import { recordExtractionSnapshot } from "@/lib/services/documents/ledger/correction-ledger.service";
import {
  findDuplicateDocumentTx,
  lockDocumentContent,
  type DuplicateDocument,
} from "@/lib/services/documents/document-duplicate";

/**
 * Run everything in ONE tenant transaction.
 *
 * D2/P7-W4D: under an established tenant context there is NO fallback to the
 * global client. Outside a context — pure unit tests and offline scripts — the
 * steps run directly, which is the same escape hatch this module already had,
 * kept deliberately narrow.
 */
async function dbTx<T>(fn: (db: TenantTx) => Promise<T>): Promise<T> {
  if (getTenantContext() !== undefined) {
    return withTenantTransaction((tx) => fn(tx));
  }
  return fn(prisma as unknown as TenantTx);
}

export type DocumentAnalysis = {
  documentType: string;
  isFinancial: boolean;
  guardrailRoute: string;
  needsReview: boolean;
  direction: string;
  confidence: number;
};

export type CreateDocumentFromOcrParams = {
  businessId: number;
  source: "email" | "file" | "whatsapp";
  mimeType: string;
  /**
   * The OCR text, or null when extraction produced nothing usable.
   *
   * Null means "this file is real but unread": a Document is still created, at
   * `needs_review`, with no `ExtractedData` and no extraction snapshot. Nothing
   * is fabricated to fill the gap.
   */
  ocrText: string | null;
  fileUrl: string;
  /** Duplicate-defense identity of the original bytes (Wave 1B). */
  contentHashSha256?: string | null;
  originalFilename?: string | null;
  sizeBytes?: number | null;
  /**
   * What to do when the business already holds a non-failed Document with these
   * exact bytes.
   *
   * Required, and supplied by the CHANNEL. This module owns the mechanism and
   * deliberately not the policy: whether an inbound email should quietly defer
   * to a file the owner already uploaded is a product decision belonging to the
   * channel, not to the thing that writes rows.
   */
  duplicatePolicy: "SKIP_IF_EXISTS" | "ALLOW";
  /**
   * The caller's own statement, run inside the SAME transaction as the
   * Document, as its LAST statement.
   *
   * For a channel that recognises retries by a record of its own, this is what
   * makes "Document created, retry cannot see it" unreachable: the two commit
   * together, and a unique violation from the caller's row rolls the Document
   * back with it.
   *
   * DB statements only. Anything that reaches the network or object storage
   * belongs outside, before the transaction opens.
   */
  withinTransaction?: (tx: TenantTx, documentId: number) => Promise<void>;
};

export type CreateDocumentFromOcrResult =
  | {
      ok: true;
      documentId: number;
      /** Null when there was no OCR text to extract from. */
      extractedDataId: number | null;
      /** Null for the same reason. */
      analysis: DocumentAnalysis | null;
    }
  /**
   * The business already holds these bytes, and the channel asked to defer.
   * Not an error: the file is present, it simply arrived twice.
   */
  | { ok: false; reason: "DUPLICATE"; duplicate: DuplicateDocument };

/** The extraction result shape this module persists. Structural on purpose. */
type ExtractionResult = Awaited<ReturnType<typeof runUnifiedDocumentIntelligence>>;

/**
 * Everything that must commit together, as one function over one client.
 *
 * Exported so the atomicity can be TESTED rather than asserted: the failure
 * this guards against — a Document surviving while the caller's identity row
 * did not — cannot be produced against a real database on purpose, but it can
 * be driven here with a client that models the same constraints.
 */
export async function writeDocumentRecords(
  db: TenantTx,
  params: CreateDocumentFromOcrParams,
  extracted: ExtractionResult | null,
  ocrText: string | null
): Promise<
  | { created: true; documentId: number; extractedDataId: number | null }
  | { created: false; duplicate: DuplicateDocument }
> {
  // Serialise every create for this tenant+file, so two channels cannot both
  // read "no duplicate" and both insert. An ALLOW policy still takes the lock:
  // it means "create deliberately", not "skip the mutual exclusion".
  if (params.contentHashSha256) {
    await lockDocumentContent(db, params.businessId, params.contentHashSha256);
    if (params.duplicatePolicy === "SKIP_IF_EXISTS") {
      const duplicate = await findDuplicateDocumentTx(
        db,
        params.businessId,
        params.contentHashSha256
      );
      if (duplicate) return { created: false, duplicate };
    }
  }

  const document = await db.document.create({
    data: {
      businessId: params.businessId,
      fileUrl: params.fileUrl,
      source: params.source,
      mimeType: params.mimeType,
      status: "needs_review",
      ocrText,
      contentHashSha256: params.contentHashSha256 ?? null,
      originalFilename: params.originalFilename?.trim().slice(0, 255) || null,
      sizeBytes: params.sizeBytes ?? null,
    },
  });

  let extractedDataId: number | null = null;
  if (extracted) {
    const extractedData = await db.extractedData.create({
      data: {
        documentId: document.id,
        amount: extracted.amount,
        vendorName: extracted.vendorName,
        category: extracted.category,
        amountConfidence: extracted.amountConfidence,
        vendorConfidence: extracted.vendorConfidence,
        categoryConfidence: extracted.categoryConfidence,
        direction: extracted.direction,
        date: extracted.date,
        confidenceScore: extracted.confidence,
      },
    });
    extractedDataId = extractedData.id;
  }

  // LAST, so it can carry the Document's id. A failure here — including the
  // caller's own unique constraint — takes the Document down with it.
  if (params.withinTransaction) {
    await params.withinTransaction(db, document.id);
  }

  return { created: true, documentId: document.id, extractedDataId };
}

export async function createDocumentFromOcrText(
  params: CreateDocumentFromOcrParams
): Promise<CreateDocumentFromOcrResult> {
  const ocrText = params.ocrText?.trim() ? params.ocrText : null;

  // Extraction runs BEFORE the transaction opens. It is the slow part, and
  // holding a transaction open across it would put a model call inside a
  // database lock.
  const extracted = ocrText
    ? await runUnifiedDocumentIntelligence({
        businessId: params.businessId,
        rawText: ocrText,
      })
    : null;

  const written = await dbTx((db) =>
    writeDocumentRecords(db, params, extracted, ocrText)
  );

  if (!written.created) {
    // Nothing was written. The caller keeps the object it stored, because only
    // the caller knows whether that object is still wanted — and cleaning up
    // storage is not this module's business.
    return { ok: false, reason: "DUPLICATE", duplicate: written.duplicate };
  }
  const { documentId, extractedDataId } = written;

  // Phase 1A Correction Ledger — additive, write-only, never throws. Outside
  // the transaction on purpose: observability must never roll back a real
  // Document. Only recorded when there was an extraction to describe.
  if (extracted && ocrText) {
    await recordExtractionSnapshot({
      documentId,
      businessId: params.businessId,
      sourceChannel: params.source,
      ocrText,
      extracted,
      extractionOutcome: "ok",
    });
  }

  return {
    ok: true,
    documentId,
    extractedDataId,
    analysis: extracted
      ? {
          documentType: extracted.documentType,
          isFinancial: extracted.isFinancial,
          guardrailRoute: extracted.guardrailRoute,
          needsReview: extracted.needsReview,
          direction: extracted.direction,
          confidence: extracted.confidence,
        }
      : null,
  };
}
