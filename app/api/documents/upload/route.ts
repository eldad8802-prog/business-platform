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
import { consumeRateLimit } from "@/lib/security/rate-limit";
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

function isAllowedMime(mimeType: string): boolean {
  const m = String(mimeType || "").toLowerCase().trim();
  return m === "application/pdf" || m.startsWith("image/");
}

export async function POST(req: Request) {
  let tempFilePath: string | null = null;
  let storedFileName: string | null = null;
  let businessId: number | null = null;
  let permanentFilePersisted = false;

  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userLimit = consumeRateLimit({
      key: `documents:upload:user:${user.id}`,
      limit: 10,
      windowMs: 60 * 60_000,
    });
    if (!userLimit.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429 }
      );
    }

    const businessLimit = consumeRateLimit({
      key: `documents:upload:business:${user.businessId}`,
      limit: 30,
      windowMs: 24 * 60 * 60_000,
    });
    if (!businessLimit.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429 }
      );
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file" }, { status: 400 });
    }

    if (typeof file.type !== "string" || !isAllowedMime(file.type)) {
      return NextResponse.json(
        { error: "Unsupported file type" },
        { status: 400 }
      );
    }

    if (typeof file.size !== "number" || file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: "File too large (max 15MB)" },
        { status: 413 }
      );
    }

    const sessionId = readSessionIdFromRequest(req);

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

    // Single OCR call. The geometry variant returns a SUPERSET: the same `.text`
    // as runGoogleVisionOCR (identical Vision calls) PLUS token geometry. We feed
    // `.text` to the legacy engine exactly as before and pass geometry to the
    // Shadow ledger — no second Vision call. If the geometry call fails for any
    // reason, fall back to the legacy text-only OCR so the upload is never
    // affected by ledger/geometry concerns (ledger then records legacy-only).
    let rawText: string;
    let ledgerGeometry: OcrGeometryResult | null = null;
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
      } catch {
        return NextResponse.json(
          { error: "שגיאה בעיבוד המסמך. אנא נסה שוב מאוחר יותר." },
          { status: 500 }
        );
      }
    }

    if (!rawText) {
      return NextResponse.json(
        {
          error:
            "לא הצלחנו לזהות טקסט במסמך. נסה תמונה חדה יותר או PDF.",
          needsReview: true,
        },
        { status: 400 }
      );
    }

    const extracted = await runUnifiedDocumentIntelligence({
      businessId,
      rawText,
    });

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

    // Persist the original source file via StorageService. Access remains
    // gated by GET /api/documents/[id]/file (auth proxy).
    storedFileName = buildStoredDocumentFileName(mimeType);
    await putDocumentObject({
      businessId,
      basename: storedFileName,
      body: buffer,
      contentType: file.type || "image/jpeg",
      source: "file",
    });

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
        ocrText: rawText,
      },
    });

    // Once the Document row points at the stored file we no longer want to
    // delete it on error; leaving it lets the user re-open the document.
    permanentFilePersisted = true;

    const extractedData = await prisma.extractedData.create({
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

    // Phase 1A Correction Ledger — additive, write-only, never throws. Geometry
    // (when the single OCR call above produced it) feeds the Shadow slice ledger;
    // null when the text-only fallback ran.
    await recordExtractionSnapshot({
      documentId: document.id,
      businessId,
      sourceChannel: "upload",
      ocrText: rawText,
      extracted,
      geometry: ledgerGeometry,
    });

    await recordProductUsageEvent({
      businessId: user.businessId,
      userId: user.id,
      sessionId,
      featureKey: PRODUCT_USAGE_FEATURES.DOCUMENTS_UPLOAD,
      action: PRODUCT_USAGE_ACTIONS.COMPLETED,
      outcome: PRODUCT_USAGE_OUTCOMES.SUCCESS,
      entityType: "document",
      entityId: String(document.id),
    });

    return NextResponse.json({
      success: true,
      documentId: document.id,
      extracted: extractedData,
      outputProfile: extracted.outputProfile,
      analysis: {
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
      },
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
    return NextResponse.json({ error: "Server error" }, { status: 500 });
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
