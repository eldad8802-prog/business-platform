import {
  BillingAuthoritySubmissionChannel,
  BillingAuthoritySubmissionStatus,
  BillingDocumentStatus,
  BillingPdfRenderStatus,
  Prisma,
} from "@prisma/client";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { createBillingAuditEventTx } from "@/lib/services/billing/billing-audit.service";
import {
  getRequiredAuditEventForTransition,
  resolveAuthorityTransitionKind,
} from "@/lib/services/billing/authority/billing-authority-audit.rules";
import { normalizeAllocationNumber } from "@/lib/services/billing/authority/billing-authority-projection.rules";
import type {
  AuthorityDocumentContext,
  AuthoritySubmissionContext,
  AuthorityTransitionKind,
} from "@/lib/services/billing/authority/billing-authority.types";
import { assertAuthorityTransition } from "@/lib/services/billing/authority/billing-authority.service";

const SUBMISSION_SELECT = {
  id: true,
  businessId: true,
  billingDocumentId: true,
  status: true,
  submissionChannel: true,
  legalSnapshotHash: true,
  allocationNumber: true,
  isEmergencyAllocation: true,
  authoritySubmissionId: true,
  authorityPayloadHash: true,
  authorityResponseHash: true,
  submittedAt: true,
  approvedAt: true,
  rejectedAt: true,
  lastAttemptAt: true,
  errorCode: true,
  errorMessage: true,
  retryCount: true,
  createdAt: true,
  updatedAt: true,
} as const;

const DOCUMENT_SELECT = {
  businessId: true,
  status: true,
  documentType: true,
  legalSnapshotHash: true,
  allocationNumber: true,
  allocationApprovedAt: true,
  isEmergencyAllocation: true,
} as const;

export type AuthoritySubmissionRow = Prisma.BillingAuthoritySubmissionGetPayload<{
  select: typeof SUBMISSION_SELECT;
}>;

type AuthorityDocumentRow = Prisma.BillingDocumentGetPayload<{
  select: typeof DOCUMENT_SELECT;
}>;

export type AuthorityApprovalOutcome = "APPLIED" | "NOOP" | "REPAIRED";

export type AuthorityRejectFailOutcome = "APPLIED" | "NOOP";

export type AuthorityScheduleRetryOutcome = "APPLIED" | "NOOP";

export type ExecuteAuthorityTransitionTxInput = {
  businessId: number;
  billingDocumentId: number;
  kind: AuthorityTransitionKind;
  to: BillingAuthoritySubmissionStatus;
  actorUserId?: number | null;
  occurredAt?: Date;
  summary: string;
  metadata?: Record<string, unknown>;
  submissionUpdate: Prisma.BillingAuthoritySubmissionUpdateInput;
  /** Used for transition/projection validation instead of the current DB row. */
  validationSubmission?: AuthoritySubmissionContext;
  /** Applied after submission update, before audit. */
  documentProjectionUpdate?: Prisma.BillingDocumentUpdateInput;
  /** Submission update only succeeds when the row is still in this status. */
  requireCurrentStatus?: BillingAuthoritySubmissionStatus;
  skipAudit?: boolean;
  /** Audit-only transitions (e.g. FAILED → FAILED) — no submission or projection writes. */
  skipSubmissionUpdate?: boolean;
};

export type ExecuteAuthorityTransitionTxResult = {
  submission: AuthoritySubmissionRow;
  fromStatus: BillingAuthoritySubmissionStatus;
  toStatus: BillingAuthoritySubmissionStatus;
  transitionKind: AuthorityTransitionKind;
  auditEventType: ReturnType<typeof getRequiredAuditEventForTransition>;
  auditWritten: boolean;
  documentProjectionWritten: boolean;
};

export type RecordAuthoritySubmissionAttemptInput = {
  businessId: number;
  billingDocumentId: number;
  actorUserId?: number | null;
  authorityPayloadHash?: string | null;
  authoritySubmissionId?: string | null;
  authorityResponseHash?: string | null;
  occurredAt?: Date;
};

export type RecordAuthorityApprovedTxInput = {
  businessId: number;
  billingDocumentId: number;
  allocationNumber: string;
  approvedAt: Date;
  isEmergencyAllocation?: boolean;
  authorityResponseHash?: string | null;
  authoritySubmissionId?: string | null;
  actorUserId?: number | null;
  occurredAt?: Date;
};

export type RecordAuthorityApprovedTxResult = {
  outcome: AuthorityApprovalOutcome;
  submission: AuthoritySubmissionRow;
  fromStatus: BillingAuthoritySubmissionStatus;
  toStatus: BillingAuthoritySubmissionStatus;
  transitionKind: AuthorityTransitionKind | null;
  auditWritten: boolean;
  documentProjectionWritten: boolean;
};

export type RecordAuthorityRejectedTxInput = {
  businessId: number;
  billingDocumentId: number;
  rejectedAt: Date;
  errorCode: string;
  errorMessage: string;
  authorityResponseHash?: string | null;
  actorUserId?: number | null;
  occurredAt?: Date;
};

export type RecordAuthorityRejectedTxResult = {
  outcome: AuthorityRejectFailOutcome;
  submission: AuthoritySubmissionRow;
  fromStatus: BillingAuthoritySubmissionStatus;
  toStatus: BillingAuthoritySubmissionStatus;
  transitionKind: AuthorityTransitionKind | null;
  auditWritten: boolean;
};

export type RecordAuthorityFailedTxInput = {
  businessId: number;
  billingDocumentId: number;
  lastAttemptAt: Date;
  errorCode: string;
  errorMessage: string;
  authorityResponseHash?: string | null;
  actorUserId?: number | null;
  occurredAt?: Date;
};

export type RecordAuthorityFailedTxResult = {
  outcome: AuthorityRejectFailOutcome;
  submission: AuthoritySubmissionRow;
  fromStatus: BillingAuthoritySubmissionStatus;
  toStatus: BillingAuthoritySubmissionStatus;
  transitionKind: AuthorityTransitionKind | null;
  auditWritten: boolean;
};

/** Authority approval codes that put a submission into HELD (business reason). */
export const AUTHORITY_HELD_CODES = [460, 461] as const;
export type AuthorityHeldCode = (typeof AUTHORITY_HELD_CODES)[number];

/**
 * Canonical form the persistence layer stores in `errorCode` for a held
 * submission. Single source of truth — the execution service reuses this so the
 * ExecutionResult code and the persisted code never diverge.
 */
export function buildAuthorityHeldErrorCode(code: number): string {
  return `AUTHORITY_DECISION_REQUIRED_${code}`;
}

