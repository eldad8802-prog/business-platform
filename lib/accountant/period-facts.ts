/**
 * Loads the facts of one accounting range for one business — read-only, tenant-scoped.
 *
 * Every read runs inside a tenant transaction (`app.current_business_id`), so FORCE RLS applies and a
 * missing context is an error, never a silently empty package (the failure mode of the uniform-file
 * loader, which reads through the global client).
 */

import { BillingDocumentStatus, BillingDocumentType, BillingPdfRenderStatus } from "@prisma/client";
import { getTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import type { TenantTx } from "@/lib/tenant/transaction";
import { evaluateAuthorityDeliverability } from "@/lib/services/billing/authority/billing-authority-delivery.rules";
import { isBillingSigningActive } from "@/lib/services/billing/signing-activation";
import type { IssuedPdfState, PeriodFacts } from "./package-scope";
import type { PeriodRange } from "./period";

/** Document statuses that mean "not reviewed yet" for a period (canonical `needs_review` + the two machine states). */
export const PENDING_DOCUMENT_STATUSES = ["needs_review", "processing", "failed"] as const;

export type IssuedPdfInputs = {
  documentType: BillingDocumentType;
  pdfRenderStatus: BillingPdfRenderStatus;
  pdfStorageKey: string | null;
  pdfHash: string | null;
  signedPdfStorageKey: string | null;
  signedPdfHash: string | null;
  allocationNumber: string | null;
  authoritySubmission: {
    status: Parameters<typeof evaluateAuthorityDeliverability>[0]["submissionStatus"];
    heldDecisionType: Parameters<typeof evaluateAuthorityDeliverability>[0]["heldDecisionType"];
    heldDecisionReportedAt: Date | null;
  } | null;
};

/**
 * Whether an issued document's FINAL PDF may go into a package, and which stored object it is.
 *
 * The same rules as the owner's own PDF download: the tax-authority delivery gate first (a document
 * that needs an allocation number is not deliverable without one), then the artifact — the signed
 * copy when signing is active, the rendered copy otherwise. Nothing is rendered or signed here; a
 * background build only reads what already exists, and anything missing becomes an open item that
 * an owner-triggered rebuild resolves through the billing PDF service (with the owner as the actor).
 */
export function issuedPdfState(doc: IssuedPdfInputs, signingActive: boolean): IssuedPdfState {
  const gate = evaluateAuthorityDeliverability({
    documentType: doc.documentType,
    submissionStatus: doc.authoritySubmission?.status ?? null,
    heldDecisionType: doc.authoritySubmission?.heldDecisionType ?? null,
    heldDecisionReportedAt: doc.authoritySubmission?.heldDecisionReportedAt ?? null,
    documentAllocationNumber: doc.allocationNumber,
  });
  if (!gate.deliverable) return { available: false, reason: "AUTHORITY_NOT_DELIVERABLE" };

  if (signingActive) {
    if (doc.signedPdfStorageKey && doc.signedPdfHash && /^[0-9a-f]{64}$/i.test(doc.signedPdfHash)) {
      return { available: true, storageKey: doc.signedPdfStorageKey, sha256: doc.signedPdfHash.toLowerCase() };
    }
    return { available: false, reason: "NOT_SIGNED" };
  }

  if (doc.pdfRenderStatus === BillingPdfRenderStatus.FAILED) return { available: false, reason: "RENDER_FAILED" };
  if (
    doc.pdfRenderStatus === BillingPdfRenderStatus.RENDERED &&
    doc.pdfStorageKey &&
    doc.pdfHash &&
    /^[0-9a-f]{64}$/i.test(doc.pdfHash)
  ) {
    return { available: true, storageKey: doc.pdfStorageKey, sha256: doc.pdfHash.toLowerCase() };
  }
  return { available: false, reason: "NOT_RENDERED" };
}

function requireContext(businessId: number): void {
  const ctx = getTenantContext();
  if (!ctx) {
    throw new Error("accountant period facts require a tenant context — wrap the call in runWithTenantContext({ businessId })");
  }
  if (ctx.businessId !== businessId) {
    throw new Error("accountant period facts: tenant context does not match the requested business");
  }
}

export type LoadFactsOptions = {
  /** Category filter for the ad-hoc export screen. Applies to scanned records only. */
  categories?: string[];
  signingActive?: boolean;
};

async function loadInTx(
  tx: TenantTx,
  businessId: number,
  range: PeriodRange,
  options: LoadFactsOptions
): Promise<PeriodFacts> {
  const window = { gte: range.from, lt: range.toExclusive };
  const categories = options.categories?.filter((c) => typeof c === "string" && c.length > 0) ?? [];

  const records = await tx.financialRecord.findMany({
    where: {
      businessId,
      date: window,
      ...(categories.length > 0 ? { category: { in: categories } } : {}),
    },
    select: {
      id: true,
      documentId: true,
      amount: true,
      date: true,
      direction: true,
      category: true,
      vendorName: true,
      document: {
        select: {
          createdAt: true,
          status: true,
          fileUrl: true,
          extractedData: { select: { amountConfidence: true, confidenceScore: true } },
        },
      },
    },
    orderBy: [{ date: "asc" }, { id: "asc" }],
  });

  const issuedRows = await tx.billingDocument.findMany({
    where: {
      businessId,
      status: BillingDocumentStatus.ISSUED,
      documentType: { not: BillingDocumentType.QUOTE },
      issuedAt: window,
    },
    select: {
      id: true,
      documentType: true,
      documentNumberFormatted: true,
      issuedAt: true,
      subtotalAmount: true,
      vatAmount: true,
      totalAmount: true,
      currency: true,
      customerNameSnapshot: true,
      referenceDocumentId: true,
      pdfRenderStatus: true,
      pdfStorageKey: true,
      pdfHash: true,
      signedPdfStorageKey: true,
      signedPdfHash: true,
      allocationNumber: true,
      authoritySubmission: { select: { status: true, heldDecisionType: true, heldDecisionReportedAt: true } },
    },
    orderBy: [{ issuedAt: "asc" }, { id: "asc" }],
  });

  // A document that is not reviewed yet "may belong" to the period by its extracted date, or by its
  // upload time when nothing was extracted.
  const pendingRows = await tx.document.findMany({
    where: {
      businessId,
      status: { in: [...PENDING_DOCUMENT_STATUSES] },
      OR: [
        { extractedData: { is: { date: window } } },
        { extractedData: { is: { date: null } }, createdAt: window },
        { extractedData: { is: null }, createdAt: window },
      ],
    },
    select: { id: true, status: true, createdAt: true, extractedData: { select: { date: true } } },
    orderBy: { id: "asc" },
  });

  const profile = await tx.businessProfile.findUnique({
    where: { businessId },
    select: { billingLegalName: true, billingTaxId: true },
  });

  const signingActive = options.signingActive ?? isBillingSigningActive();

  return {
    scanned: records.map((r) => ({
      id: r.id,
      documentId: r.documentId,
      amount: r.amount,
      date: r.date,
      direction: r.direction,
      category: r.category,
      vendorName: r.vendorName,
      documentCreatedAt: r.document.createdAt,
      documentStatus: r.document.status,
      fileUrl: r.document.fileUrl ?? null,
      confidenceLabel: r.document.extractedData?.amountConfidence ?? null,
      confidenceScore: r.document.extractedData?.confidenceScore ?? null,
    })),
    issued: issuedRows
      .filter((d): d is typeof d & { issuedAt: Date } => d.issuedAt !== null)
      .map((d) => ({
        id: d.id,
        documentType: d.documentType,
        documentNumberFormatted: d.documentNumberFormatted,
        issuedAt: d.issuedAt,
        subtotalAmount: d.subtotalAmount.toFixed(2),
        vatAmount: d.vatAmount.toFixed(2),
        totalAmount: d.totalAmount.toFixed(2),
        currency: d.currency,
        customerName: d.customerNameSnapshot,
        referenceDocumentId: d.referenceDocumentId,
        pdf: issuedPdfState(
          {
            documentType: d.documentType,
            pdfRenderStatus: d.pdfRenderStatus,
            pdfStorageKey: d.pdfStorageKey,
            pdfHash: d.pdfHash,
            signedPdfStorageKey: d.signedPdfStorageKey,
            signedPdfHash: d.signedPdfHash,
            allocationNumber: d.allocationNumber,
            authoritySubmission: d.authoritySubmission,
          },
          signingActive
        ),
      })),
    pending: pendingRows.map((p) => ({
      id: p.id,
      status: p.status,
      createdAt: p.createdAt,
      extractedDate: p.extractedData?.date ?? null,
    })),
    identity: {
      legalName: profile?.billingLegalName ?? null,
      taxId: profile?.billingTaxId ?? null,
    },
  };
}

/** Reads the facts of `range` for `businessId`. Must run inside that business's tenant context. */
export async function loadPeriodFacts(
  businessId: number,
  range: PeriodRange,
  options: LoadFactsOptions = {}
): Promise<PeriodFacts> {
  requireContext(businessId);
  return withTenantTransaction((tx) => loadInTx(tx, businessId, range, options));
}
