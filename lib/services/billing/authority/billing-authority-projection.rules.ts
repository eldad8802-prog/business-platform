import { BillingAuthoritySubmissionStatus } from "@prisma/client";
import type {
  AuthorityValidationResult,
  ValidateAuthorityProjectionInput,
} from "@/lib/services/billing/authority/billing-authority.types";

const ALLOCATION_NUMBER_MAX_LENGTH = 64;

export const AUTHORITY_PROJECTION_FIELD_NAMES = [
  "allocationNumber",
  "allocationApprovedAt",
  "isEmergencyAllocation",
] as const;

export function normalizeAllocationNumber(
  value: string | null | undefined
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function validateAllocationNumber(
  value: string | null | undefined
): AuthorityValidationResult {
  const normalized = normalizeAllocationNumber(value);
  if (normalized === null) {
    return {
      ok: false,
      code: "AUTHORITY_ALLOCATION_REQUIRED",
      message: "Allocation number is required",
    };
  }
  if (normalized.length > ALLOCATION_NUMBER_MAX_LENGTH) {
    return {
      ok: false,
      code: "AUTHORITY_ALLOCATION_TOO_LONG",
      message: `Allocation number must be at most ${ALLOCATION_NUMBER_MAX_LENGTH} characters`,
    };
  }
  if (!/^[0-9A-Za-z-]+$/.test(normalized)) {
    return {
      ok: false,
      code: "AUTHORITY_ALLOCATION_INVALID_FORMAT",
      message: "Allocation number contains invalid characters",
    };
  }
  return { ok: true };
}

export function projectionRequiredForStatus(
  status: BillingAuthoritySubmissionStatus
): boolean {
  return status === BillingAuthoritySubmissionStatus.APPROVED;
}

export function validateAuthorityProjection(
  input: ValidateAuthorityProjectionInput
): AuthorityValidationResult {
  if (input.submission.businessId !== input.document.businessId) {
    return {
      ok: false,
      code: "AUTHORITY_BUSINESS_MISMATCH",
      message: "Authority submission and billing document businessId must match",
    };
  }

  if (!projectionRequiredForStatus(input.submission.status)) {
    if (
      input.document.allocationNumber !== null ||
      input.document.allocationApprovedAt !== null
    ) {
      return {
        ok: false,
        code: "AUTHORITY_PROJECTION_UNEXPECTED",
        message:
          "Billing document projection fields must be null when submission is not APPROVED",
      };
    }
    return { ok: true };
  }

  const allocationNumber =
    input.proposedAllocationNumber ?? input.submission.allocationNumber;
  const allocationResult = validateAllocationNumber(allocationNumber);
  if (!allocationResult.ok) {
    return allocationResult;
  }
  const normalizedAllocation = normalizeAllocationNumber(allocationNumber)!;

  if (input.document.allocationNumber !== null) {
    if (input.document.allocationNumber !== normalizedAllocation) {
      return {
        ok: false,
        code: "AUTHORITY_PROJECTION_IMMUTABLE_CONFLICT",
        message:
          "Billing document allocationNumber is already set and cannot be changed",
      };
    }
    return { ok: true };
  }

  const approvedAt = input.proposedApprovedAt ?? input.submission.approvedAt;
  if (approvedAt === null || Number.isNaN(approvedAt.getTime())) {
    return {
      ok: false,
      code: "AUTHORITY_PROJECTION_APPROVED_AT_REQUIRED",
      message: "allocationApprovedAt is required when projecting an APPROVED submission",
    };
  }

  const projectedEmergency =
    input.proposedIsEmergencyAllocation ?? input.submission.isEmergencyAllocation;
  if (
    typeof projectedEmergency !== "boolean" ||
    projectedEmergency !== input.submission.isEmergencyAllocation
  ) {
    return {
      ok: false,
      code: "AUTHORITY_PROJECTION_EMERGENCY_MISMATCH",
      message:
        "Projected isEmergencyAllocation must match the approved submission value",
    };
  }

  return { ok: true };
}

export function validateAuthorityProjectionInvariants(input: {
  submissionAllocationNumber: string | null;
  documentAllocationNumber: string | null;
  submissionStatus: BillingAuthoritySubmissionStatus;
}): AuthorityValidationResult {
  const submissionAllocation = normalizeAllocationNumber(
    input.submissionAllocationNumber
  );
  const documentAllocation = normalizeAllocationNumber(
    input.documentAllocationNumber
  );

  if (input.submissionStatus === BillingAuthoritySubmissionStatus.APPROVED) {
    if (submissionAllocation === null) {
      return {
        ok: false,
        code: "I-PROJ-PRESENCE",
        message: "APPROVED submission must have allocationNumber",
      };
    }
    if (documentAllocation === null) {
      return {
        ok: false,
        code: "I-PROJ-PRESENCE",
        message: "APPROVED submission requires projected document allocationNumber",
      };
    }
    if (submissionAllocation !== documentAllocation) {
      return {
        ok: false,
        code: "I-PROJ-EQUALITY",
        message: "Submission and document allocationNumber must match",
      };
    }
    return { ok: true };
  }

  if (input.submissionStatus === BillingAuthoritySubmissionStatus.NOT_REQUIRED) {
    if (submissionAllocation !== null || documentAllocation !== null) {
      return {
        ok: false,
        code: "I-NOT-REQUIRED",
        message: "NOT_REQUIRED submissions must not have allocation numbers",
      };
    }
    return { ok: true };
  }

  if (documentAllocation !== null) {
    return {
      ok: false,
      code: "I-PROJ-ABSENCE",
      message:
        "Billing document allocationNumber must be null until submission is APPROVED",
    };
  }

  return { ok: true };
}