export type RecordAuthorityHeldTxInput = {
  businessId: number;
  billingDocumentId: number;
  heldAt: Date;
  /** Authority business-decision code (460 | 461). */
  authorityCode: number;
  /** Sanitized summary only — NO authority PII / tokens. Stored as errorMessage. */
  message: string;
  authorityResponseHash?: string | null;
  actorUserId?: number | null;
  occurredAt?: Date;
};

export type RecordAuthorityHeldTxResult = {
  outcome: AuthorityRejectFailOutcome;
  submission: AuthoritySubmissionRow;
  fromStatus: BillingAuthoritySubmissionStatus;
  toStatus: BillingAuthoritySubmissionStatus;
  transitionKind: AuthorityTransitionKind | null;
  auditWritten: boolean;
};

export type RecordAuthorityScheduleRetryTxInput = {
  businessId: number;
  billingDocumentId: number;
  scheduledAt: Date;
  nextRetryAt?: Date | null;
  actorUserId?: number | null;
  occurredAt?: Date;
};

export type RecordAuthorityScheduleRetryTxResult = {
  outcome: AuthorityScheduleRetryOutcome;
  submission: AuthoritySubmissionRow;
  fromStatus: BillingAuthoritySubmissionStatus;
  toStatus: BillingAuthoritySubmissionStatus;
  transitionKind: AuthorityTransitionKind | null;
  auditWritten: boolean;
};

export class AuthorityConditionalUpdateMissedError extends Error {
  readonly code = "AUTHORITY_CONDITIONAL_UPDATE_MISSED";

  constructor() {
    super("Authority submission status changed before conditional update");
    this.name = "AuthorityConditionalUpdateMissedError";
  }
}

type CanonicalApprovalFacts = {
  allocationNumber: string;
  approvedAt: Date;
  isEmergencyAllocation: boolean;
  authorityResponseHash: string | null;
  authoritySubmissionId: string | null;
};

type CanonicalRejectionFacts = {
  rejectedAt: Date;
  errorCode: string;
  authorityResponseHash: string | null;
};

type CanonicalFailureFacts = {
  lastAttemptAt: Date;
  errorCode: string;
  authorityResponseHash: string | null;
};

type CanonicalScheduleRetryFacts = {
  scheduledAt: Date;
  nextRetryAt: Date | null;
};

type CanonicalHeldFacts = {
  errorCode: string;
  errorMessage: string;
  authorityResponseHash: string | null;
};

function toSubmissionContext(
  submission: AuthoritySubmissionRow
): AuthoritySubmissionContext {
  return {
    businessId: submission.businessId,
    billingDocumentId: submission.billingDocumentId,
    status: submission.status,
    submissionChannel: submission.submissionChannel,
    legalSnapshotHash: submission.legalSnapshotHash,
    allocationNumber: submission.allocationNumber,
    isEmergencyAllocation: submission.isEmergencyAllocation,
    authoritySubmissionId: submission.authoritySubmissionId,
    approvedAt: submission.approvedAt,
  };
}

function toDocumentContext(document: AuthorityDocumentRow): AuthorityDocumentContext {
  return {
    businessId: document.businessId,
    status: document.status,
    documentType: document.documentType,
    legalSnapshotHash: document.legalSnapshotHash,
    allocationNumber: document.allocationNumber,
    allocationApprovedAt: document.allocationApprovedAt,
    isEmergencyAllocation: document.isEmergencyAllocation,
  };
}

function normalizeApprovedAt(approvedAt: Date): Date {
  if (!(approvedAt instanceof Date) || Number.isNaN(approvedAt.getTime())) {
    throw new ValidationError("approvedAt must be a valid Date");
  }
  return approvedAt;
}

function normalizeAuthorityTimestamp(value: Date, fieldName: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ValidationError(`${fieldName} must be a valid Date`);
  }
  return value;
}

function normalizeErrorCode(errorCode: string): string {
  const trimmed = errorCode.trim();
  if (trimmed.length === 0) {
    throw new ValidationError("errorCode is required");
  }
  return trimmed;
}

function normalizeErrorMessage(errorMessage: string): string {
  const trimmed = errorMessage.trim();
  if (trimmed.length === 0) {
    throw new ValidationError("errorMessage is required");
  }
  return trimmed;
}

function normalizeCanonicalRejectionFacts(
  input: RecordAuthorityRejectedTxInput
): CanonicalRejectionFacts {
  return {
    rejectedAt: normalizeAuthorityTimestamp(input.rejectedAt, "rejectedAt"),
    errorCode: normalizeErrorCode(input.errorCode),
    authorityResponseHash: input.authorityResponseHash ?? null,
  };
}

function normalizeCanonicalFailureFacts(
  input: RecordAuthorityFailedTxInput
): CanonicalFailureFacts {
  return {
    lastAttemptAt: normalizeAuthorityTimestamp(input.lastAttemptAt, "lastAttemptAt"),
    errorCode: normalizeErrorCode(input.errorCode),
    authorityResponseHash: input.authorityResponseHash ?? null,
  };
}

function normalizeCanonicalApprovalFacts(
  input: RecordAuthorityApprovedTxInput
): CanonicalApprovalFacts {
  const allocationNumber = normalizeAllocationNumber(input.allocationNumber);
  if (allocationNumber === null) {
    throw new ValidationError("allocationNumber is required");
  }

  return {
    allocationNumber,
    approvedAt: normalizeApprovedAt(input.approvedAt),
    isEmergencyAllocation: input.isEmergencyAllocation ?? false,
    authorityResponseHash: input.authorityResponseHash ?? null,
    authoritySubmissionId: input.authoritySubmissionId ?? null,
  };
}

function optionalTimestampMatches(
  stored: Date | null,
  incoming: Date | null
): boolean {
  if (stored === null && incoming === null) {
    return true;
  }
  if (stored === null || incoming === null) {
    return false;
  }
  return stored.getTime() === incoming.getTime();
}

function optionalStringMatches(
  stored: string | null,
  incoming: string | null
): boolean {
  if (stored === null && incoming === null) {
    return true;
  }
  if (stored === null || incoming === null) {
    return false;
  }
  return stored === incoming;
}

export function approvalFactsMatch(
  stored: CanonicalApprovalFacts,
  incoming: CanonicalApprovalFacts
): boolean {
  return (
    stored.allocationNumber === incoming.allocationNumber &&
    stored.approvedAt.getTime() === incoming.approvedAt.getTime() &&
    stored.isEmergencyAllocation === incoming.isEmergencyAllocation &&
    optionalStringMatches(
      stored.authorityResponseHash,
      incoming.authorityResponseHash
    ) &&
    optionalStringMatches(
      stored.authoritySubmissionId,
      incoming.authoritySubmissionId
    )
  );
}

