/**
 * Document processing pipeline — Phase 2 of the two-phase upload flow.
 *
 * Phase 1 (the upload route) stores the source file and creates the Document
 * row with status "processing", then returns immediately so the user gets a
 * documentId in ~1-2s instead of waiting the full ~30s. This function runs the
 * heavy work (OCR + extraction) against that already-persisted Document and
 * flips its status to its terminal state:
 *
 *   processing → needs_review   (ready — file usable; OCR/extraction best-effort)
 *   processing → failed         (an unexpected pipeline error; file is preserved,
 *                                the UI offers "retry" which re-runs this pipeline)
 *
 * It is designed to run inside `after()` (server-side, survives client
 * navigation) or from the reprocess endpoint, so it NEVER throws — any fatal is
 * caught and recorded as a `failed` status the user can retry.
 *
 * OCR/extraction stay BEST-EFFORT (mirrors the original single-request flow and
 * the Gmail import path): an empty/failed OCR still lands the document in
 * needs_review so the user completes it manually — the upload is never lost.
 */

import os from "os";
import path from "path";
import { mkdir, unlink, writeFile } from "fs/promises";
import { prisma } from "@/lib/prisma";
import {
  runGoogleVisionOCR,
  runGoogleVisionOCRWithGeometry,
  type OcrGeometryResult,
} from "@/lib/services/documents/google-vision-ocr.service";
import { runUnifiedDocumentIntelligence } from "@/lib/services/documents/unified-extraction-engine.service";
import { recordExtractionSnapshot } from "@/lib/services/documents/ledger/correction-ledger.service";
import { safeExtFromMime } from "@/lib/services/documents/document-storage.service";
import {
  PRODUCT_USAGE_ACTIONS,
  PRODUCT_USAGE_FEATURES,
  PRODUCT_USAGE_OUTCOMES,
} from "@/lib/services/product-usage/product-usage-catalog";
import { recordProductUsageEvent } from "@/lib/services/product-usage/record-product-usage-event";

export type ProcessDocumentInput = {
  documentId: number;
  businessId: number;
  userId: number;
  sessionId: string | null;
  /** The source file bytes (already stored by Phase 1 / re-read on retry). */
  buffer: Buffer;
  mimeType: string;
  /** Ledger provenance — "upload" for the first pass, "reprocess" for a retry. */
  sourceChannel: "upload" | "reprocess";
};

/**
 * Runs OCR + extraction for an already-persisted `processing` Document and
 * advances it to `needs_review` (ready) or `failed`. Never throws.
 */
export async function processDocumentPipeline(
  input: ProcessDocumentInput
): Promise<void> {
  const { documentId, businessId, userId, sessionId, buffer, mimeType } = input;
  let tempFilePath: string | null = null;

  try {
    const tmpDir = path.join(os.tmpdir(), "ocr");
    await mkdir(tmpDir, { recursive: true });

    const ext = safeExtFromMime(mimeType) || ".bin";
    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    tempFilePath = path.join(tmpDir, `proc-${documentId}-${unique}${ext}`);
    await writeFile(tempFilePath, buffer);

    // OCR is BEST-EFFORT: the geometry variant is a superset (same `.text` +
    // token geometry for the Shadow ledger). On any failure we fall back to
    // text-only OCR; if THAT also fails we proceed with empty text.
    let rawText = "";
    let ledgerGeometry: OcrGeometryResult | null = null;
    let ocrFailed = false;
    try {
      const ocr = await runGoogleVisionOCRWithGeometry(
        tempFilePath,
        mimeType || undefined
      );
      rawText = ocr.text.trim();
      ledgerGeometry = ocr;
    } catch (geometryError) {
      console.error(
        "[ledger] geometry OCR failed, falling back to text-only OCR:",
        geometryError
      );
      try {
        rawText = (
          await runGoogleVisionOCR(tempFilePath, mimeType || undefined)
        ).trim();
      } catch (ocrError) {
        console.error("PROCESS_OCR_FAILED:", ocrError);
        rawText = "";
        ocrFailed = true;
      }
    }

    // Extraction runs only when OCR produced text, and is itself best-effort.
    let extracted:
      | Awaited<ReturnType<typeof runUnifiedDocumentIntelligence>>
      | null = null;
    if (rawText) {
      try {
        extracted = await runUnifiedDocumentIntelligence({ businessId, rawText });
      } catch (extractionError) {
        console.error("PROCESS_EXTRACTION_FAILED:", extractionError);
        extracted = null;
      }
    }

    if (extracted) {
      console.log("DOCUMENT ANALYSIS:", {
        documentType: extracted.documentType,
        isFinancial: extracted.isFinancial,
        guardrailRoute: extracted.guardrailRoute,
        needsReview: extracted.needsReview,
        direction: extracted.direction,
        confidence: extracted.confidence,
        financialEvidenceLevel: extracted.financialEvidenceLevel,
        amountEligible: extracted.amountEligible,
        weakResolutionReason: extracted.weakResolutionReason,
        evidenceReasons: extracted.evidenceReasons,
      });
    }

    // Advance the EXISTING Document row (created by Phase 1) to its ready state.
    // The file is already stored, so this is a metadata-only transition.
    await prisma.document.update({
      where: { id: documentId },
      data: {
        status: "needs_review",
        ocrText: rawText || null,
      },
    });

    if (extracted) {
      // upsert (not create): a retry may already have an ExtractedData row.
      await prisma.extractedData.upsert({
        where: { documentId },
        create: {
          documentId,
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
        update: {
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

      // Phase 1A Correction Ledger — additive, write-only, never throws.
      await recordExtractionSnapshot({
        documentId,
        businessId,
        sourceChannel: input.sourceChannel,
        ocrText: rawText,
        extracted,
        geometry: ledgerGeometry,
      });
    }

    await recordProductUsageEvent({
      businessId,
      userId,
      sessionId,
      featureKey: PRODUCT_USAGE_FEATURES.DOCUMENTS_UPLOAD,
      action: PRODUCT_USAGE_ACTIONS.COMPLETED,
      outcome: PRODUCT_USAGE_OUTCOMES.SUCCESS,
      entityType: "document",
      entityId: String(documentId),
      metadata: {
        ocr: ocrFailed ? "failed" : rawText ? "ok" : "empty",
        extracted: Boolean(extracted),
        channel: input.sourceChannel,
      },
    });
  } catch (fatal) {
    // An unexpected error (DB write, storage, etc.) — mark the document failed
    // so the inbox/review surfaces can offer a retry. The source file remains
    // stored, so the retry only re-runs OCR/extraction, never re-uploads.
    console.error("PROCESS_DOCUMENT_FATAL:", fatal);
    try {
      await prisma.document.update({
        where: { id: documentId },
        data: { status: "failed" },
      });
    } catch (statusError) {
      console.error("PROCESS_DOCUMENT_FAILED_STATUS_WRITE:", statusError);
    }
    try {
      await recordProductUsageEvent({
        businessId,
        userId,
        sessionId,
        featureKey: PRODUCT_USAGE_FEATURES.DOCUMENTS_UPLOAD,
        action: PRODUCT_USAGE_ACTIONS.FAILED,
        outcome: PRODUCT_USAGE_OUTCOMES.FAILURE,
        entityType: "document",
        entityId: String(documentId),
        metadata: { reason: "pipeline_error", channel: input.sourceChannel },
      });
    } catch {
      // best-effort telemetry only
    }
  } finally {
    if (tempFilePath) {
      try {
        await unlink(tempFilePath);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
