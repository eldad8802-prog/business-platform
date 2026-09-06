import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { buildRateLimitResponse } from "@/lib/security/rate-limiter/http";
import type { RateLimitDecision } from "@/lib/security/rate-limiter";
import {
  DOCUMENT_MAX_UPLOAD_BYTES,
  ingestDocument,
  isAllowedDocumentMime,
  isHeicMimeType,
} from "@/lib/services/documents/document-ingestion.service";
import {
  signatureRejectionMessage,
  verifyFileSignature,
} from "@/lib/services/documents/file-signature";
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
// Phase 2 (OCR + extraction) runs in `after()`, which keeps the serverless
// invocation alive until it settles. It must be allowed to run as long as the
// OCR timeout (OCR_TIMEOUT_MS, default 60s) — otherwise a slow OCR would be
// killed mid-processing, leaving the document stuck in "processing".
export const maxDuration = 60;

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

    if (typeof file.type === "string" && isHeicMimeType(file.type)) {
      return NextResponse.json(
        {
          error:
            "פורמט HEIC לא נתמך. צלם מחדש או המר את התמונה ל-JPG (בהגדרות המצלמה: 'תאימות מרבית').",
        },
        { status: 415 }
      );
    }

    if (typeof file.type !== "string" || !isAllowedDocumentMime(file.type)) {
      return NextResponse.json(
        { error: "סוג קובץ לא נתמך (נדרש PDF, JPG או PNG)" },
        { status: 400 }
      );
    }

    if (typeof file.size !== "number" || file.size > DOCUMENT_MAX_UPLOAD_BYTES) {
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
    const originalFilename =
      typeof file.name === "string" && file.name.trim()
        ? file.name.trim().slice(0, 255)
        : null;
    const allowDuplicate = formData.get("allowDuplicate") === "true";

    // The declared type got the file this far; the bytes decide whether it goes
    // any further. Until now this route trusted `file.type` alone, which is a
    // claim by the client, so a renamed file reached storage and the OCR
    // pipeline under a type it did not have.
    //
    // This is the LAST gate before the canonical lifecycle, and deliberately so:
    // nothing below it can run without a file whose container matches its claim
    // — no stored object, no Document row, no processing job. The same validator
    // the import centre uses, so the two paths accept exactly the same files.
    const signature = verifyFileSignature(buffer, file.type);
    if (!signature.ok) {
      // Recorded because this gate can refuse a file the product accepted
      // yesterday, and the only way to learn that a real owner is affected is to
      // see it. Best-effort: observability must never decide the response.
      await recordProductUsageEvent({
        businessId: user.businessId,
        userId: user.id,
        sessionId,
        featureKey: PRODUCT_USAGE_FEATURES.DOCUMENTS_UPLOAD,
        action: PRODUCT_USAGE_ACTIONS.FAILED,
        outcome: PRODUCT_USAGE_OUTCOMES.FAILURE,
        // The reason only, never the filename or any bytes.
        metadata: { reason: `content-signature:${signature.reason}` },
      }).catch(() => {});
      // 415, matching the HEIC refusal above: both say "the format you actually
      // sent is not one we can process". A 400 would file it with "you declared
      // an unsupported type", which is not what happened.
      return NextResponse.json(
        { error: signatureRejectionMessage(signature.reason) },
        { status: 415 }
      );
    }

    // Everything below the acceptance gates is the canonical Documents
    // lifecycle, and it is identical for every caller. It lives in
    // `document-ingestion.service.ts` so a second caller — the Import Center —
    // cannot reproduce it slightly differently. What stays here is HTTP: the
    // status codes, the Hebrew wording, and the response shape.
    const result = await ingestDocument({
      businessId: user.businessId,
      userId: user.id,
      buffer,
      mimeType: file.type || "image/jpeg",
      originalFilename,
      sizeBytes: file.size,
      source: "file",
      allowDuplicate,
      sessionId,
      sourceChannel: "upload",
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          error: "נראה שהמסמך הזה כבר הועלה",
          duplicate: result.duplicate,
        },
        { status: 409 }
      );
    }

    return NextResponse.json({
      success: true,
      documentId: result.documentId,
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
    // Orphan-storage cleanup is NOT here any more: the only window in which a
    // stored file can exist without its row is inside ingestDocument, and it
    // cleans up there. Keeping a second copy of that logic in the route would
    // mean two places to get it right.
    return NextResponse.json(
      { error: "שגיאה בהעלאת המסמך. נסה שוב מאוחר יותר." },
      { status: 500 }
    );
  }
}