export function storedApprovalFacts(
  submission: AuthoritySubmissionRow
): CanonicalApprovalFacts | null {
  const allocationNumber = normalizeAllocationNumber(submission.allocationNumber);
  if (
    allocationNumber === null ||
    submission.approvedAt === null ||
    Number.isNaN(submission.approvedAt.getTime())
  ) {
    return null;
  }

  return {
    allocationNumber,
    approvedAt: submission.approvedAt,
    isEmergencyAllocation: submission.isEmergencyAllocation,
    authorityResponseHash: submission.authorityResponseHash,
    authoritySubmissionId: submission.authoritySubmissionId,
  };
}

export function storedRejectionFacts(
  submission: AuthoritySubmissionRow
): CanonicalRejectionFacts | null {
  if (
    submission.status !== BillingAuthoritySubmissionStatus.REJECTED ||
    submission.rejectedAt === null ||
    Number.isNaN(submission.rejectedAt.getTime())
  ) {
    return null;
  }

  const errorCode =
    submission.errorCode === null ? null : normalizeErrorCode(submission.errorCode);
  if (errorCode === null) {
    return null;
  }

  return {
    rejectedAt: submission.rejectedAt,
    errorCode,
    authorityResponseHash: submission.authorityResponseHash,
  };
}

export function rejectionFactsMatch(
  stored: CanonicalRejectionFacts,
  incoming: CanonicalRejectionFacts
): boolean {
  return (
    stored.rejectedAt.getTime() === incoming.rejectedAt.getTime() &&
    stored.errorCode === incoming.errorCode &&
    optionalStringMatches(
      stored.authorityResponseHash,
      incoming.authorityResponseHash
    )
  );
}

export function storedFailureFacts(
  submission: AuthoritySubmissionRow
): CanonicalFailureFacts | null {
  if (
    submission.status !== BillingAuthoritySubmissionStatus.FAILED ||
    submission.lastAttemptAt === null ||
    Number.isNaN(submission.lastAttemptAt.getTime())
  ) {
    return null;
  }

  const errorCode =
    submission.errorCode === null ? null : normalizeErrorCode(submission.errorCode);
  if (errorCode === null) {
    return null;
  }

  return {
    lastAttemptAt: submission.lastAttemptAt,
    errorCode,
    authorityResponseHash: submission.authorityResponseHash,
  };
}

export function failureFactsMatch(
  stored: CanonicalFailureFacts,
  incoming: CanonicalFailureFacts
): boolean {
  return (
    stored.lastAttemptAt.getTime() === incoming.lastAttemptAt.getTime() &&
    stored.errorCode === incoming.errorCode &&
    optionalStringMatches(
      stored.authorityResponseHash,
      incoming.authorityResponseHash
    )
  );
}

function normalizeAuthorityHeldCode(code: number): AuthorityHeldCode {
  if (!(AUTHORITY_HELD_CODES as readonly number[]).includes(code)) {
    throw new ValidationError(
      `authorityCode ${code} is not a hold-for-decision code (${AUTHORITY_HELD_CODES.join("/")})`
    );
  }
  return code as AuthorityHeldCode;
}

function normalizeCanonicalHeldFacts(
  input: RecordAuthorityHeldTxInput
): CanonicalHeldFacts {
  const code = normalizeAuthorityHeldCode(input.authorityCode);
  return {
    errorCode: buildAuthorityHeldErrorCode(code),
    errorMessage: normalizeErrorMessage(input.message),
    authorityResponseHash: input.authorityResponseHash ?? null,
  };
}

export function storedHeldFacts(
  submission: AuthoritySubmissionRow
): CanonicalHeldFacts | null {
  if (submission.status !== BillingAuthoritySubmissionStatus.HELD) {
    return null;
  }
  const errorCode =
    submission.errorCode === null ? null : normalizeErrorCode(submission.errorCode);
  const errorMessage =
    submission.errorMessage === null
      ? null
      : normalizeErrorMessage(submission.errorMessage);
  if (errorCode === null || errorMessage === null) {
    return null;
  }
  return {
    errorCode,
    errorMessage,
    authorityResponseHash: submission.authorityResponseHash,
  };
}

export function heldFactsMatch(
  stored: CanonicalHeldFacts,
  incoming: CanonicalHeldFacts
): boolean {
  return (
    stored.errorCode === incoming.errorCode &&
    stored.errorMessage === incoming.errorMessage &&
    optionalStringMatches(
      stored.authorityResponseHash,
      incoming.authorityResponseHash
    )
  );
}

function assertHeldFactsConflict(
  submission: AuthoritySubmissionRow,
  incoming: CanonicalHeldFacts
): void {
  const stored = storedHeldFacts(submission);
  if (stored === null) {
    throw new ConflictError(
      "AUTHORITY_HELD_FACT_CONFLICT",
      "Held submission is missing canonical held facts"
    );
  }
  if (!heldFactsMatch(stored, incoming)) {
    throw new ConflictError(
      "AUTHORITY_HELD_FACT_CONFLICT",
      "Authority held facts conflict with the stored held submission"
    );
  }
}

function handleHeldIdempotencyGate(
  submission: AuthoritySubmissionRow,
  incoming: CanonicalHeldFacts
): RecordAuthorityHeldTxResult {
  assertHeldFactsConflict(submission, incoming);

  return {
    outcome: "NOOP",
    submission,
    fromStatus: submission.status,
    toStatus: submission.status,
    transitionKind: null,
    auditWritten: false,
  };
}

function normalizeCanonicalScheduleRetryFacts(
  input: RecordAuthorityScheduleRetryTxInput
): CanonicalScheduleRetryFacts {
  const scheduledAt = normalizeAuthorityTimestamp(input.scheduledAt, "scheduledAt");
  let nextRetryAt: Date | null = null;
  if (input.nextRetryAt !== undefined && input.nextRetryAt !== null) {
    nextRetryAt = normalizeAuthorityTimestamp(input.nextRetryAt, "nextRetryAt");
  }
  return { scheduledAt, nextRetryAt };
}

export function scheduleRetryFactsMatch(
  stored: CanonicalScheduleRetryFacts,
  incoming: CanonicalScheduleRetryFacts
): boolean {
  return (
    stored.scheduledAt.getTime() === incoming.scheduledAt.getTime() &&
    optionalTimestampMatches(stored.nextRetryAt, incoming.nextRetryAt)
  );
}

