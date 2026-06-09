// Billing PDF orchestrator.
//
// Single public entry point: getOrRenderBillingPdf.
// Owns the render-or-cache decision, filesystem coordination, DB updates of
// PDF fields, and post-commit audit. Never wraps work in $transaction —
// pdfmake is heavy, and the Issue transaction must remain untouched.
//
// Status transitions handled here (PDF subset of pdfRenderStatus only):
//   PENDING / FAILED  → render → RENDERED (success) or FAILED (error)
//   RENDERED + valid  → cache hit, no pdfmake invocation
//
// pdfTemplateVersion is recorded for documentation/debug only. A mismatch
// between the stored version and BILLING_PDF_TEMPLATE_VERSION does NOT
// trigger a re-render in MVP.
//
// Debug (dev): `BILLING_PDF_DEBUG_LOG=1` logs cache vs render + snapshot excerpts.
// Force re-render without deleting data: `BILLING_PDF_SKIP_CACHE=1` (skips serving stored PDF).

import { createHash } from "crypto";
import {
  BillingDocumentStatus,
  BillingPdfRenderStatus,
} from "@prisma/client";
import {
  ForbiddenError,
  NotFoundError,
  PdfIntegrityCheckFailedError,
  UnauthorizedError,
  ValidationError,
} from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { logAuditEvent } from "@/lib/services/audit.service";
import { createBillingAuditEventBestEffort } from "@/lib/services/billing/billing-audit.service";
import { renderBillingPdfHtmlFromSnapshot } from "@/lib/services/billing/pdf/billing-pdf-html-renderer";
import { renderBillingPdfFromSnapshot } from "@/lib/services/billing/pdf/billing-pdf-renderer";
import {
  assertSnapshotV1,
  BILLING_PDF_TEMPLATE_VERSION,
  type BillingIssuedSnapshotV1,
} from "@/lib/services/billing/pdf/billing-pdf-template";
import {
  assertBillingPdfRendererPolicy,
  billingPdfRendererName,
  shouldUseHtmlBillingPdfRenderer,
} from "@/lib/services/billing/pdf/billing-pdf-renderer-policy";
import {
  buildStorageKey,
  existsByKey,
  readByKey,
  unlinkByKeyQuiet,
  writeAtomic,
} from "@/lib/services/billing/pdf/billing-pdf-storage";
import { updateBillingDocuments } from "@/lib/services/billing/domain/billing-document-mutation.gateway";

const RENDER_ERROR_MESSAGE_MAX = 500;

function billingPdfTemplateVersionForRenderer(): string {
  // Used to prevent serving old cached PDFs produced by a different renderer.
  return `${BILLING_PDF_TEMPLATE_VERSION}-${billingPdfRendererName()}`;
}

/** Temporary diagnostics — set `BILLING_PDF_DEBUG_LOG=1` (dev only). */
function billingPdfDebugEnabled(): boolean {
  return process.env.BILLING_PDF_DEBUG_LOG === "1";
}

/**
 * When `BILLING_PDF_SKIP_CACHE=1`, never serve a stored PDF; always re-render.
 * Does not delete DB rows or storage files; safe for local debugging.
 */
function billingPdfSkipCache(): boolean {
  return process.env.BILLING_PDF_SKIP_CACHE === "1";
}

export type GetOrRenderBillingPdfInput = {
  businessId: number;
  billingDocumentId: number;
  actorUserId: number;
};

export type GetOrRenderBillingPdfResult = {
  buffer: Buffer;
  pdfHash: string;
  pdfTemplateVersion: string;
  documentNumberFormatted: string;
  renderedNow: boolean;
};

