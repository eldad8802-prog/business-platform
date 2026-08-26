import { NextResponse } from "next/server";
import { after } from "next/server";
import { runTenantJob } from "@/lib/tenant/job";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { buildRateLimitResponse } from "@/lib/security/rate-limiter/http";
import { readDocumentObject } from "@/lib/services/documents/document-storage.service";
import { StorageObjectNotFoundError } from "@/lib/storage/storage.errors";
import { processDocumentPipeline } from "@/lib/services/documents/process-document-pipeline.service";
import {
  readSessionIdFromRequest,
} from "@/lib/services/product-usage/record-product-usage-event";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Reprocess (retry) a document — Phase 2 re-run for the two-phase upload flow.
 *
 * Used by the "נסה שוב" action on documents that ended up `failed`, or that are
 * stuck in `processing` (e.g. the original invocation was killed at maxDuration).
 * The source file is already stored, so this NEVER re-uploads: it re-reads the
 * bytes from storage and re-runs OCR + extraction, flipping the status back to
 * needs_review / failed.
 */
export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
    }

    const params = await context.params;
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "מזהה מסמך לא תקין" }, { status: 400 });
    }

    const document = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) => tx.document.findFirst({
          where: { id, businessId: user.businessId },
      select: {
        id: true,
        businessId: true,
        status: true,
        fileUrl: true,
        mimeType: true,
      },
    }))
    );

    if (!document) {
      return NextResponse.json({ error: "המסמך לא נמצא" }, { status: 404 });
    }
    if (document.businessId !== user.businessId) {
      return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });
    }

    // Only in-flight/failed documents are retryable. A document that already
    // reached review/approval is returned as-is (idempotent no-op).
    if (document.status !== "processing" && document.status !== "failed") {
      return NextResponse.json({ success: true, status: document.status });
    }

    // Protect the OCR/Vision quota, same bucket as the upload processing gate.
    const processingDecision = await checkRateLimit({
      bucket: "DOCUMENT_PROCESSING",
      user: user.id,
      business: user.businessId,
    });
    if (!processingDecision.allowed) {
      return buildRateLimitResponse(processingDecision);
    }

    // Re-read the already-stored source file (no re-upload).
    let buffer: Buffer;
    try {
      buffer = await readDocumentObject(document.businessId, document.fileUrl);
    } catch (readError) {
      if (readError instanceof StorageObjectNotFoundError) {
        // The source file is gone — nothing to reprocess. Leave it failed.
        await prisma.document
          .update({ where: { id }, data: { status: "failed" } })
          .catch(() => {});
        return NextResponse.json(
          { error: "קובץ המקור לא נמצא. יש להעלות מחדש." },
          { status: 409 }
        );
      }
      throw readError;
    }

    // Reflect the retry immediately so pollers see it move back to processing.
    await runWithTenantContext({ businessId: user.businessId }, () =>
      withTenantTransaction((tx) =>
        tx.document.updateMany({
          where: { id, businessId: user.businessId },
          data: { status: "processing" },
        })
      )
    );

    const sessionId = readSessionIdFromRequest(req);

    // D2/P7-W4A: explicit tenant handoff — businessId comes from the
    // ownership-checked Document row and is re-established via runTenantJob.
    after(() =>
      runTenantJob({ businessId: document.businessId }, () =>
        processDocumentPipeline({
          documentId: document.id,
          businessId: document.businessId,
          userId: user.id,
          sessionId,
          buffer,
          mimeType: document.mimeType,
          sourceChannel: "reprocess",
        })
      )
    );

    return NextResponse.json({ success: true, status: "processing" });
  } catch (error) {
    console.error("DOCUMENT_REPROCESS_ERROR:", error);
    return NextResponse.json(
      { error: "שגיאה בעיבוד המסמך. נסה שוב מאוחר יותר." },
      { status: 500 }
    );
  }
}
