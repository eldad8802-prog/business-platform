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
  UnauthorizedError,
  ValidationError,
} from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { logAuditEvent } from "@/lib/services/audit.service";
import { renderBillingPdfHtmlFromSnapshot } from "@/lib/services/billing/pdf/billing-pdf-html-renderer";
import { renderBillingPdfFromSnapshot } from "@/lib/services/billing/pdf/billing-pdf-renderer";
import {
  assertSnapshotV1,
  BILLING_PDF_TEMPLATE_VERSION,
  type BillingIssuedSnapshotV1,
} from "@/lib/services/billing/pdf/billing-pdf-template";
import {
  buildStorageKey,
  existsByKey,
  readByKey,
  unlinkByKeyQuiet,
  writeAtomic,
} from "@/lib/services/billing/pdf/billing-pdf-storage";

const RENDER_ERROR_MESSAGE_MAX = 500;

/**
 * Billing PDF renderer selection.
 *
 * Default: HTML (Playwright Chromium) — better for Hebrew/RTL.
 * Override: set `BILLING_PDF_RENDERER=pdfmake` to force the legacy pdfmake path.
 */
function shouldUseHtmlBillingPdfRenderer(): boolean {
  return process.env.BILLING_PDF_RENDERER !== "pdfmake";
}

function billingPdfRendererName(): "html" | "pdfmake" {
  return shouldUseHtmlBillingPdfRenderer() ? "html" : "pdfmake";
}

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

function truncateError(message: string): string {
  if (message.length <= RENDER_ERROR_MESSAGE_MAX) return message;
  return message.slice(0, RENDER_ERROR_MESSAGE_MAX);
}

export async function getOrRenderBillingPdf(
  input: GetOrRenderBillingPdfInput
): Promise<GetOrRenderBillingPdfResult> {
  validateInput(input);

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
        if (billingPdfDebugEnabled()) {
          console.log("[billing-pdf-debug] CACHE_HIT — returning bytes from storage (no renderer)", {
            billingDocumentId: doc.id,
            pdfStorageKey: storageKey,
            pdfHashPrefix: pdfHash.slice(0, 16),
            byteLength: buffer.length,
            note:
              "bytes may be from pdfmake or html depending on what rendered last; use SKIP_CACHE+DEBUG to force re-render",
          });
        }
        return {
          buffer,
          pdfHash,
          pdfTemplateVersion: effectivePdfTemplateVersion,
          documentNumberFormatted,
          renderedNow: false,
        };
      } catch {
        // Fall through to a fresh render if the cached file became
        // unreadable between the existence check and the actual read.
      }
    }
    // file missing or unreadable → fall through to render
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
      await prisma.billingDocument.updateMany({
        where: {
          id: doc.id,
          businessId: input.businessId,
          status: BillingDocumentStatus.ISSUED,
          pdfRenderStatus: { not: BillingPdfRenderStatus.RENDERED },
        },
        data: {
          pdfRenderStatus: BillingPdfRenderStatus.FAILED,
          pdfRenderError: message,
        },
      });
    } catch (dbErr) {
      console.error("billing-pdf: failed to record FAILED status", dbErr);
    }
    try {
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
        },
      });
    } catch (auditErr) {
      console.error("billing-pdf: audit log (FAILED) error", auditErr);
    }
    throw renderError;
  }

  // ---------------------------------------------------------------------
  // Persist success — guarded updateMany. count !== 1 is acceptable
  // (race with another renderer or status change) and not surfaced.
  // ---------------------------------------------------------------------
  let dbUpdateCount = 0;
  try {
    const result = await prisma.billingDocument.updateMany({
      where: {
        id: doc.id,
        businessId: input.businessId,
        status: BillingDocumentStatus.ISSUED,
        OR: [
          { pdfRenderStatus: { not: BillingPdfRenderStatus.RENDERED } },
          { pdfTemplateVersion: { not: effectivePdfTemplateVersion } },
        ],
      },
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