function validateInput(input: GetOrRenderBillingPdfInput): void {
  if (!input.businessId || !Number.isInteger(input.businessId) || input.businessId <= 0) {
    throw new UnauthorizedError();
  }
  if (
    !input.actorUserId ||
    !Number.isInteger(input.actorUserId) ||
    input.actorUserId <= 0
  ) {
    throw new UnauthorizedError();
  }
  if (
    !input.billingDocumentId ||
    !Number.isInteger(input.billingDocumentId) ||
    input.billingDocumentId <= 0
  ) {
    throw new ValidationError("billingDocumentId must be a positive integer");
  }
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** H2a: verify stored PDF bytes match the persisted pdfHash before cache serve. */
export function verifyCachedPdfBytes(
  buffer: Buffer,
  expectedPdfHash: string
): boolean {
  return sha256Hex(buffer) === expectedPdfHash.toLowerCase();
}

export function rethrowRenderFailure(
  integrityMismatchDetected: boolean,
  renderError: unknown
): never {
  if (integrityMismatchDetected) {
    throw new PdfIntegrityCheckFailedError();
  }
  throw renderError;
}

function truncateError(message: string): string {
  if (message.length <= RENDER_ERROR_MESSAGE_MAX) return message;
  return message.slice(0, RENDER_ERROR_MESSAGE_MAX);
}

export async function getOrRenderBillingPdf(
  input: GetOrRenderBillingPdfInput
): Promise<GetOrRenderBillingPdfResult> {
  validateInput(input);
  assertBillingPdfRendererPolicy();

  const doc = await prisma.billingDocument.findFirst({
    where: {
      id: input.billingDocumentId,
      businessId: input.businessId,
    },
    select: {
      id: true,
      businessId: true,
      status: true,
      documentNumberFormatted: true,
      issuedSnapshot: true,
      pdfRenderStatus: true,
      pdfStorageKey: true,
      pdfHash: true,
      pdfTemplateVersion: true,
    },
  });

  if (!doc) {
    throw new NotFoundError("Billing document not found");
  }

  if (doc.status !== BillingDocumentStatus.ISSUED) {
    throw new ForbiddenError("PDF is available only for issued documents");
  }

  if (!doc.issuedSnapshot || typeof doc.issuedSnapshot !== "object") {
    throw new ValidationError("Issued document is missing issuedSnapshot");
  }
  if (typeof doc.documentNumberFormatted !== "string" || !doc.documentNumberFormatted) {
    throw new ValidationError("Issued document is missing documentNumberFormatted");
  }

  let snapshot: BillingIssuedSnapshotV1;
  try {
    assertSnapshotV1(doc.issuedSnapshot);
    snapshot = doc.issuedSnapshot as unknown as BillingIssuedSnapshotV1;
  } catch (err) {
    throw new ValidationError(
      err instanceof Error ? err.message : "Invalid issued snapshot"
    );
  }

  const documentNumberFormatted = doc.documentNumberFormatted;
  const effectivePdfTemplateVersion = billingPdfTemplateVersionForRenderer();

  const firstLineDescription =
    snapshot.lines.length > 0 ? snapshot.lines[0].description : "(no lines)";

  if (billingPdfDebugEnabled()) {
    console.log("[billing-pdf-debug] snapshot + env (before cache/render)", {
      billingDocumentId: doc.id,
      businessId: input.businessId,
      BILLING_PDF_RENDERER: process.env.BILLING_PDF_RENDERER ?? "(unset)",
      useHtmlRenderer: shouldUseHtmlBillingPdfRenderer(),
      effectiveRenderer: billingPdfRendererName(),
      effectivePdfTemplateVersion,
      BILLING_PDF_SKIP_CACHE: billingPdfSkipCache(),
      customerNameFromSnapshot: snapshot.customer.name,
      firstLineDescriptionFromSnapshot: firstLineDescription,
    });
  }

  // ---------------------------------------------------------------------
  // Cache decision
  // pdfTemplateVersion is intentionally NOT part of the cache check (MVP):
  // an existing valid file is served regardless of its template version.
  // ---------------------------------------------------------------------
  let cacheCandidate =
    doc.pdfRenderStatus === BillingPdfRenderStatus.RENDERED &&
    typeof doc.pdfStorageKey === "string" &&
    doc.pdfStorageKey.length > 0 &&
    typeof doc.pdfHash === "string" &&
    doc.pdfHash.length > 0 &&
    doc.pdfTemplateVersion === effectivePdfTemplateVersion;

  if (billingPdfSkipCache()) {
    cacheCandidate = false;
    if (billingPdfDebugEnabled()) {
      console.log(
        "[billing-pdf-debug] SKIP_CACHE=1 — bypassing stored PDF (will re-render if reached)"
      );
    }
  }

  let integrityMismatchDetected = false;
  let integrityMismatchActualHash: string | null = null;

  if (cacheCandidate) {
    const storageKey = doc.pdfStorageKey as string;
    const pdfHash = doc.pdfHash as string;
    let fileExists = false;
    try {
      fileExists = await existsByKey(storageKey);
    } catch {
      fileExists = false;
    }
    if (fileExists) {
      try {
        const buffer = await readByKey(storageKey);
        if (verifyCachedPdfBytes(buffer, pdfHash)) {
          if (billingPdfDebugEnabled()) {
            console.log(
              "[billing-pdf-debug] CACHE_HIT — verified bytes from storage (no renderer)",
              {
                billingDocumentId: doc.id,
                pdfStorageKey: storageKey,
                pdfHashPrefix: pdfHash.slice(0, 16),
                byteLength: buffer.length,
              }
            );
          }
          return {
            buffer,
            pdfHash,
            pdfTemplateVersion: effectivePdfTemplateVersion,
            documentNumberFormatted,
            renderedNow: false,
          };
        }

        integrityMismatchDetected = true;
        integrityMismatchActualHash = sha256Hex(buffer);
        if (billingPdfDebugEnabled()) {
          console.log("[billing-pdf-debug] CACHE_INTEGRITY_MISMATCH — re-rendering", {
            billingDocumentId: doc.id,
            pdfStorageKey: storageKey,
            storedPdfHashPrefix: pdfHash.slice(0, 16),
            actualPdfHashPrefix: integrityMismatchActualHash.slice(0, 16),
          });
        }
      } catch {
        // Fall through to a fresh render if the cached file became
        // unreadable between the existence check and the actual read.
      }
    }
    // file missing, unreadable, or hash mismatch → fall through to render
  }

  // ---------------------------------------------------------------------
  // Render path
  // ---------------------------------------------------------------------
  let buffer: Buffer;
  let pdfHash: string;
  let storageKey: string;

  try {
    if (billingPdfDebugEnabled()) {
      console.log("[billing-pdf-debug] RENDER_PATH — invoking renderer", {
        billingDocumentId: doc.id,
        renderer: shouldUseHtmlBillingPdfRenderer()
          ? "renderBillingPdfHtmlFromSnapshot"
          : "renderBillingPdfFromSnapshot (pdfmake)",
      });
    }
    buffer = shouldUseHtmlBillingPdfRenderer()
      ? await renderBillingPdfHtmlFromSnapshot(snapshot)
      : await renderBillingPdfFromSnapshot(snapshot);
    if (!buffer || buffer.length === 0) {
      throw new Error("Renderer produced empty buffer");
    }
    pdfHash = sha256Hex(buffer);
    storageKey = buildStorageKey(input.businessId, doc.id, pdfHash);
    await writeAtomic(storageKey, buffer);
  } catch (renderError) {
    const message = truncateError(
      renderError instanceof Error
        ? renderError.message
        : "PDF rendering failed"
    );
    // Best-effort: only mark FAILED if the document is still ISSUED and
    // not already RENDERED (don't clobber a successful concurrent render).
    try {
      await updateBillingDocuments(prisma, {
        where: {
          id: doc.id,
          businessId: input.businessId,
          pdfRenderStatus: { not: BillingPdfRenderStatus.RENDERED },
        },
        intent: "issued_operational",
        data: {
          pdfRenderStatus: BillingPdfRenderStatus.FAILED,
          pdfRenderError: message,
        },
      });
    } catch (dbErr) {
      console.error("billing-pdf: failed to record FAILED status", dbErr);
    }
    try {
      await createBillingAuditEventBestEffort({
        businessId: input.businessId,
        billingDocumentId: doc.id,
        actorUserId: input.actorUserId,
        eventType: "BILLING_PDF_RENDER_FAILED",
        summary: integrityMismatchDetected
          ? "Billing PDF integrity check failed"
          : "Billing PDF render failed",
        metadata: {
          documentId: doc.id,
          documentType: snapshot.document.type,
          actorUserId: input.actorUserId,
          errorMessage: message,
          pdfTemplateVersion: effectivePdfTemplateVersion,
          ...(integrityMismatchDetected
            ? {
                integrityCheckFailed: true,
                storedPdfHash: doc.pdfHash,
                actualPdfHash: integrityMismatchActualHash,
              }
            : {}),
        },
      });
      await logAuditEvent({
        businessId: input.businessId,
        eventType: "BILLING_PDF_RENDER_FAILED",
        entityType: "BILLING_DOCUMENT",
        entityId: doc.id,
        payload: {
          documentId: doc.id,
          actorUserId: input.actorUserId,
          errorMessage: message,
          templateVersion: BILLING_PDF_TEMPLATE_VERSION,
          ...(integrityMismatchDetected
            ? {
                integrityCheckFailed: true,
                storedPdfHash: doc.pdfHash,
                actualPdfHash: integrityMismatchActualHash,
              }
            : {}),
        },
      });
    } catch (auditErr) {
      console.error("billing-pdf: audit log (FAILED) error", auditErr);
    }
    rethrowRenderFailure(integrityMismatchDetected, renderError);
  }

  // ---------------------------------------------------------------------
  // Persist success — guarded updateMany. count !== 1 is acceptable
  // (race with another renderer or status change) and not surfaced.
  // ---------------------------------------------------------------------
  let dbUpdateCount = 0;
  try {
    const result = await updateBillingDocuments(prisma, {
      where: {
        id: doc.id,
        businessId: input.businessId,
        ...(integrityMismatchDetected
          ? {}
          : {
              OR: [
                { pdfRenderStatus: { not: BillingPdfRenderStatus.RENDERED } },
                { pdfTemplateVersion: { not: effectivePdfTemplateVersion } },
              ],
            }),
      },
      intent: "issued_operational",
      data: {
        pdfRenderStatus: BillingPdfRenderStatus.RENDERED,
        pdfStorageKey: storageKey,
        pdfHash,
        pdfTemplateVersion: effectivePdfTemplateVersion,
        pdfRenderedAt: new Date(),
        pdfRenderError: null,
      },
    });
    dbUpdateCount = result.count;
  } catch (dbErr) {
    // The bytes are already on disk and hashed. Don't fail the user;
    // log so the operator can reconcile state.
    console.error("billing-pdf: failed to record RENDERED status", dbErr);
    // Best-effort cleanup of the orphan file we just wrote.
    await unlinkByKeyQuiet(storageKey);
    throw dbErr;
  }

  if (dbUpdateCount === 1) {
    try {
      await createBillingAuditEventBestEffort({
        businessId: input.businessId,
        billingDocumentId: doc.id,
        actorUserId: input.actorUserId,
        eventType: "BILLING_PDF_RENDERED",
        summary: "Billing PDF rendered",
        metadata: {
          documentId: doc.id,
          documentType: snapshot.document.type,
          actorUserId: input.actorUserId,
          pdfHash,
          pdfStorageKey: storageKey,
          pdfTemplateVersion: effectivePdfTemplateVersion,
          byteLength: buffer.length,
        },
      });
      await logAuditEvent({
        businessId: input.businessId,
        eventType: "BILLING_PDF_RENDERED",
        entityType: "BILLING_DOCUMENT",
        entityId: doc.id,
        payload: {
          documentId: doc.id,
          actorUserId: input.actorUserId,
          pdfHash,
          pdfStorageKey: storageKey,
          pdfTemplateVersion: BILLING_PDF_TEMPLATE_VERSION,
          byteLength: buffer.length,
        },
      });
    } catch (auditErr) {
      console.error("billing-pdf: audit log (RENDERED) error", auditErr);
    }
  }

  return {
    buffer,
    pdfHash,
    pdfTemplateVersion: effectivePdfTemplateVersion,
    documentNumberFormatted,
    renderedNow: true,
  };
}
