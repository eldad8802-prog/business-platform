import {
  BillingAuthoritySubmissionStatus,
  BillingDocumentStatus,
  BillingDocumentType,
} from "@prisma/client";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type {
  AuthorityEligibleDocumentType,
  AuthoritySubmissionState,
  AuthorityValidationResult,
  ValidateAuthorityProjectionInput,
  ValidateAuthorityTransitionInput,
} from "@/lib/services/billing/authority/billing-authority.types";
import {
  AUTHORITY_ELIGIBLE_DOCUMENT_TYPES,
  AUTHORITY_SUBMISSION_STATUSES,
} from "@/lib/services/billing/authority/billing-authority.types";
import {
  authorityTransitionRequiresProjection,
  getRequiredAuditEventForTransition,
  resolveAuthorityTransitionKind,
} from "@/lib/services/billing/authority/billing-authority-audit.rules";
import {
  normalizeAllocationNumber,
  validateAllocationNumber,
  validateAuthorityProjection,
  validateAuthorityProjectionInvariants,
} from "@/lib/services/billing/authority/billing-authority-projection.rules";
import {
  authoritySubmissionCanBeApproved,
  authoritySubmissionCanBeMarkedNotRequired,
  authoritySubmissionCanBeRejected,
  authoritySubmissionCanRequestVoluntaryAllocation,
  authoritySubmissionCanRetry,
  authoritySubmissionCanSubmit,
  canTransitionAuthoritySubmission,
  checkAuthoritySubmissionTransition,
  documentIsIssuedForAuthority,
  getAllowedAuthoritySubmissionTransitions,
  isAuthoritySubmissionTerminalStatus,
  isForbiddenAuthoritySubmissionTransition,
} from "@/lib/services/billing/authority/billing-authority-submission.machine";

export {
  AUTHORITY_ELIGIBLE_DOCUMENT_TYPES,
  AUTHORITY_SUBMISSION_STATUSES,
} from "@/lib/services/billing/authority/billing-authority.types";
export { AUTHORITY_PROJECTION_FIELD_NAMES } from "@/lib/services/billing/authority/billing-authority-projection.rules";
export { AUTHORITY_SUBMISSION_TERMINAL_STATUSES } from "@/lib/services/billing/authority/billing-authority-submission.machine";

export type {
  AuthorityDocumentContext,
  AuthoritySubmissionContext,
  AuthoritySubmissionState,
  AuthorityTransitionAuditRequirement,
  AuthorityTransitionKind,
  AuthorityValidationResult,
  ValidateAuthorityProjectionInput,
  ValidateAuthorityTransitionInput,
} from "@/lib/services/billing/authority/billing-authority.types";

export {
  authoritySubmissionCanBeApproved,
  authoritySubmissionCanBeMarkedNotRequired,
  authoritySubmissionCanBeRejected,
  authoritySubmissionCanRequestVoluntaryAllocation,
  authoritySubmissionCanRetry,
  authoritySubmissionCanSubmit,
  canTransitionAuthoritySubmission,
  checkAuthoritySubmissionTransition,
  documentIsIssuedForAuthority,
  getAllowedAuthoritySubmissionTransitions,
  isAuthoritySubmissionTerminalStatus,
  isForbiddenAuthoritySubmissionTransition,
} from "@/lib/services/billing/authority/billing-authority-submission.machine";

export {
  authorityTransitionRequiresProjection,
  authorityTransitionRequiresTransactionalAudit,
  getAuthorityTransitionAuditRequirement,
  getRequiredAuditEventForTransition,
  resolveAuthorityTransitionKind,
} from "@/lib/services/billing/authority/billing-authority-audit.rules";

export {
  normalizeAllocationNumber,
  projectionRequiredForStatus,
  validateAllocationNumber,
  validateAuthorityProjection,
  validateAuthorityProjectionInvariants,
} from "@/lib/services/billing/authority/billing-authority-projection.rules";

function firstValidationFailure(
  ...results: AuthorityValidationResult[]
): AuthorityValidationResult | null {
  for (const result of results) {
    if (!result.ok) {
      return result;
    }
  }
  return null;
}

function assertValidationResult(
  result: AuthorityValidationResult,
  useForbidden = false
): void {
  if (!result.ok) {
    if (useForbidden) {
      throw new ForbiddenError(result.message, result.code);
    }
    throw new ValidationError(result.message);
  }
}