export function scheduleRetryFactsFromAuditMetadata(
  metadata: Record<string, unknown>
): CanonicalScheduleRetryFacts | null {
  const scheduledAtRaw = metadata.scheduledAt;
  if (typeof scheduledAtRaw !== "string") {
    return null;
  }
  const scheduledAt = new Date(scheduledAtRaw);
  if (Number.isNaN(scheduledAt.getTime())) {
    return null;
  }

  const nextRetryAtRaw = metadata.nextRetryAt;
  if (nextRetryAtRaw === null || nextRetryAtRaw === undefined) {
    return { scheduledAt, nextRetryAt: null };
  }
  if (typeof nextRetryAtRaw !== "string") {
    return null;
  }
  const nextRetryAt = new Date(nextRetryAtRaw);
  if (Number.isNaN(nextRetryAt.getTime())) {
    return null;
  }
  return { scheduledAt, nextRetryAt };
}

function auditBelongsToFailureEpisode(
  metadata: Record<string, unknown>,
  submissionId: number,
  failureEpisodeAt: Date
): boolean {
  if (metadata.submissionId !== submissionId) {
    return false;
  }
  const episodeRaw = metadata.failureEpisodeAt;
  if (typeof episodeRaw !== "string") {
    return false;
  }
  const episode = new Date(episodeRaw);
  if (Number.isNaN(episode.getTime())) {
    return false;
  }
  return episode.getTime() === failureEpisodeAt.getTime();
}

export function isDocumentProjectionComplete(
  submission: AuthoritySubmissionRow,
  document: AuthorityDocumentRow
): boolean {
  const facts = storedApprovalFacts(submission);
  if (facts === null) {
    return false;
  }

  const documentAllocation = normalizeAllocationNumber(document.allocationNumber);
  if (documentAllocation === null || document.allocationApprovedAt === null) {
    return false;
  }

  return (
    documentAllocation === facts.allocationNumber &&
    document.allocationApprovedAt.getTime() === facts.approvedAt.getTime() &&
    document.isEmergencyAllocation === facts.isEmergencyAllocation
  );
}

function buildDocumentProjectionUpdate(
  facts: CanonicalApprovalFacts
): Prisma.BillingDocumentUpdateInput {
  return {
    allocationNumber: facts.allocationNumber,
    allocationApprovedAt: facts.approvedAt,
    isEmergencyAllocation: facts.isEmergencyAllocation,
    // Invalidate any cached PDF: it was rendered before the allocation number
    // existed. Forcing PENDING makes the next PDF request re-render WITH the
    // number (never serve a stale cached copy that lacks it).
    pdfRenderStatus: BillingPdfRenderStatus.PENDING,
  };
}

function buildProposedSubmissionContext(
  submission: AuthoritySubmissionRow,
  facts: CanonicalApprovalFacts
): AuthoritySubmissionContext {
  return {
    ...toSubmissionContext(submission),
    allocationNumber: facts.allocationNumber,
    approvedAt: facts.approvedAt,
    isEmergencyAllocation: facts.isEmergencyAllocation,
    authoritySubmissionId:
      facts.authoritySubmissionId ?? submission.authoritySubmissionId,
  };
}

function resolveApprovalTransitionKind(
  submission: AuthoritySubmissionRow,
  facts: CanonicalApprovalFacts
): AuthorityTransitionKind {
  const kind = resolveAuthorityTransitionKind({
    from: BillingAuthoritySubmissionStatus.SUBMITTED,
    to: BillingAuthoritySubmissionStatus.APPROVED,
    isEmergency:
      submission.submissionChannel ===
        BillingAuthoritySubmissionChannel.EMERGENCY || facts.isEmergencyAllocation,
  });
  if (kind !== "APPROVE" && kind !== "EMERGENCY_ALLOCATE") {
    throw new ForbiddenError(
      "Authority approval transition kind could not be resolved",
      "AUTHORITY_APPROVE_FORBIDDEN"
    );
  }
  return kind;
}

async function loadAuthorityApprovalContext(
  tx: Prisma.TransactionClient,
  businessId: number,
  billingDocumentId: number
): Promise<{ submission: AuthoritySubmissionRow; document: AuthorityDocumentRow }> {
  const submission = await tx.billingAuthoritySubmission.findFirst({
    where: { billingDocumentId, businessId },
    select: SUBMISSION_SELECT,
  });
  if (!submission) {
    throw new NotFoundError(
      "Billing authority submission not found for this document"
    );
  }

  const document = await tx.billingDocument.findFirst({
    where: { id: billingDocumentId, businessId },
    select: DOCUMENT_SELECT,
  });
  if (!document) {
    throw new NotFoundError(
      "Billing document not found for authority transition"
    );
  }

  return { submission, document };
}

async function writeDocumentProjection(
  tx: Prisma.TransactionClient,
  businessId: number,
  billingDocumentId: number,
  update: Prisma.BillingDocumentUpdateInput
): Promise<void> {
  await tx.billingDocument.update({
    where: { id: billingDocumentId, businessId },
    data: update,
  });
}

function assertRejectionFactsConflict(
  submission: AuthoritySubmissionRow,
  incoming: CanonicalRejectionFacts
): void {
  const stored = storedRejectionFacts(submission);
  if (stored === null) {
    throw new ConflictError(
      "AUTHORITY_REJECTION_FACT_CONFLICT",
      "Rejected submission is missing canonical rejection facts"
    );
  }
  if (!rejectionFactsMatch(stored, incoming)) {
    throw new ConflictError(
      "AUTHORITY_REJECTION_FACT_CONFLICT",
      "Authority rejection facts conflict with the stored rejected submission"
    );
  }
}

function assertFailureFactsConflict(
  submission: AuthoritySubmissionRow,
  incoming: CanonicalFailureFacts
): void {
  const stored = storedFailureFacts(submission);
  if (stored === null) {
    throw new ConflictError(
      "AUTHORITY_FAILURE_FACT_CONFLICT",
      "Failed submission is missing canonical failure facts"
    );
  }
  if (!failureFactsMatch(stored, incoming)) {
    throw new ConflictError(
      "AUTHORITY_FAILURE_FACT_CONFLICT",
      "Authority failure facts conflict with the stored failed submission"
    );
  }
}

function assertApprovalFactsConflict(
  submission: AuthoritySubmissionRow,
  incoming: CanonicalApprovalFacts
): void {
  const stored = storedApprovalFacts(submission);
  if (stored === null) {
    throw new ConflictError(
      "AUTHORITY_APPROVAL_FACT_CONFLICT",
      "Approved submission is missing canonical approval facts"
    );
  }
  if (!approvalFactsMatch(stored, incoming)) {
    throw new ConflictError(
      "AUTHORITY_APPROVAL_FACT_CONFLICT",
      "Authority approval facts conflict with the stored approved submission"
    );
  }
}

function handleRejectedIdempotencyGate(
  submission: AuthoritySubmissionRow,
  incoming: CanonicalRejectionFacts
): RecordAuthorityRejectedTxResult {
  assertRejectionFactsConflict(submission, incoming);

  return {
    outcome: "NOOP",
    submission,
    fromStatus: submission.status,
    toStatus: submission.status,
    transitionKind: null,
    auditWritten: false,
  };
}

