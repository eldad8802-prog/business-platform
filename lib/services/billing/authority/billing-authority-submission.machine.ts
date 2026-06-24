import {
  BillingAuthoritySubmissionStatus,
  BillingDocumentStatus,
} from "@prisma/client";
import type {
  AuthoritySubmissionInitialState,
  AuthoritySubmissionState,
  AuthorityValidationResult,
} from "@/lib/services/billing/authority/billing-authority.types";

export const AUTHORITY_SUBMISSION_TERMINAL_STATUSES: readonly BillingAuthoritySubmissionStatus[] =
  ["NOT_REQUIRED", "APPROVED", "REJECTED"] as const;

const INITIAL_STATE: AuthoritySubmissionInitialState = "INITIAL";

const ALLOWED_AUTHORITY_SUBMISSION_TRANSITIONS: Record<
  AuthoritySubmissionState,
  readonly BillingAuthoritySubmissionStatus[]
> = {
  INITIAL: ["NOT_REQUIRED", "READY"],
  NOT_REQUIRED: ["READY"],
  READY: ["PENDING", "SUBMITTED"],
  PENDING: ["SUBMITTED", "FAILED"],
  SUBMITTED: ["APPROVED", "REJECTED", "FAILED"],
  APPROVED: [],
  REJECTED: [],
  FAILED: ["SUBMITTED"],
};

/** Status-only transitions that emit audit without changing status. */
const AUDIT_ONLY_STATUS_PAIRS: ReadonlySet<string> = new Set([
  "FAILED:FAILED",
  "SUBMITTED:SUBMITTED",
]);

function transitionKey(
  from: AuthoritySubmissionState,
  to: BillingAuthoritySubmissionStatus
): string {
  return `${from}:${to}`;
}

export function isAuthoritySubmissionTerminalStatus(
  status: BillingAuthoritySubmissionStatus
): boolean {
  return (AUTHORITY_SUBMISSION_TERMINAL_STATUSES as readonly string[]).includes(
    status
  );
}

export function getAllowedAuthoritySubmissionTransitions(
  from: AuthoritySubmissionState
): readonly BillingAuthoritySubmissionStatus[] {
  return ALLOWED_AUTHORITY_SUBMISSION_TRANSITIONS[from] ?? [];
}

export function canTransitionAuthoritySubmission(
  from: AuthoritySubmissionState,
  to: BillingAuthoritySubmissionStatus
): boolean {
  if (from === to) {
    return AUDIT_ONLY_STATUS_PAIRS.has(transitionKey(from, to));
  }
  return getAllowedAuthoritySubmissionTransitions(from).includes(to);
}

export function isForbiddenAuthoritySubmissionTransition(
  from: AuthoritySubmissionState,
  to: BillingAuthoritySubmissionStatus
): boolean {
  if (from === to) {
    return !AUDIT_ONLY_STATUS_PAIRS.has(transitionKey(from, to));
  }
  return !canTransitionAuthoritySubmission(from, to);
}

export function authoritySubmissionCanBeApproved(
  status: BillingAuthoritySubmissionStatus
): boolean {
  return status === BillingAuthoritySubmissionStatus.SUBMITTED;
}

export function authoritySubmissionCanBeRejected(
  status: BillingAuthoritySubmissionStatus
): boolean {
  return status === BillingAuthoritySubmissionStatus.SUBMITTED;
}

export function authoritySubmissionCanBeMarkedNotRequired(
  from: AuthoritySubmissionState
): boolean {
  return from === INITIAL_STATE;
}

export function authoritySubmissionCanSubmit(
  status: BillingAuthoritySubmissionStatus
): boolean {
  return (
    status === BillingAuthoritySubmissionStatus.READY ||
    status === BillingAuthoritySubmissionStatus.PENDING ||
    status === BillingAuthoritySubmissionStatus.FAILED
  );
}

export function authoritySubmissionCanRetry(
  status: BillingAuthoritySubmissionStatus
): boolean {
  return status === BillingAuthoritySubmissionStatus.FAILED;
}

export function authoritySubmissionCanRequestVoluntaryAllocation(
  status: BillingAuthoritySubmissionStatus
): boolean {
  return status === BillingAuthoritySubmissionStatus.NOT_REQUIRED;
}

export function documentIsIssuedForAuthority(
  status: BillingDocumentStatus
): boolean {
  return status === BillingDocumentStatus.ISSUED;
}

export function checkAuthoritySubmissionTransition(
  from: AuthoritySubmissionState,
  to: BillingAuthoritySubmissionStatus
): AuthorityValidationResult {
  if (canTransitionAuthoritySubmission(from, to)) {
    return { ok: true };
  }
  return {
    ok: false,
    code: "AUTHORITY_TRANSITION_FORBIDDEN",
    message: `Authority submission transition ${from} → ${to} is not allowed`,
  };
}
