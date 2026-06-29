import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import os from "os";
import path from "path";
import { mkdir, unlink, writeFile } from "fs/promises";
import { getCurrentUser } from "@/lib/auth";
import {
  runGoogleVisionOCR,
  runGoogleVisionOCRWithGeometry,
  type OcrGeometryResult,
} from "@/lib/services/documents/google-vision-ocr.service";
import { runUnifiedDocumentIntelligence } from "@/lib/services/documents/unified-extraction-engine.service";
import { recordExtractionSnapshot } from "@/lib/services/documents/ledger/correction-ledger.service";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { buildRateLimitResponse } from "@/lib/security/rate-limiter/http";
import type { RateLimitDecision } from "@/lib/security/rate-limiter";
import {
  buildStoredDocumentFileName,
  deleteDocumentObjectQuiet,
  putDocumentObject,
  safeExtFromMime,
} from "@/lib/services/documents/document-storage.service";
import {
  PRODUCT_USAGE_ACTIONS,
  PRODUCT_USAGE_FEATURES,
  PRODUCT_USAGE_OUTCOMES,
} from "@/lib/services/product-usage/product-usage-catalog";
import {
  readSessionIdFromRequest,
  recordProductUsageEvent,
} from "@/lib/services/product-usage/record-product-usage-event";

export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15MB

function normalizeMime(mimeType: string): string {
  return String(mimeType || "").toLowerCase().trim();
}

// HEIC/HEIF (default iPhone photo format) passes a naive image/* check but
// Google Vision cannot OCR it — it would silently produce no text. Reject it
// explicitly with a clear Hebrew message so the user converts/retakes as JPEG.
function isHeic(mimeType: string): boolean {
  const m = normalizeMime(mimeType);
  return m === "image/heic" || m === "image/heif";
}

function isAllowedMime(mimeType: string): boolean {
  const m = normalizeMime(mimeType);
  if (isHeic(m)) return false;
  return m === "application/pdf" || m.startsWith("image/");
}

/**
 * Explicit observability for every blocked upload — closes the P0 gap where the
 * 429 path recorded nothing. Logs a stable-prefixed line for Vercel logs and a
 * best-effort product-usage event (THROTTLED). Never throws.
 */
async function recordUploadThrottle(input: {
  decision: RateLimitDecision;
  userId: number;
  businessId: number;
  sessionId: string | null;
}): Promise<void> {
  const { decision } = input;
  console.warn("[rate-limit] throttled", {
    feature: PRODUCT_USAGE_FEATURES.DOCUMENTS_UPLOAD,
    bucket: decision.bucket,
    scope: decision.scope,
    outcome: decision.outcome,
    limit: decision.limit,
    retryAfterSeconds: decision.retryAfterSeconds,
    degraded: decision.degraded,
    businessId: input.businessId,
    userId: input.userId,
  });
  await recordProductUsageEvent({
    businessId: input.businessId,
    userId: input.userId,
    sessionId: input.sessionId,
    featureKey: PRODUCT_USAGE_FEATURES.DOCUMENTS_UPLOAD,
    action: PRODUCT_USAGE_ACTIONS.THROTTLED,
    outcome: PRODUCT_USAGE_OUTCOMES.FAILURE,
    metadata: {
      bucket: decision.bucket,
      scope: decision.scope,
      outcome: decision.outcome,
      retryAfterSeconds: decision.retryAfterSeconds,
      degraded: decision.degraded,
    },
  });
}

