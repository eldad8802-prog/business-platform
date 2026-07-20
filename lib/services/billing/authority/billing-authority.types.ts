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
  "HELD",
] as const satisfies readonly BillingAuthoritySubmissionStatus[];

/**
 * SINGLE SOURCE OF TRUTH — allocation-number requirement per document type.
 *
 * Official "Israel Invoice Model API Description" v2.0 (7/2024), Table 2.5
 * ("Types of documents"), verified against a clean copy of the official PDF
 * (see docs/compliance/tax-authority/invoice-decision-contract-evidence-v1.md
 * and israel-invoices-authority-flow-consistency-report-v1.md §1):
 *   305 Tax invoice          → Yes  (conditional on threshold / VAT / licensed dealer)
 *   320 Tax invoice/receipt  → Yes  (same conditions as 305)
 *   330 Credit tax invoice   → No
 * Every other Dubiz document type never requires an allocation number.
 *
 * "CONDITIONAL" = the reform MAY require an allocation number, subject to the
 * issue-time conditions in `evaluateAuthorityReadinessAtIssue`.
 * "NOT_REQUIRED" = never requires one.
 *
 * The map is EXHAUSTIVE over BillingDocumentType (Record<...>), so adding a new
 * document type is a compile error until it is classified here. All other
 * authority classifications (eligibility, readiness, the approval HsbSug code
 * map) must agree with this map — enforced by a consistency test.
 */
export type AuthorityAllocationRequirement = "CONDITIONAL" | "NOT_REQUIRED";

export const AUTHORITY_ALLOCATION_REQUIREMENT: Readonly<
  Record<BillingDocumentType, AuthorityAllocationRequirement>
> = {
  TAX_INVOICE: "CONDITIONAL", // 305 — Table 2.5: Yes
  TAX_INVOICE_RECEIPT: "CONDITIONAL", // 320 — Table 2.5: Yes (treated like 305)
  CREDIT_NOTE: "NOT_REQUIRED", // 330 — Table 2.5: No
  RECEIPT: "NOT_REQUIRED",
  QUOTE: "NOT_REQUIRED",
};

/**
 * Document types for which a BillingAuthoritySubmission is created at issue and
 * whose delivery is gated by the authority flow. Derived from (and kept in sync
 * with) AUTHORITY_ALLOCATION_REQUIREMENT: exactly the CONDITIONAL types.
 *
 * CREDIT_NOTE (330) was previously listed here in error — Table 2.5 confirms 330
 * does NOT require an allocation number, so it is no longer eligible; a credit
 * note is delivered without any authority gating.
 */
export const AUTHORITY_ELIGIBLE_DOCUMENT_TYPES = [
  "TAX_INVOICE",
  "TAX_INVOICE_RECEIPT",
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
  // Entering HELD: SUBMITTED → HELD when the authority withheld allocation for a
  // business reason (460/461). Distinct from REPORT_HELD_DECISION, which records
  // a user's decision being reported back to the authority (a later step).
  | "HOLD_FOR_DECISION"
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
