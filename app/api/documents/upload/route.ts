import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { after } from "next/server";
import { runTenantJob } from "@/lib/tenant/job";
import { getCurrentUser } from "@/lib/auth";
import { processDocumentPipeline } from "@/lib/services/documents/process-document-pipeline.service";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { buildRateLimitResponse } from "@/lib/security/rate-limiter/http";
import type { RateLimitDecision } from "@/lib/security/rate-limiter";
import {
  buildStoredDocumentFileName,
  deleteDocumentObjectQuiet,
  putDocumentObject,
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
import { sha256Hex } from "@/lib/services/integrations/gmail/sha256.service";

export const runtime = "nodejs";
// Phase 2 (OCR + extraction) runs in `after()`, which keeps the serverless
// invocation alive until it settles. It must be allowed to run as long as the
// OCR timeout (OCR_TIMEOUT_MS, default 60s) — otherwise a slow OCR would be
// killed mid-processing, leaving the document stuck in "processing".
export const maxDuration = 60;

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

/**
 * Two-phase upload.
 *
 * Phase 1 (this synchronous handler): authenticate, validate, store the source
 * file, and create the Document row with status "processing" — then return the
 * documentId immediately (~1-2s). The user sees the document appear in the list
 * / lands on the review screen right away instead of waiting the full ~30s.
 *
 * Phase 2 (scheduled via `after()`): OCR + extraction run after the response is
 * sent, advancing the document to "needs_review" (ready) or "failed" (retryable).
 * See processDocumentPipeline.
 */
export async function POST(req: Request) {
  let storedFileName: string | null = null;
  let businessId: number | null = null;
  let documentPersisted = false;

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
    const mimeType = String(file.type ?? "");

    // Processing admission control — a SEPARATE bucket from accept. Protects the
    // OCR/Vision quota and function concurrency. Checked synchronously (before
    // we accept the file) so an over-limit still returns a real 429 to the user;
    // the actual OCR runs in Phase 2. Fail-closed on a Redis blip.
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

    const buffer = Buffer.from(await file.arrayBuffer());
    const contentHashSha256 = sha256Hex(buffer);
    const originalFilename =
      typeof file.name === "string" && file.name.trim()
        ? file.name.trim().slice(0, 255)
        : null;

    // Duplicate defense (Wave 1B): the exact same bytes already ingested for
    // this business is a HARD duplicate. Surfaced as a decision, not silently
    // accepted — approving both would double the expense. The owner can still
    // force the upload with allowDuplicate ("העלה בכל זאת"), which is recorded.
    const allowDuplicate = formData.get("allowDuplicate") === "true";
    if (!allowDuplicate) {
      const existing = await prisma.document.findFirst({
        where: {
          businessId: user.businessId,
          contentHashSha256,
          status: { not: "failed" },
        },
        orderBy: { id: "desc" },
        select: {
          id: true,
          status: true,
          createdAt: true,
          extractedData: {
            select: { vendorName: true, amount: true, date: true },
          },
          financialRecord: {
            select: { vendorName: true, amount: true, date: true },
          },
        },
      });
      if (existing) {
        const known = existing.financialRecord ?? existing.extractedData;
        return NextResponse.json(
          {
            error: "נראה שהמסמך הזה כבר הועלה",
            duplicate: {
              documentId: existing.id,
              status: existing.status,
              uploadedAt: existing.createdAt.toISOString(),
              vendorName: known?.vendorName ?? null,
              amount: known?.amount ?? null,
              date: known?.date ? known.date.toISOString() : null,
            },
          },
          { status: 409 }
        );
      }
    } else {
      console.warn("[upload] duplicate override accepted", {
        businessId: user.businessId,
        userId: user.id,
        contentHashSha256,
      });
    }

    // Persist the original source file FIRST, unconditionally. A real storage
    // failure stays fatal (no stored file = no valid Document) and is handled by
    // the catch below.
    storedFileName = buildStoredDocumentFileName(mimeType);
    await putDocumentObject({
      businessId,
      basename: storedFileName,
      body: buffer,
      contentType: file.type || "image/jpeg",
      source: "file",
    });

    // Create the Document row NOW, in "processing" — this is what makes it
    // appear in the inbox/review immediately, before OCR/extraction run.
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
        status: "processing",
        ocrText: null,
        contentHashSha256,
        originalFilename,
        sizeBytes: file.size,
      },
    });
    documentPersisted = true;

    // Phase 2 — runs AFTER this response is sent. `after()` extends the
    // serverless invocation until it settles, so it survives client navigation
    // (unlike a client-triggered follow-up request). The pipeline never throws;
    // it flips the document to needs_review/failed on its own.
    // D2/P7-W4A: the continuation runs under an EXPLICIT tenant context —
    // the server-derived businessId travels in the closure and is
    // re-established via runTenantJob (never inherited from request ALS).
    after(() =>
      runTenantJob({ businessId: user.businessId }, () =>
        processDocumentPipeline({
          documentId: document.id,
          businessId: user.businessId,
          userId: user.id,
          sessionId,
          buffer,
          mimeType,
          sourceChannel: "upload",
        })
      )
    );

    return NextResponse.json({
      success: true,
      documentId: document.id,
      status: "processing",
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
    // row, remove the orphan from storage so it does not accumulate.
    if (storedFileName && businessId && !documentPersisted) {
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
  }
}