export async function POST(req: Request) {
  let tempFilePath: string | null = null;
  let storedFileName: string | null = null;
  let businessId: number | null = null;
  let permanentFilePersisted = false;

  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
    }

    const sessionIdForThrottle = readSessionIdFromRequest(req);

    // Fast acceptance gate — separate from the processing gate below. Keyed by
    // user AND business (no longer IP/global). Fail-closed on a Redis blip.
    const acceptDecision = await checkRateLimit({
      bucket: "UPLOAD_ACCEPT",
      user: user.id,
      business: user.businessId,
    });
    if (!acceptDecision.allowed) {
      await recordUploadThrottle({
        decision: acceptDecision,
        userId: user.id,
        businessId: user.businessId,
        sessionId: sessionIdForThrottle,
      });
      return buildRateLimitResponse(acceptDecision);
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "לא נבחר קובץ" }, { status: 400 });
    }

    if (typeof file.type === "string" && isHeic(file.type)) {
      return NextResponse.json(
        {
          error:
            "פורמט HEIC לא נתמך. צלם מחדש או המר את התמונה ל-JPG (בהגדרות המצלמה: 'תאימות מרבית').",
        },
        { status: 415 }
      );
    }

    if (typeof file.type !== "string" || !isAllowedMime(file.type)) {
      return NextResponse.json(
        { error: "סוג קובץ לא נתמך (נדרש PDF או תמונה)" },
        { status: 400 }
      );
    }

    if (typeof file.size !== "number" || file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: "הקובץ גדול מדי (עד 15MB)" },
        { status: 413 }
      );
    }

    const sessionId = sessionIdForThrottle;

    await recordProductUsageEvent({
      businessId: user.businessId,
      userId: user.id,
      sessionId,
      featureKey: PRODUCT_USAGE_FEATURES.DOCUMENTS_UPLOAD,
      action: PRODUCT_USAGE_ACTIONS.OPENED,
      outcome: PRODUCT_USAGE_OUTCOMES.SUCCESS,
    });

    businessId = user.businessId;

    const tmpDir = path.join(os.tmpdir(), "ocr");
    await mkdir(tmpDir, { recursive: true });

    const originalName = String(file.name ?? "");
    const originalExt = path.extname(originalName);
    const mimeType = String(file.type ?? "");

    const ext = originalExt || safeExtFromMime(mimeType) || ".bin";
    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const fileName = `upload-${unique}${ext}`;

    tempFilePath = path.join(tmpDir, fileName);

    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(tempFilePath, buffer);

    // Processing admission control — a SEPARATE bucket from accept. Protects the
    // OCR/Vision quota and function concurrency. Fail-closed on a Redis blip.
    // In P2 this exact gate relocates to the background worker's dequeue step.
    const processingDecision = await checkRateLimit({
      bucket: "DOCUMENT_PROCESSING",
      user: user.id,
      business: user.businessId,
    });
    if (!processingDecision.allowed) {
      await recordUploadThrottle({
        decision: processingDecision,
        userId: user.id,
        businessId: user.businessId,
        sessionId,
      });
      return buildRateLimitResponse(processingDecision);
    }

    // OCR is BEST-EFFORT: a successfully uploaded file must never be lost
    // because OCR failed, timed out, or returned empty. The geometry variant is
    // a superset (same `.text` + token geometry for the Shadow ledger); on any
    // failure we fall back to text-only OCR, and if THAT also fails we proceed
    // with empty text and still persist the file as a needs_review document
    // (mirrors the Gmail import path — never discard the user's upload).
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
        console.error("UPLOAD_OCR_FAILED:", ocrError);
        rawText = "";
        ocrFailed = true;
      }
    }

    // Persist the original source file FIRST, unconditionally — independent of
    // OCR/extraction outcome. A real storage failure stays fatal (no stored file
    // = no valid Document) and is handled by the catch below.
    storedFileName = buildStoredDocumentFileName(mimeType);
    await putDocumentObject({
      businessId,
      basename: storedFileName,
      body: buffer,
      contentType: file.type || "image/jpeg",
      source: "file",
    });

    // Extraction runs only when OCR produced text, and is itself best-effort: an
    // extraction failure must not discard the upload — it falls back to a bare
    // needs_review Document (ocrText preserved when available for reprocessing).
    let extracted:
      | Awaited<ReturnType<typeof runUnifiedDocumentIntelligence>>
      | null = null;
    if (rawText) {
      try {
        extracted = await runUnifiedDocumentIntelligence({ businessId, rawText });
      } catch (extractionError) {
        console.error("UPLOAD_EXTRACTION_FAILED:", extractionError);
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

    const document = await prisma.document.create({
      data: {
        businessId,
        // `fileUrl` stores ONLY the stored basename (no slashes, no business
        // id). The file route resolves the full path using the authenticated
        // user's businessId, which prevents cross-tenant access even if the
        // stored name leaks.
        fileUrl: storedFileName,
        source: "file",
        mimeType: file.type || "image/jpeg",
        status: "needs_review",
        ocrText: rawText || null,
      },
    });

    // Once the Document row points at the stored file we no longer want to
    // delete it on error; leaving it lets the user re-open the document.
    permanentFilePersisted = true;

    let extractedData = null;
    if (extracted) {
      extractedData = await prisma.extractedData.create({
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

      // Phase 1A Correction Ledger — additive, write-only, never throws.
      // Geometry (when the single OCR call produced it) feeds the Shadow slice
      // ledger; null when the text-only fallback ran.
      await recordExtractionSnapshot({
        documentId: document.id,
        businessId,
        sourceChannel: "upload",
        ocrText: rawText,
        extracted,
        geometry: ledgerGeometry,
      });
    }

    await recordProductUsageEvent({
      businessId: user.businessId,
      userId: user.id,
      sessionId,
      featureKey: PRODUCT_USAGE_FEATURES.DOCUMENTS_UPLOAD,
      action: PRODUCT_USAGE_ACTIONS.COMPLETED,
      outcome: PRODUCT_USAGE_OUTCOMES.SUCCESS,
      entityType: "document",
      entityId: String(document.id),
      metadata: {
        ocr: ocrFailed ? "failed" : rawText ? "ok" : "empty",
        extracted: Boolean(extracted),
      },
    });

    return NextResponse.json({
      success: true,
      documentId: document.id,
      // The file is saved and a needs_review Document exists even when OCR or
      // extraction did not yield data — the user completes it in the Review
      // Station instead of losing the upload.
      needsManualReview: !extracted,
      ocr: ocrFailed ? "failed" : rawText ? "ok" : "empty",
      extracted: extractedData,
      outputProfile: extracted?.outputProfile ?? null,
      analysis: extracted
        ? {
            documentType: extracted.documentType,
            isFinancial: extracted.isFinancial,
            guardrailRoute: extracted.guardrailRoute,
            searchableText: extracted.searchableText,
            direction: extracted.direction,
            needsReview: extracted.needsReview,
            confidence: extracted.confidence,
            amountConfidence: extracted.amountConfidence,
            vendorConfidence: extracted.vendorConfidence,
            dateConfidence: extracted.dateConfidence,
            categoryConfidence: extracted.categoryConfidence,
            financialEvidenceLevel: extracted.financialEvidenceLevel,
            amountEligible: extracted.amountEligible,
            weakResolutionReason: extracted.weakResolutionReason,
            evidenceReasons: extracted.evidenceReasons,
          }
        : null,
    });
  } catch (e) {
    console.error(e);
    const user = await getCurrentUser(req).catch(() => null);
    if (user) {
      await recordProductUsageEvent({
        businessId: user.businessId,
        userId: user.id,
        sessionId: readSessionIdFromRequest(req),
        featureKey: PRODUCT_USAGE_FEATURES.DOCUMENTS_UPLOAD,
        action: PRODUCT_USAGE_ACTIONS.FAILED,
        outcome: PRODUCT_USAGE_OUTCOMES.FAILURE,
        metadata: { reason: "server_error" },
      });
    }
    // If we wrote a permanent copy but failed before persisting the Document
    // row, remove the orphan from disk so it does not accumulate.
    if (storedFileName && businessId && !permanentFilePersisted) {
      try {
        await deleteDocumentObjectQuiet(businessId, storedFileName);
      } catch {
        // ignore cleanup errors
      }
    }
    return NextResponse.json(
      { error: "שגיאה בהעלאת המסמך. נסה שוב מאוחר יותר." },
      { status: 500 }
    );
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
