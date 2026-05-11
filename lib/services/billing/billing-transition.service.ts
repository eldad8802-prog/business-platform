import {
  BillingDocument,
  BillingDocumentLine,
  BillingDocumentStatus,
  BillingDocumentType,
} from "@prisma/client";
import {
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { logAuditEvent } from "@/lib/services/audit.service";

export type SubmitBillingDraftForReviewInput = {
  businessId: number;
  actorUserId: number | null;
  billingDocumentId: number;
};

export type RevertBillingDocumentToDraftInput = {
  businessId: number;
  actorUserId: number | null;
  billingDocumentId: number;
};

function assertBusinessId(businessId: number): void {
  if (!businessId || Number.isNaN(businessId)) {
    throw new UnauthorizedError();
  }
}

export async function submitBillingDraftForReview(
  input: SubmitBillingDraftForReviewInput
): Promise<BillingDocument & { lines: BillingDocumentLine[] }> {
  assertBusinessId(input.businessId);

  const existing = await prisma.billingDocument.findFirst({
    where: {
      id: input.billingDocumentId,
      businessId: input.businessId,
      status: BillingDocumentStatus.DRAFT,
    },
    include: { lines: { orderBy: { lineIndex: "asc" } } },
  });

  if (!existing) {
    throw new ForbiddenError("Cannot submit document for review");
  }

  if (existing.documentType === BillingDocumentType.QUOTE) {
    throw new ValidationError(
      "הצעות מחיר לא נשלחות לאישור — ערכו, שתפו PDF או המירו לחשבונית"
    );
  }

  const customerName = (existing.customerNameSnapshot ?? "").trim();
  if (customerName.length === 0) {
    throw new ValidationError(
      "יש למלא שם לקוח ולשמור לפני שליחה לאישור"
    );
  }

  if (existing.lines.length === 0) {
    throw new ValidationError(
      "יש להוסיף לפחות שורת מוצר/שירות שמורה בשרת לפני שליחה לאישור"
    );
  }

  const result = await prisma.billingDocument.updateMany({
    where: {
      id: input.billingDocumentId,
      businessId: input.businessId,
      status: BillingDocumentStatus.DRAFT,
    },
    data: {
      status: BillingDocumentStatus.PENDING_REVIEW,
    },
  });

  if (result.count !== 1) {
    throw new ForbiddenError("Cannot submit document for review");
  }

  const doc = await prisma.billingDocument.findFirstOrThrow({
    where: {
      id: input.billingDocumentId,
      businessId: input.businessId,
    },
    include: { lines: { orderBy: { lineIndex: "asc" } } },
  });

  await logAuditEvent({
    businessId: input.businessId,
    eventType: "BILLING_DOC_SUBMITTED_FOR_REVIEW",
    entityType: "BILLING_DOCUMENT",
    entityId: doc.id,
    payload: {
      documentId: doc.id,
      actorUserId: input.actorUserId,
    },
  });

  return doc;
}

export async function revertBillingDocumentToDraft(
  input: RevertBillingDocumentToDraftInput
): Promise<BillingDocument & { lines: BillingDocumentLine[] }> {
  assertBusinessId(input.businessId);

  const result = await prisma.billingDocument.updateMany({
    where: {
      id: input.billingDocumentId,
      businessId: input.businessId,
      status: BillingDocumentStatus.PENDING_REVIEW,
    },
    data: {
      status: BillingDocumentStatus.DRAFT,
    },
  });

  if (result.count !== 1) {
    throw new ForbiddenError("Cannot revert document to draft");
  }

  const doc = await prisma.billingDocument.findFirstOrThrow({
    where: {
      id: input.billingDocumentId,
      businessId: input.businessId,
    },
    include: { lines: { orderBy: { lineIndex: "asc" } } },
  });

  await logAuditEvent({
    businessId: input.businessId,
    eventType: "BILLING_DOC_REVERTED_TO_DRAFT",
    entityType: "BILLING_DOCUMENT",
    entityId: doc.id,
    payload: {
      documentId: doc.id,
      actorUserId: input.actorUserId,
    },
  });

  return doc;
}