function handleFailedIdempotencyGate(
  submission: AuthoritySubmissionRow,
  incoming: CanonicalFailureFacts
): RecordAuthorityFailedTxResult {
  assertFailureFactsConflict(submission, incoming);

  return {
    outcome: "NOOP",
    submission,
    fromStatus: submission.status,
    toStatus: submission.status,
    transitionKind: null,
    auditWritten: false,
  };
}

function assertScheduleRetryFactsConflict(
  stored: CanonicalScheduleRetryFacts,
  incoming: CanonicalScheduleRetryFacts
): void {
  if (!scheduleRetryFactsMatch(stored, incoming)) {
    throw new ConflictError(
      "AUTHORITY_RETRY_SCHEDULE_CONFLICT",
      "Authority retry schedule facts conflict with the stored schedule for this failure episode"
    );
  }
}

function handleScheduleRetryIdempotencyGate(
  submission: AuthoritySubmissionRow,
  stored: CanonicalScheduleRetryFacts,
  incoming: CanonicalScheduleRetryFacts
): RecordAuthorityScheduleRetryTxResult {
  assertScheduleRetryFactsConflict(stored, incoming);

  return {
    outcome: "NOOP",
    submission,
    fromStatus: submission.status,
    toStatus: submission.status,
    transitionKind: null,
    auditWritten: false,
  };
}

async function findRetryScheduleAuditForEpisode(
  tx: Prisma.TransactionClient,
  input: {
    businessId: number;
    billingDocumentId: number;
    submissionId: number;
    failureEpisodeAt: Date;
  }
): Promise<CanonicalScheduleRetryFacts | null> {
  const events = await tx.billingAuditEvent.findMany({
    where: {
      businessId: input.businessId,
      billingDocumentId: input.billingDocumentId,
      eventType: "BILLING_AUTHORITY_RETRY_SCHEDULED",
    },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    select: {
      metadata: true,
    },
  });

  for (const event of events) {
    if (event.metadata === null || typeof event.metadata !== "object") {
      continue;
    }
    const metadata = event.metadata as Record<string, unknown>;
    if (
      !auditBelongsToFailureEpisode(
        metadata,
        input.submissionId,
        input.failureEpisodeAt
      )
    ) {
      continue;
    }
    const facts = scheduleRetryFactsFromAuditMetadata(metadata);
    if (facts !== null) {
      return facts;
    }
  }

  return null;
}

async function handleApprovedIdempotencyGate(
  tx: Prisma.TransactionClient,
  input: RecordAuthorityApprovedTxInput,
  submission: AuthoritySubmissionRow,
  document: AuthorityDocumentRow,
  incoming: CanonicalApprovalFacts
): Promise<RecordAuthorityApprovedTxResult> {
  assertApprovalFactsConflict(submission, incoming);

  if (isDocumentProjectionComplete(submission, document)) {
    return {
      outcome: "NOOP",
      submission,
      fromStatus: submission.status,
      toStatus: submission.status,
      transitionKind: null,
      auditWritten: false,
      documentProjectionWritten: false,
    };
  }

  await writeDocumentProjection(
    tx,
    input.businessId,
    input.billingDocumentId,
    buildDocumentProjectionUpdate(incoming)
  );

  const refreshedSubmission = await tx.billingAuthoritySubmission.findFirst({
    where: {
      billingDocumentId: input.billingDocumentId,
      businessId: input.businessId,
    },
    select: SUBMISSION_SELECT,
  });
  if (!refreshedSubmission) {
    throw new NotFoundError(
      "Billing authority submission not found for this document"
    );
  }

  return {
    outcome: "REPAIRED",
    submission: refreshedSubmission,
    fromStatus: refreshedSubmission.status,
    toStatus: refreshedSubmission.status,
    transitionKind: null,
    auditWritten: false,
    documentProjectionWritten: true,
  };
}

/**
 * Internal generic transition writer — single post-issue persist path for C.4+.
 */
export async function executeAuthorityTransitionTx(
  tx: Prisma.TransactionClient,
  input: ExecuteAuthorityTransitionTxInput
): Promise<ExecuteAuthorityTransitionTxResult> {
  const { submission, document } = await loadAuthorityApprovalContext(
    tx,
    input.businessId,
    input.billingDocumentId
  );

  const fromStatus = submission.status;
  const validationSubmission =
    input.validationSubmission ?? toSubmissionContext(submission);

  assertAuthorityTransition({
    from: fromStatus,
    to: input.to,
    kind: input.kind,
    document: toDocumentContext(document),
    submission: validationSubmission,
  });

  let updated: AuthoritySubmissionRow;

  if (input.skipSubmissionUpdate) {
    if (
      input.requireCurrentStatus !== undefined &&
      submission.status !== input.requireCurrentStatus
    ) {
      throw new AuthorityConditionalUpdateMissedError();
    }
    updated = submission;
  } else if (input.requireCurrentStatus) {
    const updateResult = await tx.billingAuthoritySubmission.updateMany({
      where: {
        id: submission.id,
        businessId: input.businessId,
        status: input.requireCurrentStatus,
      },
      data: input.submissionUpdate,
    });
    if (updateResult.count === 0) {
      throw new AuthorityConditionalUpdateMissedError();
    }

    const refreshed = await tx.billingAuthoritySubmission.findFirst({
      where: {
        billingDocumentId: input.billingDocumentId,
        businessId: input.businessId,
      },
      select: SUBMISSION_SELECT,
    });
    if (!refreshed) {
      throw new NotFoundError(
        "Billing authority submission not found for this document"
      );
    }
    updated = refreshed;
  } else {
    updated = await tx.billingAuthoritySubmission.update({
      where: { id: submission.id },
      data: input.submissionUpdate,
      select: SUBMISSION_SELECT,
    });
  }

  let documentProjectionWritten = false;
  if (input.documentProjectionUpdate) {
    await writeDocumentProjection(
      tx,
      input.businessId,
      input.billingDocumentId,
      input.documentProjectionUpdate
    );
    documentProjectionWritten = true;
  }

  const auditEventType = getRequiredAuditEventForTransition(input.kind);
  let auditWritten = false;

  if (!input.skipAudit) {
    await createBillingAuditEventTx(tx, {
      businessId: input.businessId,
      billingDocumentId: input.billingDocumentId,
      actorUserId: input.actorUserId ?? null,
      eventType: auditEventType,
      source: "SYSTEM",
      summary: input.summary,
      metadata: {
        billingDocumentId: input.billingDocumentId,
        submissionId: updated.id,
        transitionKind: input.kind,
        fromStatus,
        toStatus: input.to,
        authorityStatus: updated.status,
        outcome: "APPLIED",
        ...input.metadata,
      },
      occurredAt: input.occurredAt,
    });
    auditWritten = true;
  }

  return {
    submission: updated,
    fromStatus,
    toStatus: input.to,
    transitionKind: input.kind,
    auditEventType,
    auditWritten,
    documentProjectionWritten,
  };
}

