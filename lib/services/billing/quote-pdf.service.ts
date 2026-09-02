import { createHash } from "crypto";
import {
  BillingDocumentType,
  BillingPdfRenderStatus,
} from "@prisma/client";
import {
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { logAuditEvent } from "@/lib/services/audit.service";
import { createBillingAuditEventBestEffort } from "@/lib/services/billing/billing-audit.service";
import { allocateQuoteDocumentNumberIfMissing } from "@/lib/services/billing/quote-document-number";
import { buildQuotePdfSnapshot } from "@/lib/services/billing/quote-pdf-snapshot";
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
import { updateBillingDocuments } from "@/lib/services/billing/domain/billing-document-mutation.gateway";
import { billingTenantTx } from "./billing-tenant-tx";

const RENDER_ERROR_MESSAGE_MAX = 500;

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

function billingPdfSkipCache(): boolean {
  return process.env.BILLING_PDF_SKIP_CACHE === "1";
}

export type GetOrRenderQuotePdfInput = {
  businessId: number;
  billingDocumentId: number;
  actorUserId: number;
};

export type GetOrRenderQuotePdfResult = {
  buffer: Buffer;
  pdfHash: string;
  pdfTemplateVersion: string;
  documentNumberFormatted: string;
  renderedNow: boolean;
};

function validateInput(input: GetOrRenderQuotePdfInput): void {
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

export async function getOrRenderQuotePdf(
  input: GetOrRenderQuotePdfInput
): Promise<GetOrRenderQuotePdfResult> {
  validateInput(input);

  const allocated = await billingTenantTx(input.businessId, async (tx) => {
    const docCheck = await tx.billingDocument.findFirst({
      where: {
        id: input.billingDocumentId,
        businessId: input.businessId,
        documentType: BillingDocumentType.QUOTE,
      },
      select: { id: true, convertedToInvoiceId: true },
    });
    if (!docCheck) {
      throw new NotFoundError("Quote document not found");
    }
    return allocateQuoteDocumentNumberIfMissing(tx, {
      businessId: input.businessId,
      billingDocumentId: input.billingDocumentId,
    });
  });

  const doc = await billingTenantTx(input.businessId, (tx) =>
    tx.billingDocument.findFirst({
    where: {
      id: input.billingDocumentId,
      businessId: input.businessId,
      documentType: BillingDocumentType.QUOTE,
    },
    include: { lines: { orderBy: { lineIndex: "asc" } } },
  })
  );

  if (!doc) {
    throw new NotFoundError("Quote document not found");
  }

  const customerNameSnapshot = (doc.customerNameSnapshot ?? "").trim();
  if (customerNameSnapshot.length === 0) {
    throw new ValidationError("יש למלא שם לקוח לפני יצירת PDF להצעה");
  }

  if (doc.lines.length === 0) {
    throw new ValidationError("יש להוסיף לפחות שורת מוצר/שירות לפני יצירת PDF");
  }

  const documentNumberFormatted =
    doc.documentNumberFormatted ?? allocated.documentNumberFormatted;

  const business = await prisma.business.findUnique({
    where: { id: input.businessId },
    select: {
      id: true,
      name: true,
      profile: {
        select: {
          billingLegalName: true,
          billingTaxId: true,
          billingVatNumber: true,
          billingPhone: true,
          billingEmail: true,
          billingAddress: true,
          billingPaymentNote: true,
          billingFooterNote: true,
          billingLogoDataUrl: true,
          billingSignatureDataUrl: true,
          billingPdfTemplateStyle: true,
        },
      },
    },
  });

  if (!business) {
    throw new NotFoundError("Business not found");
  }

  let customerData:
    | {
        id: number;
        name: string;
        phone: string | null;
        email: string | null;
        city: string | null;
      }
    | null = null;

  if (doc.customerId !== null) {
    const docCustomerId = doc.customerId;
    const customer = await billingTenantTx(input.businessId, (tx) =>
    tx.customer.findFirst({
      where: { id: docCustomerId, businessId: input.businessId },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        city: true,
      },
    })
  );
    if (customer) {
      customerData = customer;
    }
  }

  const totals = {
    subtotalAmount: doc.subtotalAmount,
    vatAmount: doc.vatAmount,
    totalAmount: doc.totalAmount,
  };

  const snapshot: BillingIssuedSnapshotV1 = buildQuotePdfSnapshot({
    document: doc,
    lines: doc.lines,
    business,
    customer: customerData,
    documentNumber: doc.documentNumber ?? allocated.documentNumber,
    documentNumberFormatted,
    snapshotDate: new Date(),
    actorUserId: input.actorUserId,
    totals,
  });

  assertSnapshotV1(snapshot);

  const effectivePdfTemplateVersion = billingPdfTemplateVersionForRenderer();

  let cacheCandidate =
    doc.pdfRenderStatus === BillingPdfRenderStatus.RENDERED &&
    typeof doc.pdfStorageKey === "string" &&
    doc.pdfStorageKey.length > 0 &&
    typeof doc.pdfHash === "string" &&
    doc.pdfHash.length > 0 &&
    doc.pdfRenderedAt != null &&
    doc.updatedAt <= doc.pdfRenderedAt &&
    doc.pdfTemplateVersion === effectivePdfTemplateVersion;

  if (billingPdfSkipCache()) {
    cacheCandidate = false;
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
        return {
          buffer,
          pdfHash,
          pdfTemplateVersion: effectivePdfTemplateVersion,
          documentNumberFormatted,
          renderedNow: false,
        };
      } catch {
        // fall through
      }
    }
  }

  let buffer: Buffer;
  let pdfHash: string;
  let storageKey: string;

  try {
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
    try {
      await billingTenantTx(input.businessId, (tx) =>
      updateBillingDocuments(tx, {
        where: {
          id: doc.id,
          businessId: input.businessId,
          documentType: BillingDocumentType.QUOTE,
          pdfRenderStatus: { not: BillingPdfRenderStatus.RENDERED },
        },
        intent: "quote_operational",
        data: {
          pdfRenderStatus: BillingPdfRenderStatus.FAILED,
          pdfRenderError: message,
        },
      })
    );
    } catch (dbErr) {
      console.error("quote-pdf: failed to record FAILED status", dbErr);
    }
    await createBillingAuditEventBestEffort({
      businessId: input.businessId,
      billingDocumentId: doc.id,
      actorUserId: input.actorUserId,
      eventType: "BILLING_PDF_RENDER_FAILED",
      summary: "Quote PDF render failed",
      metadata: {
        documentId: doc.id,
        documentType: doc.documentType,
        actorUserId: input.actorUserId,
        errorMessage: message,
        pdfTemplateVersion: effectivePdfTemplateVersion,
      },
    });
    throw renderError;
  }

  let dbUpdateCount = 0;
  try {
    const result = await billingTenantTx(input.businessId, (tx) =>
      updateBillingDocuments(tx, {
      where: {
        id: doc.id,
        businessId: input.businessId,
        documentType: BillingDocumentType.QUOTE,
        OR: [
          { pdfRenderStatus: { not: BillingPdfRenderStatus.RENDERED } },
          { pdfTemplateVersion: { not: effectivePdfTemplateVersion } },
        ],
      },
      intent: "quote_operational",
      data: {
        pdfRenderStatus: BillingPdfRenderStatus.RENDERED,
        pdfStorageKey: storageKey,
        pdfHash,
        pdfTemplateVersion: effectivePdfTemplateVersion,
        pdfRenderedAt: new Date(),
        pdfRenderError: null,
      },
    })
    );
    dbUpdateCount = result.count;
  } catch (dbErr) {
    console.error("quote-pdf: failed to record RENDERED status", dbErr);
    await unlinkByKeyQuiet(storageKey);
    throw dbErr;
  }

  if (dbUpdateCount === 1) {
    try {
      await createBillingAuditEventBestEffort({
        businessId: input.businessId,
        billingDocumentId: doc.id,
        actorUserId: input.actorUserId,
        eventType: "BILLING_QUOTE_PDF_RENDERED",
        summary: "Quote PDF rendered",
        metadata: {
          documentId: doc.id,
          documentType: doc.documentType,
          actorUserId: input.actorUserId,
          pdfHash,
          pdfStorageKey: storageKey,
          pdfTemplateVersion: effectivePdfTemplateVersion,
          byteLength: buffer.length,
        },
      });
      await logAuditEvent({
        businessId: input.businessId,
        eventType: "BILLING_QUOTE_PDF_RENDERED",
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
      console.error("quote-pdf: audit log error", auditErr);
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
