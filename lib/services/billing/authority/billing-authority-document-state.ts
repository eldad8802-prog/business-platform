/**
 * The allocation state of ONE document, as the document screen needs it after a
 * reload: what is stored for its authority submission, and whether its final PDF
 * may be delivered — decided by the SAME delivery rule the PDF route enforces
 * (evaluateAuthorityDeliverability), so the screen can never call a document
 * "ready to share" while the PDF route refuses it.
 *
 * Read-only and pure. No authority call, no write, no token, no payload. The
 * values are internal codes; wording belongs to lib/billing.
 */
import {
  BillingDocumentStatus,
  type BillingAuthorityDecisionType,
  type BillingAuthoritySubmissionStatus,
  type BillingDocumentType,
} from "@prisma/client";
import { evaluateAuthorityDeliverability } from "@/lib/services/billing/authority/billing-authority-delivery.rules";
import {
  isAuthorityNotSentErrorCode,
  isAuthorityOutcomeUncertainErrorCode,
} from "@/lib/services/billing/authority/billing-authority-send-certainty";
import { deriveAllocationNumber } from "@/lib/services/billing/billing-allocation-number";

/** Serializable — the shape the document API returns as `authorityState`. */
export type AuthorityDocumentState = {
  /** Stored submission status, or null when the document has no submission. */
  submissionStatus: BillingAuthoritySubmissionStatus | null;
  /** The delivery rule's verdict for the final PDF. */
  deliverable: boolean;
  /** The delivery rule's reason code (deliverable or blocked). */
  reason: string;
  /** SUBMITTED with an uncertain marker: it may have reached the authority; never re-sent. */
  outcomeUncertain: boolean;
  /** FAILED with a provably-not-sent code. */
  failedNotSent: boolean;
  /** HELD decision recorded and reported (e.g. PROCEED_WITHOUT_ALLOCATION). */
  heldDecisionType: BillingAuthorityDecisionType | null;
  heldDecisionReported: boolean;
  /** The 9 right-most digits, only when a number is stored. */
  allocationNumber: string | null;
};

export type AuthorityDocumentStateInput = {
  documentStatus: BillingDocumentStatus;
  documentType: BillingDocumentType;
  allocationNumber: string | null;
  submission: {
    status: BillingAuthoritySubmissionStatus;
    errorCode: string | null;
    heldDecisionType: BillingAuthorityDecisionType | null;
    heldDecisionReportedAt: Date | null;
  } | null;
};

/** null for a document that is not issued — there is nothing to deliver yet. */
export function buildAuthorityDocumentState(
  input: AuthorityDocumentStateInput
): AuthorityDocumentState | null {
  if (input.documentStatus !== BillingDocumentStatus.ISSUED) return null;

  const submission = input.submission;
  const verdict = evaluateAuthorityDeliverability({
    documentType: input.documentType,
    submissionStatus: submission?.status ?? null,
    heldDecisionType: submission?.heldDecisionType ?? null,
    heldDecisionReportedAt: submission?.heldDecisionReportedAt ?? null,
    documentAllocationNumber: input.allocationNumber,
  });

  return {
    submissionStatus: submission?.status ?? null,
    deliverable: verdict.deliverable,
    reason: verdict.reason,
    outcomeUncertain:
      submission?.status === "SUBMITTED" && isAuthorityOutcomeUncertainErrorCode(submission.errorCode),
    failedNotSent: submission?.status === "FAILED" && isAuthorityNotSentErrorCode(submission.errorCode),
    heldDecisionType: submission?.heldDecisionType ?? null,
    heldDecisionReported: submission?.heldDecisionReportedAt != null,
    allocationNumber: deriveAllocationNumber(input.allocationNumber),
  };
}
