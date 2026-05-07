import { BillingDocumentStatus } from "@prisma/client";

export function canEditDraft(status: BillingDocumentStatus): boolean {
  return (
    status === BillingDocumentStatus.DRAFT ||
    status === BillingDocumentStatus.PENDING_REVIEW
  );
}

export function canSubmitForReview(status: BillingDocumentStatus): boolean {
  return status === BillingDocumentStatus.DRAFT;
}

export function canRevertToDraft(status: BillingDocumentStatus): boolean {
  return status === BillingDocumentStatus.PENDING_REVIEW;
}

export function isImmutable(status: BillingDocumentStatus): boolean {
  return status === BillingDocumentStatus.ISSUED;
}
