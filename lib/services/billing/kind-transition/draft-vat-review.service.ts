/**
 * 4a T3 — read the VAT-review state of a draft, and record the owner's explicit confirmation.
 * See draft-vat-review.ts for the rule. GET/POST /api/billing/documents/[id]/vat-review.
 */
import { BillingDocumentStatus } from "@prisma/client";

import { ConflictError, NotFoundError, UnauthorizedError, ValidationError } from "@/lib/errors";
import { createBillingAuditEventTx } from "@/lib/services/billing/billing-audit.service";
import { billingTenantTx } from "@/lib/services/billing/billing-tenant-tx";
import {
  DRAFT_VAT_REVIEW_EVENT,
  evaluateDraftVatReviewTx,
  type DraftVatReviewState,
} from "@/lib/services/billing/kind-transition/draft-vat-review";
import { lockBillingDocumentRowsTx } from "@/lib/services/billing/receipt/billing-receipt-issuance-integrity";

export const DRAFT_VAT_REVIEW_STALE_CODE = "DRAFT_VAT_REVIEW_STALE" as const;
export const DRAFT_VAT_REVIEW_NOT_EDITABLE_CODE = "DRAFT_VAT_REVIEW_NOT_EDITABLE" as const;

const EDITABLE: string[] = [BillingDocumentStatus.DRAFT, BillingDocumentStatus.PENDING_REVIEW];

function assertIds(businessId: number, billingDocumentId: number, actorUserId?: number) {
  if (!Number.isInteger(businessId) || businessId <= 0) throw new UnauthorizedError();
  if (actorUserId !== undefined && (!Number.isInteger(actorUserId) || actorUserId <= 0)) throw new UnauthorizedError();
  if (!Number.isInteger(billingDocumentId) || billingDocumentId <= 0) throw new ValidationError("Invalid billing document id");
}

export type DraftVatReviewView = DraftVatReviewState & {
  lines?: Array<{ lineIndex: number; description: string; vatRatePercent: string }>;
};

async function loadDoc(tx: Parameters<typeof evaluateDraftVatReviewTx>[0], businessId: number, billingDocumentId: number) {
  const doc = await tx.billingDocument.findFirst({
    where: { id: billingDocumentId, businessId },
    include: { lines: { orderBy: { lineIndex: "asc" } } },
  });
  if (!doc) throw new NotFoundError("Billing document not found");
  return doc;
}

/** Read only. Issued documents are never in review: they are frozen. */
export async function readDraftVatReview(input: { businessId: number; billingDocumentId: number }): Promise<DraftVatReviewView> {
  assertIds(input.businessId, input.billingDocumentId);
  return billingTenantTx(input.businessId, async (tx) => {
    const doc = await loadDoc(tx, input.businessId, input.billingDocumentId);
    if (!EDITABLE.includes(doc.status)) return { required: false, reason: "TYPE_NOT_IN_SCOPE" } as DraftVatReviewView;
    const s = await evaluateDraftVatReviewTx(tx, doc);
    if (!s.required) return s;
    return { ...s, lines: doc.lines.map((l) => ({ lineIndex: l.lineIndex, description: l.description, vatRatePercent: l.vatRatePercent.toString() })) };
  });
}

/**
 * The explicit confirmation. `fingerprint` is the one the owner saw (from readDraftVatReview): the document row is locked
 * (the same lock issuance takes), the content re-read and re-fingerprinted; if it changed in between, nothing is recorded
 * (409 DRAFT_VAT_REVIEW_STALE) and the owner reviews again. Rates, prices and amounts are never changed here.
 */
export async function confirmDraftVatReview(input: { businessId: number; actorUserId: number; billingDocumentId: number; fingerprint: unknown }): Promise<DraftVatReviewState> {
  assertIds(input.businessId, input.billingDocumentId, input.actorUserId);
  if (typeof input.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(input.fingerprint)) throw new ValidationError("fingerprint is required");
  return billingTenantTx(input.businessId, async (tx) => {
    await lockBillingDocumentRowsTx(tx, input.businessId, [input.billingDocumentId]);
    const doc = await loadDoc(tx, input.businessId, input.billingDocumentId);
    if (!EDITABLE.includes(doc.status)) throw new ConflictError(DRAFT_VAT_REVIEW_NOT_EDITABLE_CODE, "המסמך כבר הופק ואינו ניתן לשינוי.");
    const s = await evaluateDraftVatReviewTx(tx, doc);
    if (!s.required) return s;
    if (s.fingerprint !== input.fingerprint) throw new ConflictError(DRAFT_VAT_REVIEW_STALE_CODE, "המסמך השתנה מאז שנפתחה הבדיקה. יש לבדוק שוב את שיעורי המע״מ.");
    if (s.reviewed) return s;
    await createBillingAuditEventTx(tx, {
      businessId: input.businessId,
      billingDocumentId: doc.id,
      actorUserId: input.actorUserId,
      eventType: DRAFT_VAT_REVIEW_EVENT,
      summary: "VAT rates reviewed and confirmed after the exempt → authorized transition",
      metadata: {
        fingerprint: s.fingerprint,
        transitionId: s.transitionId,
        transitionConfirmedAt: s.transitionConfirmedAt,
        originCreatedAt: s.originCreatedAt,
        documentType: doc.documentType,
        zeroRateLineIndexes: s.zeroRateLineIndexes,
      },
    });
    return { ...s, reviewed: true };
  });
}