/**
 * Persists a submission attempt (READY|PENDING|FAILED → SUBMITTED) without external ITA calls.
 */
export async function recordAuthoritySubmissionAttemptTx(
  tx: Prisma.TransactionClient,
  input: RecordAuthoritySubmissionAttemptInput
): Promise<ExecuteAuthorityTransitionTxResult> {
  const occurredAt = input.occurredAt ?? new Date();

  const existing = await tx.billingAuthoritySubmission.findFirst({
    where: {
      billingDocumentId: input.billingDocumentId,
      businessId: input.businessId,
    },
    select: { status: true, submittedAt: true, retryCount: true },
  });
  if (!existing) {
    throw new NotFoundError(
      "Billing authority submission not found for this document"
    );
  }

  const isRetry = existing.status === BillingAuthoritySubmissionStatus.FAILED;

  const submissionUpdate: Prisma.BillingAuthoritySubmissionUpdateInput = {
    status: BillingAuthoritySubmissionStatus.SUBMITTED,
    submittedAt: existing.submittedAt ?? occurredAt,
    lastAttemptAt: occurredAt,
    retryCount: isRetry ? existing.retryCount + 1 : existing.retryCount,
  };

  if (input.authorityPayloadHash !== undefined) {
    submissionUpdate.authorityPayloadHash = input.authorityPayloadHash;
  }
  if (input.authoritySubmissionId !== undefined) {
    submissionUpdate.authoritySubmissionId = input.authoritySubmissionId;
  }
  if (input.authorityResponseHash !== undefined) {
    submissionUpdate.authorityResponseHash = input.authorityResponseHash;
  }

  const result = await executeAuthorityTransitionTx(tx, {
    businessId: input.businessId,
    billingDocumentId: input.billingDocumentId,
    kind: "SUBMIT_ATTEMPT",
    to: BillingAuthoritySubmissionStatus.SUBMITTED,
    actorUserId: input.actorUserId,
    occurredAt,
    summary: "Authority submission attempt recorded",
    metadata: {
      authorityPayloadHash: input.authorityPayloadHash ?? null,
      authoritySubmissionId: input.authoritySubmissionId ?? null,
      authorityResponseHash: input.authorityResponseHash ?? null,
      retryIncremented: isRetry,
    },
    submissionUpdate,
  });

  return result;
}

/**
 * Persists authority approval (SUBMITTED → APPROVED) and projects allocation facts
 * onto BillingDocument in the same transaction.
 */
export async function recordAuthorityApprovedTx(
  tx: Prisma.TransactionClient,
  input: RecordAuthorityApprovedTxInput
): Promise<RecordAuthorityApprovedTxResult> {
  const incoming = normalizeCanonicalApprovalFacts(input);
  let context = await loadAuthorityApprovalContext(
    tx,
    input.businessId,
    input.billingDocumentId
  );

  if (context.submission.status === BillingAuthoritySubmissionStatus.APPROVED) {
    return handleApprovedIdempotencyGate(
      tx,
      input,
      context.submission,
      context.document,
      incoming
    );
  }

  if (context.submission.status !== BillingAuthoritySubmissionStatus.SUBMITTED) {
    throw new ForbiddenError(
      "Authority approval is only allowed from SUBMITTED",
      "AUTHORITY_APPROVE_FORBIDDEN"
    );
  }

  const transitionKind = resolveApprovalTransitionKind(
    context.submission,
    incoming
  );

  const submissionUpdate: Prisma.BillingAuthoritySubmissionUpdateInput = {
    status: BillingAuthoritySubmissionStatus.APPROVED,
    allocationNumber: incoming.allocationNumber,
    approvedAt: incoming.approvedAt,
    isEmergencyAllocation: incoming.isEmergencyAllocation,
  };

  if (input.authorityResponseHash !== undefined) {
    submissionUpdate.authorityResponseHash = input.authorityResponseHash;
  }
  if (input.authoritySubmissionId !== undefined) {
    submissionUpdate.authoritySubmissionId = input.authoritySubmissionId;
  }

  try {
    const applied = await executeAuthorityTransitionTx(tx, {
      businessId: input.businessId,
      billingDocumentId: input.billingDocumentId,
      kind: transitionKind,
      to: BillingAuthoritySubmissionStatus.APPROVED,
      actorUserId: input.actorUserId,
      occurredAt: input.occurredAt,
      summary: "Authority approval recorded",
      metadata: {
        allocationNumber: incoming.allocationNumber,
        approvedAt: incoming.approvedAt.toISOString(),
        isEmergencyAllocation: incoming.isEmergencyAllocation,
        authorityResponseHash: incoming.authorityResponseHash,
        authoritySubmissionId:
          input.authoritySubmissionId ?? context.submission.authoritySubmissionId,
      },
      submissionUpdate,
      validationSubmission: buildProposedSubmissionContext(
        context.submission,
        incoming
      ),
      documentProjectionUpdate: buildDocumentProjectionUpdate(incoming),
      requireCurrentStatus: BillingAuthoritySubmissionStatus.SUBMITTED,
    });

    return {
      outcome: "APPLIED",
      submission: applied.submission,
      fromStatus: applied.fromStatus,
      toStatus: applied.toStatus,
      transitionKind: applied.transitionKind,
      auditWritten: applied.auditWritten,
      documentProjectionWritten: applied.documentProjectionWritten,
    };
  } catch (error) {
    if (!(error instanceof AuthorityConditionalUpdateMissedError)) {
      throw error;
    }

    context = await loadAuthorityApprovalContext(
      tx,
      input.businessId,
      input.billingDocumentId
    );

    if (context.submission.status === BillingAuthoritySubmissionStatus.APPROVED) {
      return handleApprovedIdempotencyGate(
        tx,
        input,
        context.submission,
        context.document,
        incoming
      );
    }

    throw new ForbiddenError(
      "Authority approval conditional update missed and submission is not approved",
      "AUTHORITY_APPROVE_FORBIDDEN"
    );
  }
}

/**
 * Persists authority rejection (SUBMITTED → REJECTED) without document projection.
 */