export function isAuthorityEligibleDocumentType(
  documentType: BillingDocumentType
): documentType is AuthorityEligibleDocumentType {
  return (AUTHORITY_ELIGIBLE_DOCUMENT_TYPES as readonly string[]).includes(
    documentType
  );
}

export function checkDocumentEligibleForAuthority(input: {
  status: BillingDocumentStatus;
  documentType: BillingDocumentType;
}): AuthorityValidationResult {
  if (!documentIsIssuedForAuthority(input.status)) {
    return {
      ok: false,
      code: "AUTHORITY_DOCUMENT_NOT_ISSUED",
      message: "Authority handling requires an issued billing document",
    };
  }
  if (!isAuthorityEligibleDocumentType(input.documentType)) {
    return {
      ok: false,
      code: "AUTHORITY_DOCUMENT_TYPE_INELIGIBLE",
      message: "Authority handling is not supported for this document type",
    };
  }
  return { ok: true };
}

export function checkAuthorityBusinessScope(input: {
  documentBusinessId: number;
  submissionBusinessId: number;
}): AuthorityValidationResult {
  if (input.documentBusinessId !== input.submissionBusinessId) {
    return {
      ok: false,
      code: "AUTHORITY_BUSINESS_MISMATCH",
      message: "Authority submission must belong to the same business as the document",
    };
  }
  return { ok: true };
}

export function checkAuthorityLegalSnapshotBinding(input: {
  documentLegalSnapshotHash: string | null;
  submissionLegalSnapshotHash: string | null;
}): AuthorityValidationResult {
  if (
    !input.documentLegalSnapshotHash ||
    !input.submissionLegalSnapshotHash
  ) {
    return {
      ok: false,
      code: "AUTHORITY_LEGAL_SNAPSHOT_HASH_MISSING",
      message: "Authority submission requires a bound legalSnapshotHash",
    };
  }
  if (
    input.documentLegalSnapshotHash !== input.submissionLegalSnapshotHash
  ) {
    return {
      ok: false,
      code: "AUTHORITY_LEGAL_SNAPSHOT_HASH_MISMATCH",
      message: "Authority submission legalSnapshotHash must match the issued document",
    };
  }
  return { ok: true };
}

export function checkAuthorityTransitionKind(
  input: ValidateAuthorityTransitionInput
): AuthorityValidationResult {
  const resolved = resolveAuthorityTransitionKind({
    from: input.from,
    to: input.to,
    isEmergency: input.submission?.submissionChannel === "EMERGENCY",
  });
  if (resolved === null || resolved !== input.kind) {
    return {
      ok: false,
      code: "AUTHORITY_TRANSITION_KIND_MISMATCH",
      message: `Transition kind ${input.kind} does not match ${input.from} → ${input.to}`,
    };
  }
  return { ok: true };
}

