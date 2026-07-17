/**
 * Maps the Submission Execution Service result to a business-facing authority
 * outcome returned from the issue flow. Pure — no I/O.
 *
 * Deliberately free of HTTP status codes: callers (route / UI) see business
 * statuses only. PDF/delivery permission is NOT derived from this outcome — it
 * is enforced separately by the delivery guard against live DB state.
 */

import type {
  ExecutionResult,
  SafeToRetry,
} from "@/lib/services/billing/authority/billing-authority-submission-execution.service";

export type AuthorityIssueStatus =
  | "not_required"
  | "approved"
  | "decision_required"
  | "decision_already_reported"
  | "validation_failed"
  | "authentication_failed"
  | "infrastructure_failed"
  | "ambiguous"
  | "in_progress"
  | "execution_error";

export type AuthorityIssueOutcome = {
  status: AuthorityIssueStatus;
  submissionId?: number;
  allocationNumber?: string;
  userActionRequired?: boolean;
  safeToRetry?: SafeToRetry;
  /** Internal, filtered code (never the authority's raw message). */
  errorCode?: string;
  /** Authority business-decision code (460/461/462) — NOT an HTTP status. */
  code?: number;
};

/** Outcome for a document that never needed an allocation (no submission / NOT_REQUIRED). */
export const AUTHORITY_ISSUE_NOT_REQUIRED: AuthorityIssueOutcome = {
  status: "not_required",
};

export function mapExecutionResultToAuthorityOutcome(
  result: ExecutionResult
): AuthorityIssueOutcome {
  switch (result.outcome) {
    case "completed_approved":
      return {
        status: "approved",
        submissionId: result.submissionId,
        allocationNumber: result.allocationNumber,
        safeToRetry: false,
      };
    case "completed_rejected":
      return {
        status: "validation_failed",
        submissionId: result.submissionId,
        errorCode: result.errorCode,
        safeToRetry: false,
      };
    case "decision_required":
      return {
        status: "decision_required",
        submissionId: result.submissionId,
        code: result.code,
        errorCode: result.errorCode,
        userActionRequired: true,
        safeToRetry: false,
      };
    case "decision_already_reported":
      return {
        status: "decision_already_reported",
        submissionId: result.submissionId,
        code: result.code,
        errorCode: result.errorCode,
        safeToRetry: false,
      };
    case "authentication_failed":
      return {
        status: "authentication_failed",
        submissionId: result.submissionId,
        errorCode: result.errorCode,
        safeToRetry: true,
      };
    case "infrastructure_failed":
      return {
        status: "infrastructure_failed",
        submissionId: result.submissionId,
        errorCode: result.errorCode,
        safeToRetry: result.safeToRetry,
      };
    case "ambiguous_result":
      return {
        status: "ambiguous",
        submissionId: result.submissionId,
        errorCode: result.errorCode,
        safeToRetry: result.safeToRetry,
      };
    case "in_progress":
      return {
        status: "in_progress",
        submissionId: result.submissionId,
        safeToRetry: false,
      };
    case "already_processed":
      // Concurrency: another path already advanced the submission. Report
      // in-progress; delivery permission is decided separately by the guard.
      return {
        status: "in_progress",
        submissionId: result.submissionId,
        safeToRetry: false,
      };
    case "preflight_failed":
      return {
        status: "infrastructure_failed",
        submissionId: result.submissionId,
        errorCode: result.errorCode,
        safeToRetry: result.safeToRetry,
      };
    case "local_validation_failed":
      return {
        status: "validation_failed",
        submissionId: result.submissionId,
        errorCode: result.errorCode,
        safeToRetry: result.safeToRetry,
      };
    default: {
      const _never: never = result;
      return _never;
    }
  }
}