export async function recordAuthorityRejectedTx(
  tx: Prisma.TransactionClient,
  input: RecordAuthorityRejectedTxInput
): Promise<RecordAuthorityRejectedTxResult> {
  const incoming = normalizeCanonicalRejectionFacts(input);
  const errorMessage = normalizeErrorMessage(input.errorMessage);
  let context = await loadAuthorityApprovalContext(
    tx,
    input.businessId,
    input.billingDocumentId
  );

  if (context.submission.status === BillingAuthoritySubmissionStatus.REJECTED) {
    return handleRejectedIdempotencyGate(context.submission, incoming);
  }

  if (context.submission.status !== BillingAuthoritySubmissionStatus.SUBMITTED) {
    throw new ForbiddenError(
      "Authority rejection is only allowed from SUBMITTED",
      "AUTHORITY_REJECT_FORBIDDEN"
    );
  }

  const submissionUpdate: Prisma.BillingAuthoritySubmissionUpdateInput = {
    status: BillingAuthoritySubmissionStatus.REJECTED,
    rejectedAt: incoming.rejectedAt,
    errorCode: incoming.errorCode,
    errorMessage,
  };

  if (input.authorityResponseHash !== undefined) {
    submissionUpdate.authorityResponseHash = input.authorityResponseHash;
  }

  try {
    const applied = await executeAuthorityTransitionTx(tx, {
      businessId: input.businessId,
      billingDocumentId: input.billingDocumentId,
      kind: "REJECT",
      to: BillingAuthoritySubmissionStatus.REJECTED,
      actorUserId: input.actorUserId,
      occurredAt: input.occurredAt,
      summary: "Authority rejection recorded",
      metadata: {
        rejectedAt: incoming.rejectedAt.toISOString(),
        errorCode: incoming.errorCode,
        errorMessage,
        authorityResponseHash: incoming.authorityResponseHash,
        outcome: "APPLIED",
      },
      submissionUpdate,
      requireCurrentStatus: BillingAuthoritySubmissionStatus.SUBMITTED,
    });

    return {
      outcome: "APPLIED",
      submission: applied.submission,
      fromStatus: applied.fromStatus,
      toStatus: applied.toStatus,
      transitionKind: applied.transitionKind,
      auditWritten: applied.auditWritten,
    };
  } catch (error) {
    if (!(error instanceof AuthorityConditionalUpdateMissedError)) {
      throw error;
    }

    context = await loadAuthorityApprovalContext(
      tx,
      input.businessId,
      input.billingDocumentId
    );

    if (context.submission.status === BillingAuthoritySubmissionStatus.REJECTED) {
      return handleRejectedIdempotencyGate(context.submission, incoming);
    }

    throw new ForbiddenError(
      "Authority rejection conditional update missed and submission is not rejected",
      "AUTHORITY_REJECT_FORBIDDEN"
    );
  }
}

/**
 * Persists authority operational failure (PENDING|SUBMITTED → FAILED) without document projection.
 */
export async function recordAuthorityFailedTx(
  tx: Prisma.TransactionClient,
  input: RecordAuthorityFailedTxInput
): Promise<RecordAuthorityFailedTxResult> {
  const incoming = normalizeCanonicalFailureFacts(input);
  const errorMessage = normalizeErrorMessage(input.errorMessage);
  let context = await loadAuthorityApprovalContext(
    tx,
    input.businessId,
    input.billingDocumentId
  );

  if (context.submission.status === BillingAuthoritySubmissionStatus.FAILED) {
    return handleFailedIdempotencyGate(context.submission, incoming);
  }

  const fromStatus = context.submission.status;
  if (
    fromStatus !== BillingAuthoritySubmissionStatus.PENDING &&
    fromStatus !== BillingAuthoritySubmissionStatus.SUBMITTED
  ) {
    throw new ForbiddenError(
      "Authority failure is only allowed from PENDING or SUBMITTED",
      "AUTHORITY_FAIL_FORBIDDEN"
    );
  }

  const submissionUpdate: Prisma.BillingAuthoritySubmissionUpdateInput = {
    status: BillingAuthoritySubmissionStatus.FAILED,
    lastAttemptAt: incoming.lastAttemptAt,
    errorCode: incoming.errorCode,
    errorMessage,
  };

  if (input.authorityResponseHash !== undefined) {
    submissionUpdate.authorityResponseHash = input.authorityResponseHash;
  }

  try {
    const applied = await executeAuthorityTransitionTx(tx, {
      businessId: input.businessId,
      billingDocumentId: input.billingDocumentId,
      kind: "FAIL",
      to: BillingAuthoritySubmissionStatus.FAILED,
      actorUserId: input.actorUserId,
      occurredAt: input.occurredAt,
      summary: "Authority failure recorded",
      metadata: {
        lastAttemptAt: incoming.lastAttemptAt.toISOString(),
        errorCode: incoming.errorCode,
        errorMessage,
        authorityResponseHash: incoming.authorityResponseHash,
        outcome: "APPLIED",
      },
      submissionUpdate,
      requireCurrentStatus: fromStatus,
    });

    return {
      outcome: "APPLIED",
      submission: applied.submission,
      fromStatus: applied.fromStatus,
      toStatus: applied.toStatus,
      transitionKind: applied.transitionKind,
      auditWritten: applied.auditWritten,
    };
  } catch (error) {
    if (!(error instanceof AuthorityConditionalUpdateMissedError)) {
      throw error;
    }

    context = await loadAuthorityApprovalContext(
      tx,
      input.businessId,
      input.billingDocumentId
    );

    if (context.submission.status === BillingAuthoritySubmissionStatus.FAILED) {
      return handleFailedIdempotencyGate(context.submission, incoming);
    }

    throw new ForbiddenError(
      "Authority failure conditional update missed and submission is not failed",
      "AUTHORITY_FAIL_FORBIDDEN"
    );
  }
}

/**
 * Persists a hold-for-decision outcome (SUBMITTED → HELD) without document
 * projection. The authority withheld allocation for a business reason (460/461)
 * and a user decision is required before the process can continue.
 *
 * Stores the canonical `errorCode` (AUTHORITY_DECISION_REQUIRED_<code>) and a
 * sanitized `errorMessage`. Does NOT touch `heldDecisionType` /
 * `heldDecisionReportedAt` (no decision has been made yet) and does NOT store an
 * allocation number. Idempotent on replay: identical facts → NOOP; conflicting
 * facts → fail closed.
 */