export function validateAuthorityTransition(
  input: ValidateAuthorityTransitionInput
): AuthorityValidationResult {
  const baseFailure = firstValidationFailure(
    checkDocumentEligibleForAuthority(input.document),
    checkAuthoritySubmissionTransition(input.from, input.to),
    checkAuthorityTransitionKind(input)
  );
  if (baseFailure) {
    return baseFailure;
  }

  if (input.from !== "INITIAL" && input.submission) {
    const scopeFailure = firstValidationFailure(
      checkAuthorityBusinessScope({
        documentBusinessId: input.document.businessId,
        submissionBusinessId: input.submission.businessId,
      }),
      checkAuthorityLegalSnapshotBinding({
        documentLegalSnapshotHash: input.document.legalSnapshotHash,
        submissionLegalSnapshotHash: input.submission.legalSnapshotHash,
      })
    );
    if (scopeFailure) {
      return scopeFailure;
    }
  }

  switch (input.kind) {
    case "CREATE_NOT_REQUIRED":
      if (!authoritySubmissionCanBeMarkedNotRequired(input.from)) {
        return {
          ok: false,
          code: "AUTHORITY_NOT_REQUIRED_FORBIDDEN",
          message: "NOT_REQUIRED can only be set at issue-time creation",
        };
      }
      break;
    case "REQUEST_VOLUNTARY_ALLOCATION":
      if (
        input.from !== BillingAuthoritySubmissionStatus.NOT_REQUIRED ||
        !authoritySubmissionCanRequestVoluntaryAllocation(input.from)
      ) {
        return {
          ok: false,
          code: "AUTHORITY_VOLUNTARY_FORBIDDEN",
          message: "Voluntary allocation is only allowed from NOT_REQUIRED",
        };
      }
      break;
    case "SUBMIT_ATTEMPT":
      if (
        input.from !== "INITIAL" &&
        !authoritySubmissionCanSubmit(input.from)
      ) {
        return {
          ok: false,
          code: "AUTHORITY_SUBMIT_FORBIDDEN",
          message: "Submission attempt is not allowed from the current status",
        };
      }
      break;
    case "APPROVE":
    case "EMERGENCY_ALLOCATE":
      if (
        input.from !== BillingAuthoritySubmissionStatus.SUBMITTED ||
        !authoritySubmissionCanBeApproved(input.from)
      ) {
        return {
          ok: false,
          code: "AUTHORITY_APPROVE_FORBIDDEN",
          message: "Approval is only allowed from SUBMITTED",
        };
      }
      break;
    case "REJECT":
      if (
        input.from !== BillingAuthoritySubmissionStatus.SUBMITTED ||
        !authoritySubmissionCanBeRejected(input.from)
      ) {
        return {
          ok: false,
          code: "AUTHORITY_REJECT_FORBIDDEN",
          message: "Rejection is only allowed from SUBMITTED",
        };
      }
      break;
    case "HOLD_FOR_DECISION":
      if (input.from !== BillingAuthoritySubmissionStatus.SUBMITTED) {
        return {
          ok: false,
          code: "AUTHORITY_HOLD_FORBIDDEN",
          message: "Hold-for-decision is only allowed from SUBMITTED",
        };
      }
      break;
    case "SCHEDULE_RETRY":
      if (
        input.from !== BillingAuthoritySubmissionStatus.FAILED ||
        !authoritySubmissionCanRetry(input.from)
      ) {
        return {
          ok: false,
          code: "AUTHORITY_RETRY_FORBIDDEN",
          message: "Retry scheduling is only allowed from FAILED",
        };
      }
      break;
    default:
      break;
  }

  if (isAuthoritySubmissionTerminalStatus(input.from as BillingAuthoritySubmissionStatus)) {
    if (input.from !== input.to && input.from !== BillingAuthoritySubmissionStatus.NOT_REQUIRED) {
      return {
        ok: false,
        code: "AUTHORITY_TERMINAL_STATUS",
        message: `Authority submission in terminal status ${input.from} cannot transition`,
      };
    }
  }

  if (authorityTransitionRequiresProjection(input.kind) && input.submission) {
    const projectionResult = validateAuthorityProjection({
      submission: {
        businessId: input.submission.businessId,
        status: input.to,
        allocationNumber: input.submission.allocationNumber,
        isEmergencyAllocation: input.submission.isEmergencyAllocation,
        approvedAt: input.submission.approvedAt,
      },
      document: {
        businessId: input.document.businessId,
        allocationNumber: input.document.allocationNumber,
        allocationApprovedAt: input.document.allocationApprovedAt,
        isEmergencyAllocation: input.document.isEmergencyAllocation,
      },
      proposedAllocationNumber: input.submission.allocationNumber,
      proposedApprovedAt: input.submission.approvedAt,
      proposedIsEmergencyAllocation: input.submission.isEmergencyAllocation,
    });
    if (!projectionResult.ok) {
      return projectionResult;
    }
  }

  return { ok: true };
}

export function assertAuthorityTransition(
  input: ValidateAuthorityTransitionInput
): void {
  const result = validateAuthorityTransition(input);
  assertValidationResult(result, true);
}

export function assertAuthorityProjection(
  input: ValidateAuthorityProjectionInput
): void {
  const result = validateAuthorityProjection(input);
  assertValidationResult(result, true);
}

export function getAuthorityTransitionPlan(input: {
  from: AuthoritySubmissionState;
  to: BillingAuthoritySubmissionStatus;
  kind: ValidateAuthorityTransitionInput["kind"];
  isEmergency?: boolean;
}): {
  allowed: boolean;
  auditEventType: ReturnType<typeof getRequiredAuditEventForTransition>;
  requiresProjection: boolean;
} {
  const allowed = canTransitionAuthoritySubmission(input.from, input.to);
  return {
    allowed,
    auditEventType: getRequiredAuditEventForTransition(input.kind),
    requiresProjection: authorityTransitionRequiresProjection(input.kind),
  };
}
