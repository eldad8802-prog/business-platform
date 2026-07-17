/**
 * Authority delivery guard — pure readiness rules for whether a billing
 * document may have its final PDF rendered / delivered.
 *
 * "ISSUED" is NOT sufficient. When a document requires a tax-authority
 * allocation, the final PDF / delivery is allowed only once the allocation is
 * actually granted (submission APPROVED + allocation number projected onto the
 * document). Everything else is fail-closed.
 *
 * No I/O, no DB, no network — the caller loads the minimal fields and passes
 * them in. The blocked `reason` is an INTERNAL code (safe to log); it must never
 * expose the authority's own error message or any sensitive data.
 */

import {
  BillingAuthorityDecisionType,
  BillingAuthoritySubmissionStatus,
  BillingDocumentType,
} from "@prisma/client";
import { isAuthorityEligibleDocumentType } from "@/lib/services/billing/authority/billing-authority.service";

export type AuthorityDeliverabilityInput = {
  documentType: BillingDocumentType;
  /** `null` when no BillingAuthoritySubmission row exists for the document. */
  submissionStatus: BillingAuthoritySubmissionStatus | null;
  /**
   * Loaded for the read model and forward-compatibility. NOT used to grant
   * delivery in this layer yet: PROCEED_WITHOUT_ALLOCATION delivery arrives with
   * the Decision API (a future PR), so a held decision never unblocks here.
   */
  heldDecisionType: BillingAuthorityDecisionType | null;
  heldDecisionReportedAt: Date | null;
  /** Allocation number projected onto BillingDocument on APPROVED. */
  documentAllocationNumber: string | null;
};

export type AuthorityDeliverableReason =
  | "NOT_RELEVANT"
  | "NOT_REQUIRED"
  | "APPROVED_WITH_ALLOCATION";

export type AuthorityBlockedReason =
  | "AUTHORITY_SUBMISSION_MISSING"
  | "AUTHORITY_ALLOCATION_MISSING"
  | "AUTHORITY_NOT_DELIVERABLE_READY"
  | "AUTHORITY_NOT_DELIVERABLE_SUBMITTED"
  | "AUTHORITY_NOT_DELIVERABLE_FAILED"
  | "AUTHORITY_NOT_DELIVERABLE_HELD"
  | "AUTHORITY_NOT_DELIVERABLE_REJECTED"
  | "AUTHORITY_STATE_UNKNOWN";

export type AuthorityDeliverabilityResult =
  | { deliverable: true; reason: AuthorityDeliverableReason }
  | { deliverable: false; reason: AuthorityBlockedReason };

function hasAllocation(value: string | null): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Decides whether the final PDF / delivery is permitted. Fail-closed: anything
 * that is not provably deliverable is blocked.
 */
export function evaluateAuthorityDeliverability(
  input: AuthorityDeliverabilityInput
): AuthorityDeliverabilityResult {
  // No submission row.
  if (input.submissionStatus === null) {
    // Eligible document type with no submission → fail closed (an eligible
    // invoice must always have a submission after issue).
    return isAuthorityEligibleDocumentType(input.documentType)
      ? { deliverable: false, reason: "AUTHORITY_SUBMISSION_MISSING" }
      : { deliverable: true, reason: "NOT_RELEVANT" };
  }

  switch (input.submissionStatus) {
    case BillingAuthoritySubmissionStatus.NOT_REQUIRED:
      return { deliverable: true, reason: "NOT_REQUIRED" };
    case BillingAuthoritySubmissionStatus.APPROVED:
      return hasAllocation(input.documentAllocationNumber)
        ? { deliverable: true, reason: "APPROVED_WITH_ALLOCATION" }
        : { deliverable: false, reason: "AUTHORITY_ALLOCATION_MISSING" };
    case BillingAuthoritySubmissionStatus.READY:
      return { deliverable: false, reason: "AUTHORITY_NOT_DELIVERABLE_READY" };
    case BillingAuthoritySubmissionStatus.PENDING:
    case BillingAuthoritySubmissionStatus.SUBMITTED:
      return { deliverable: false, reason: "AUTHORITY_NOT_DELIVERABLE_SUBMITTED" };
    case BillingAuthoritySubmissionStatus.FAILED:
      return { deliverable: false, reason: "AUTHORITY_NOT_DELIVERABLE_FAILED" };
    case BillingAuthoritySubmissionStatus.HELD:
      return { deliverable: false, reason: "AUTHORITY_NOT_DELIVERABLE_HELD" };
    case BillingAuthoritySubmissionStatus.REJECTED:
      return { deliverable: false, reason: "AUTHORITY_NOT_DELIVERABLE_REJECTED" };
    default:
      // Unknown / future state — fail closed.
      return { deliverable: false, reason: "AUTHORITY_STATE_UNKNOWN" };
  }
}

/** Public, filtered error code surfaced when delivery is blocked. */
export const AUTHORITY_NOT_DELIVERABLE_CODE =
  "BILLING_AUTHORITY_DOCUMENT_NOT_DELIVERABLE" as const;
