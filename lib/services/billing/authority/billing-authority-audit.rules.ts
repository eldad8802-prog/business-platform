import type { BillingAuthorityDocumentAuditEventType } from "@/lib/services/billing/billing-audit.service";
import type {
  AuthoritySubmissionState,
  AuthorityTransitionAuditRequirement,
  AuthorityTransitionKind,
} from "@/lib/services/billing/authority/billing-authority.types";
import { BillingAuthoritySubmissionStatus } from "@prisma/client";

const TRANSITION_KIND_AUDIT: Record<
  AuthorityTransitionKind,
  AuthorityTransitionAuditRequirement
> = {
  CREATE_NOT_REQUIRED: {
    eventType: "BILLING_AUTHORITY_MARKED_NOT_REQUIRED",
    transactional: true,
    requiresProjection: false,
  },
  CREATE_READY: {
    eventType: "BILLING_AUTHORITY_READINESS_CREATED",
    transactional: true,
    requiresProjection: false,
  },
  REQUEST_VOLUNTARY_ALLOCATION: {
    eventType: "BILLING_AUTHORITY_READINESS_CREATED",
    transactional: true,
    requiresProjection: false,
  },
  ENTER_PENDING: {
    eventType: "BILLING_AUTHORITY_SUBMISSION_ATTEMPTED",
    transactional: true,
    requiresProjection: false,
  },
  SUBMIT_ATTEMPT: {
    eventType: "BILLING_AUTHORITY_SUBMISSION_ATTEMPTED",
    transactional: true,
    requiresProjection: false,
  },
  APPROVE: {
    eventType: "BILLING_AUTHORITY_APPROVED",
    transactional: true,
    requiresProjection: true,
  },
  REJECT: {
    eventType: "BILLING_AUTHORITY_REJECTED",
    transactional: true,
    requiresProjection: false,
  },
  FAIL: {
    eventType: "BILLING_AUTHORITY_FAILED",
    transactional: true,
    requiresProjection: false,
  },
  SCHEDULE_RETRY: {
    eventType: "BILLING_AUTHORITY_RETRY_SCHEDULED",
    transactional: true,
    requiresProjection: false,
  },
  REPORT_HELD_DECISION: {
    eventType: "BILLING_AUTHORITY_HELD_DECISION_REPORTED",
    transactional: true,
    requiresProjection: false,
  },
  EMERGENCY_ALLOCATE: {
    eventType: "BILLING_AUTHORITY_EMERGENCY_ALLOCATED",
    transactional: true,
    requiresProjection: true,
  },
  EMERGENCY_SYNC: {
    eventType: "BILLING_AUTHORITY_EMERGENCY_SYNCED",
    transactional: true,
    requiresProjection: false,
  },
};

export function getAuthorityTransitionAuditRequirement(
  kind: AuthorityTransitionKind
): AuthorityTransitionAuditRequirement {
  return TRANSITION_KIND_AUDIT[kind];
}

export function authorityTransitionRequiresTransactionalAudit(
  kind: AuthorityTransitionKind
): boolean {
  return getAuthorityTransitionAuditRequirement(kind).transactional;
}

export function authorityTransitionRequiresProjection(
  kind: AuthorityTransitionKind
): boolean {
  return getAuthorityTransitionAuditRequirement(kind).requiresProjection;
}

export function getRequiredAuditEventForTransition(
  kind: AuthorityTransitionKind
): BillingAuthorityDocumentAuditEventType {
  return getAuthorityTransitionAuditRequirement(kind).eventType;
}

export function resolveAuthorityTransitionKind(input: {
  from: AuthoritySubmissionState;
  to: BillingAuthoritySubmissionStatus;
  isEmergency?: boolean;
}): AuthorityTransitionKind | null {
  const { from, to, isEmergency = false } = input;

  if (from === "INITIAL" && to === BillingAuthoritySubmissionStatus.NOT_REQUIRED) {
    return "CREATE_NOT_REQUIRED";
  }
  if (from === "INITIAL" && to === BillingAuthoritySubmissionStatus.READY) {
    return "CREATE_READY";
  }
  if (
    from === BillingAuthoritySubmissionStatus.NOT_REQUIRED &&
    to === BillingAuthoritySubmissionStatus.READY
  ) {
    return "REQUEST_VOLUNTARY_ALLOCATION";
  }
  if (
    from === BillingAuthoritySubmissionStatus.READY &&
    to === BillingAuthoritySubmissionStatus.PENDING
  ) {
    return "ENTER_PENDING";
  }
  if (
    (from === BillingAuthoritySubmissionStatus.READY ||
      from === BillingAuthoritySubmissionStatus.PENDING ||
      from === BillingAuthoritySubmissionStatus.FAILED) &&
    to === BillingAuthoritySubmissionStatus.SUBMITTED
  ) {
    return "SUBMIT_ATTEMPT";
  }
  if (
    to === BillingAuthoritySubmissionStatus.APPROVED &&
    isEmergency
  ) {
    return "EMERGENCY_ALLOCATE";
  }
  if (to === BillingAuthoritySubmissionStatus.APPROVED) {
    return "APPROVE";
  }
  if (to === BillingAuthoritySubmissionStatus.REJECTED) {
    return "REJECT";
  }
  if (to === BillingAuthoritySubmissionStatus.FAILED && from === to) {
    return "SCHEDULE_RETRY";
  }
  if (to === BillingAuthoritySubmissionStatus.FAILED) {
    return "FAIL";
  }
  if (from === BillingAuthoritySubmissionStatus.SUBMITTED && from === to) {
    return "REPORT_HELD_DECISION";
  }
  if (from === to && isEmergency) {
    return "EMERGENCY_SYNC";
  }

  return null;
}
