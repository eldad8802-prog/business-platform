import {
  BillingAuthoritySubmissionChannel,
  BillingAuthoritySubmissionStatus,
  BillingDocumentStatus,
  BillingDocumentType,
  CustomerTaxIdType,
  Prisma,
} from "@prisma/client";
import { ConflictError } from "@/lib/errors";
import { createBillingAuditEventTx } from "@/lib/services/billing/billing-audit.service";
import type { AuthorityTransitionKind } from "@/lib/services/billing/authority/billing-authority.types";
import {
  evaluateAuthorityReadinessAtIssue,
  type AuthorityReadinessInput,
} from "@/lib/services/billing/authority/billing-authority-readiness";
import {
  assertAuthorityTransition,
  isAuthorityEligibleDocumentType,
} from "@/lib/services/billing/authority/billing-authority.service";

export type CreateAuthoritySubmissionAtIssueInput = {
  businessId: number;
  billingDocumentId: number;
  actorUserId: number;
  documentType: BillingDocumentType;
  legalSnapshotHash: string;
  vatAmount: Prisma.Decimal;
  subtotalAmount: Prisma.Decimal;
  currency: string;
  customerTaxIdType: CustomerTaxIdType | string | null;
  customerTaxId: string | null;
  issuedAt: Date;
};

export type CreateAuthoritySubmissionAtIssueResult = {
  submissionId: number;
  status: BillingAuthoritySubmissionStatus;
  transitionKind: AuthorityTransitionKind;
  auditEventType:
    | "BILLING_AUTHORITY_READINESS_CREATED"
    | "BILLING_AUTHORITY_MARKED_NOT_REQUIRED";
};

function resolveIssueTransitionKind(
  status: BillingAuthoritySubmissionStatus
): AuthorityTransitionKind {
  return status === BillingAuthoritySubmissionStatus.NOT_REQUIRED
    ? "CREATE_NOT_REQUIRED"
    : "CREATE_READY";
}

function resolveIssueAuditEventType(
  status: BillingAuthoritySubmissionStatus
): CreateAuthoritySubmissionAtIssueResult["auditEventType"] {
  return status === BillingAuthoritySubmissionStatus.NOT_REQUIRED
    ? "BILLING_AUTHORITY_MARKED_NOT_REQUIRED"
    : "BILLING_AUTHORITY_READINESS_CREATED";
}

function auditSummaryForIssueStatus(
  status: BillingAuthoritySubmissionStatus
): string {
  if (status === BillingAuthoritySubmissionStatus.READY) {
    return "Authority readiness created for issued document";
  }
  return "Authority marked not required for issued document";
}

/**
 * Single write path: create BillingAuthoritySubmission at issue time inside the issue TX.
 * Rolls back with the parent transaction on any failure.
 */
export async function createAuthoritySubmissionForIssuedDocumentTx(
  tx: Prisma.TransactionClient,
  input: CreateAuthoritySubmissionAtIssueInput
): Promise<CreateAuthoritySubmissionAtIssueResult | null> {
  if (!isAuthorityEligibleDocumentType(input.documentType)) {
    return null;
  }

  const existing = await tx.billingAuthoritySubmission.findUnique({
    where: { billingDocumentId: input.billingDocumentId },
    select: { id: true },
  });
  if (existing) {
    throw new ConflictError(
      "AUTHORITY_SUBMISSION_EXISTS",
      "Billing authority submission already exists for this document"
    );
  }

  const readinessInput: AuthorityReadinessInput = {
    documentType: input.documentType,
    invoiceDate: input.issuedAt,
    vatAmount: input.vatAmount,
    subtotalAmount: input.subtotalAmount,
    currency: input.currency,
    customerTaxIdType: input.customerTaxIdType,
    customerTaxId: input.customerTaxId,
  };

  const initialStatus = evaluateAuthorityReadinessAtIssue(readinessInput);
  const transitionKind = resolveIssueTransitionKind(initialStatus);

  assertAuthorityTransition({
    from: "INITIAL",
    to: initialStatus,
    kind: transitionKind,
    document: {
      businessId: input.businessId,
      status: BillingDocumentStatus.ISSUED,
      documentType: input.documentType,
      legalSnapshotHash: input.legalSnapshotHash,
      allocationNumber: null,
      allocationApprovedAt: null,
      isEmergencyAllocation: false,
    },
  });

  const submission = await tx.billingAuthoritySubmission.create({
    data: {
      businessId: input.businessId,
      billingDocumentId: input.billingDocumentId,
      status: initialStatus,
      submissionChannel: BillingAuthoritySubmissionChannel.STANDARD,
      legalSnapshotHash: input.legalSnapshotHash,
      allocationNumber: null,
      isEmergencyAllocation: false,
    },
    select: { id: true, status: true },
  });

  const auditEventType = resolveIssueAuditEventType(submission.status);

  await createBillingAuditEventTx(tx, {
    businessId: input.businessId,
    billingDocumentId: input.billingDocumentId,
    actorUserId: input.actorUserId,
    eventType: auditEventType,
    summary: auditSummaryForIssueStatus(submission.status),
    metadata: {
      billingDocumentId: input.billingDocumentId,
      documentType: input.documentType,
      legalSnapshotHash: input.legalSnapshotHash,
      authorityStatus: submission.status,
      transitionKind,
      submissionId: submission.id,
      issuedAt: input.issuedAt.toISOString(),
    },
    occurredAt: input.issuedAt,
  });

  return {
    submissionId: submission.id,
    status: submission.status,
    transitionKind,
    auditEventType,
  };
}
