import {
  BillingAuthoritySubmissionChannel,
  BillingAuthoritySubmissionStatus,
  BillingDocumentStatus,
  BillingDocumentType,
} from "@prisma/client";
import type { BillingAuthorityDocumentAuditEventType } from "@/lib/services/billing/billing-audit.service";

/** Pseudo-state for issue-time submission creation (no prior row). */
export type AuthoritySubmissionInitialState = "INITIAL";

export type AuthoritySubmissionState =
  | AuthoritySubmissionInitialState
  | BillingAuthoritySubmissionStatus;

export const AUTHORITY_SUBMISSION_STATUSES = [
  "NOT_REQUIRED",
  "READY",
  "PENDING",
  "SUBMITTED",
  "APPROVED",
  "REJECTED",
  "FAILED",
] as const satisfies readonly BillingAuthoritySubmissionStatus[];

export const AUTHORITY_ELIGIBLE_DOCUMENT_TYPES = [
  "TAX_INVOICE",
  "CREDIT_NOTE",
] as const satisfies readonly BillingDocumentType[];

export type AuthorityEligibleDocumentType =
  (typeof AUTHORITY_ELIGIBLE_DOCUMENT_TYPES)[number];

export type AuthorityDocumentContext = {
  businessId: number;
  status: BillingDocumentStatus;
  documentType: BillingDocumentType;
  legalSnapshotHash: string | null;
  allocationNumber: string | null;
  allocationApprovedAt: Date | null;
  isEmergencyAllocation: boolean;
};

export type AuthoritySubmissionContext = {
  businessId: number;
  billingDocumentId: number;
  status: BillingAuthoritySubmissionStatus;
  submissionChannel: BillingAuthoritySubmissionChannel;
  legalSnapshotHash: string | null;
  allocationNumber: string | null;
  isEmergencyAllocation: boolean;
  authoritySubmissionId: string | null;
  approvedAt: Date | null;
};

export type AuthorityTransitionKind =
  | "CREATE_NOT_REQUIRED"
  | "CREATE_READY"
  | "REQUEST_VOLUNTARY_ALLOCATION"
  | "ENTER_PENDING"
  | "SUBMIT_ATTEMPT"
  | "APPROVE"
  | "REJECT"
  | "FAIL"
  | "SCHEDULE_RETRY"
  | "REPORT_HELD_DECISION"
  | "EMERGENCY_ALLOCATE"
  | "EMERGENCY_SYNC";

export type ValidateAuthorityTransitionInput = {
  from: AuthoritySubmissionState;
  to: BillingAuthoritySubmissionStatus;
  kind: AuthorityTransitionKind;
  document: AuthorityDocumentContext;
  submission?: AuthoritySubmissionContext | null;
};

export type ValidateAuthorityProjectionInput = {
  submission: Pick<
    AuthoritySubmissionContext,
    | "status"
    | "allocationNumber"
    | "isEmergencyAllocation"
    | "approvedAt"
    | "businessId"
  >;
  document: Pick<
    AuthorityDocumentContext,
    | "businessId"
    | "allocationNumber"
    | "allocationApprovedAt"
    | "isEmergencyAllocation"
  >;
  proposedAllocationNumber?: string | null;
  proposedApprovedAt?: Date | null;
  proposedIsEmergencyAllocation?: boolean;
};

export type AuthorityValidationResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export type AuthorityTransitionAuditRequirement = {
  eventType: BillingAuthorityDocumentAuditEventType;
  transactional: true;
  requiresProjection: boolean;
};