export async function recordAuthorityHeldTx(
  tx: Prisma.TransactionClient,
  input: RecordAuthorityHeldTxInput
): Promise<RecordAuthorityHeldTxResult> {
  const incoming = normalizeCanonicalHeldFacts(input);
  normalizeAuthorityTimestamp(input.heldAt, "heldAt");
  let context = await loadAuthorityApprovalContext(
    tx,
    input.businessId,
    input.billingDocumentId
  );

  if (context.submission.status === BillingAuthoritySubmissionStatus.HELD) {
    return handleHeldIdempotencyGate(context.submission, incoming);
  }

  if (context.submission.status !== BillingAuthoritySubmissionStatus.SUBMITTED) {
    throw new ForbiddenError(
      "Authority hold-for-decision is only allowed from SUBMITTED",
      "AUTHORITY_HOLD_FORBIDDEN"
    );
  }

  const submissionUpdate: Prisma.BillingAuthoritySubmissionUpdateInput = {
    status: BillingAuthoritySubmissionStatus.HELD,
    errorCode: incoming.errorCode,
    errorMessage: incoming.errorMessage,
  };

  if (input.authorityResponseHash !== undefined) {
    submissionUpdate.authorityResponseHash = input.authorityResponseHash;
  }

  try {
    const applied = await executeAuthorityTransitionTx(tx, {
      businessId: input.businessId,
      billingDocumentId: input.billingDocumentId,
      kind: "HOLD_FOR_DECISION",
      to: BillingAuthoritySubmissionStatus.HELD,
      actorUserId: input.actorUserId,
      occurredAt: input.occurredAt,
      summary: "Authority hold-for-decision recorded",
      metadata: {
        heldAt: input.heldAt.toISOString(),
        authorityCode: input.authorityCode,
        errorCode: incoming.errorCode,
        errorMessage: incoming.errorMessage,
        authorityResponseHash: incoming.authorityResponseHash,
        outcome: "APPLIED",
      },
      submissionUpdate,
      requireCurrentStatus: BillingAuthoritySubmissionStatus.SUBMITTED,
    });

    return {
      outcome: "APPLIED",
      submission: applied.submission,
      fromStatus: applied.fromStatus,
      toStatus: applied.toStatus,
      transitionKind: applied.transitionKind,
      auditWritten: applied.auditWritten,
    };
  } catch (error) {
    if (!(error instanceof AuthorityConditionalUpdateMissedError)) {
      throw error;
    }

    context = await loadAuthorityApprovalContext(
      tx,
      input.businessId,
      input.billingDocumentId
    );

    if (context.submission.status === BillingAuthoritySubmissionStatus.HELD) {
      return handleHeldIdempotencyGate(context.submission, incoming);
    }

    throw new ForbiddenError(
      "Authority hold-for-decision conditional update missed and submission is not held",
      "AUTHORITY_HOLD_FORBIDDEN"
    );
  }
}

/**
 * Records retry scheduling intent for a failed submission (FAILED → FAILED, audit-only).
 */
export async function recordAuthorityScheduleRetryTx(
  tx: Prisma.TransactionClient,
  input: RecordAuthorityScheduleRetryTxInput
): Promise<RecordAuthorityScheduleRetryTxResult> {
  const incoming = normalizeCanonicalScheduleRetryFacts(input);
  let context = await loadAuthorityApprovalContext(
    tx,
    input.businessId,
    input.billingDocumentId
  );

  if (context.submission.status !== BillingAuthoritySubmissionStatus.FAILED) {
    throw new ForbiddenError(
      "Authority retry scheduling is only allowed from FAILED",
      "AUTHORITY_RETRY_FORBIDDEN"
    );
  }

  if (
    context.submission.lastAttemptAt === null ||
    Number.isNaN(context.submission.lastAttemptAt.getTime())
  ) {
    throw new ValidationError(
      "Failed submission is missing lastAttemptAt for retry scheduling"
    );
  }

  const failureEpisodeAt = context.submission.lastAttemptAt;
  const storedSchedule = await findRetryScheduleAuditForEpisode(tx, {
    businessId: input.businessId,
    billingDocumentId: input.billingDocumentId,
    submissionId: context.submission.id,
    failureEpisodeAt,
  });

  if (storedSchedule !== null) {
    return handleScheduleRetryIdempotencyGate(
      context.submission,
      storedSchedule,
      incoming
    );
  }

  const submissionBefore = { ...context.submission };

  try {
    const applied = await executeAuthorityTransitionTx(tx, {
      businessId: input.businessId,
      billingDocumentId: input.billingDocumentId,
      kind: "SCHEDULE_RETRY",
      to: BillingAuthoritySubmissionStatus.FAILED,
      actorUserId: input.actorUserId,
      occurredAt: input.occurredAt,
      summary: "Authority retry scheduled",
      metadata: {
        scheduledAt: incoming.scheduledAt.toISOString(),
        nextRetryAt: incoming.nextRetryAt?.toISOString() ?? null,
        failureEpisodeAt: failureEpisodeAt.toISOString(),
        outcome: "APPLIED",
      },
      submissionUpdate: {},
      skipSubmissionUpdate: true,
      requireCurrentStatus: BillingAuthoritySubmissionStatus.FAILED,
    });

    return {
      outcome: "APPLIED",
      submission: applied.submission,
      fromStatus: applied.fromStatus,
      toStatus: applied.toStatus,
      transitionKind: applied.transitionKind,
      auditWritten: applied.auditWritten,
    };
  } catch (error) {
    if (!(error instanceof AuthorityConditionalUpdateMissedError)) {
      throw error;
    }

    context = await loadAuthorityApprovalContext(
      tx,
      input.businessId,
      input.billingDocumentId
    );

    if (context.submission.status !== BillingAuthoritySubmissionStatus.FAILED) {
      throw new ForbiddenError(
        "Authority retry scheduling conditional check missed and submission is not failed",
        "AUTHORITY_RETRY_FORBIDDEN"
      );
    }

    if (
      context.submission.lastAttemptAt === null ||
      Number.isNaN(context.submission.lastAttemptAt.getTime())
    ) {
      throw new ValidationError(
        "Failed submission is missing lastAttemptAt for retry scheduling"
      );
    }

    const refreshedEpisodeAt = context.submission.lastAttemptAt;
    const refreshedSchedule = await findRetryScheduleAuditForEpisode(tx, {
      businessId: input.businessId,
      billingDocumentId: input.billingDocumentId,
      submissionId: context.submission.id,
      failureEpisodeAt: refreshedEpisodeAt,
    });

    if (refreshedSchedule !== null) {
      return handleScheduleRetryIdempotencyGate(
        context.submission,
        refreshedSchedule,
        incoming
      );
    }

    if (
      submissionBefore.lastAttemptAt?.getTime() !==
      refreshedEpisodeAt.getTime()
    ) {
      throw new ForbiddenError(
        "Authority retry scheduling missed because the failure episode changed",
        "AUTHORITY_RETRY_FORBIDDEN"
      );
    }

    throw new ForbiddenError(
      "Authority retry scheduling conditional check missed",
      "AUTHORITY_RETRY_FORBIDDEN"
    );
  }
}
