/**
 * Submission Execution Service — runs ONE end-to-end allocation attempt for an
 * issued billing document. Called only from the post-commit issue hook.
 *
 * Flow: load doc+submission -> re-entry gate -> resolve runtime context ->
 * build payload (customerTaxId from the frozen snapshot) -> payload-hash
 * determinism check -> TX1 reserve (compare-and-set READY | FAILED[not-sent]
 * -> SUBMITTED) -> exactly ONE Approval POST outside any tx -> TX2 persist.
 *
 * SAFETY INVARIANT: an Approval request that may already have reached the Tax
 * Authority is never sent again by Dubiz.
 *   - Only a provably NOT_SENT failure is persisted as FAILED (re-executable).
 *   - Every possibly-sent outcome without a definitive provider result stays
 *     SUBMITTED with an AUTHORITY_OUTCOME_UNCERTAIN_* marker; SUBMITTED is never
 *     executable, so no automatic or user-triggered path can re-POST it.
 *   - A 401 is not proven to mean "not processed" (undocumented in the
 *     contract) → no in-attempt re-POST with a refreshed token; uncertain.
 *   - If ITA approved but TX2 fails, the submission is marked uncertain with the
 *     received allocation number (best effort); if even that write fails it
 *     remains SUBMITTED from TX1 — still non-executable.
 * No reconciliation endpoint is assumed. No retry scheduling exists.
 */

import { createHash } from "node:crypto";
import {
  BillingAuthorityEnvironment,
  BillingAuthoritySubmissionStatus,
  BillingDocumentStatus,
  Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveRuntimeAuthorityEnvironment } from "@/lib/services/billing/authority/billing-authority-env.service";
import {
  assertSnapshotV1,
  type BillingIssuedSnapshotV1,
} from "@/lib/services/billing/pdf/billing-pdf-template";
import type { InvoiceApprovalRequest } from "@/lib/services/billing/authority/billing-authority-approval.types";
import {
  buildInvoiceApprovalPayload,
  type ApprovalPayloadBuildResult,
  type BuildInvoiceApprovalPayloadInput,
} from "@/lib/services/billing/authority/billing-authority-approval-payload";
import {
  requestInvoiceApproval,
  type ApprovalDomainResult,
  type RequestInvoiceApprovalInput,
} from "@/lib/services/billing/authority/billing-authority-approval-orchestrator";
import {
  resolveApprovalRuntimeContext,
  type RuntimeContextResult,
} from "@/lib/services/billing/authority/billing-authority-approval-runtime-context.provider";
import {
  AuthorityConditionalUpdateMissedError,
  buildAuthorityHeldErrorCode,
  recordAuthorityApprovedTx,
  recordAuthorityFailedTx,
  recordAuthorityHeldTx,
  recordAuthorityOutcomeUncertainTx,
  recordAuthorityRejectedTx,
  recordAuthoritySubmissionAttemptTx,
  type AuthorityOutcomeUncertainEvidence,
  type RecordAuthorityApprovedTxInput,
  type RecordAuthorityFailedTxInput,
  type RecordAuthorityHeldTxInput,
  type RecordAuthorityOutcomeUncertainTxInput,
  type RecordAuthorityRejectedTxInput,
  type RecordAuthoritySubmissionAttemptInput,
} from "@/lib/services/billing/authority/billing-authority-transition.service";
import {
  buildAuthorityNotSentErrorCode,
  buildAuthorityOutcomeUncertainErrorCode,
  isAuthorityNotSentErrorCode,
  isAuthorityOutcomeUncertainErrorCode,
  type AuthorityNotSentReason,
  type AuthorityOutcomeUncertainReason,
} from "@/lib/services/billing/authority/billing-authority-send-certainty";
import { ForbiddenError } from "@/lib/errors";
import { billingTenantTx } from "../billing-tenant-tx";

/** The HTTP send path ignores `scope` (OAuth-only); a placeholder satisfies the
 *  client config type without leaking scope into the runtime context. */
const ORCHESTRATOR_SCOPE_UNUSED = "" as const;

export type SafeToRetry = boolean | "manual";

/** An SUBMITTED row without a marker older than this is reported as uncertain (read-only). */
export const AUTHORITY_IN_FLIGHT_STALE_MS = 15 * 60 * 1000;

export type ExecutionResult =
  | { outcome: "completed_approved"; billingDocumentId: number; submissionId: number; allocationNumber: string; safeToRetry: false }
  | { outcome: "completed_rejected"; billingDocumentId: number; submissionId: number; errorCode: string; safeToRetry: false }
  | { outcome: "preflight_failed"; billingDocumentId: number; submissionId?: number; errorCode: string; safeToRetry: boolean }
  | { outcome: "local_validation_failed"; billingDocumentId: number; submissionId?: number; errorCode: string; safeToRetry: true }
  /** Provably NOT_SENT transport/configuration failure — persisted FAILED, re-executable. */
  | { outcome: "infrastructure_failed"; billingDocumentId: number; submissionId: number; errorCode: string; safeToRetry: true }
  | { outcome: "already_processed"; billingDocumentId: number; submissionId: number; status: BillingAuthoritySubmissionStatus; safeToRetry: false }
  | { outcome: "in_progress"; billingDocumentId: number; submissionId: number; safeToRetry: false }
  | { outcome: "decision_required"; billingDocumentId: number; submissionId: number; code: number; errorCode: string; userActionRequired: true; safeToRetry: false }
  | { outcome: "decision_already_reported"; billingDocumentId: number; submissionId: number; code: number; errorCode: string; safeToRetry: false }
  /** The POST may have reached the authority; never re-sent; explicit resolution required. */
  | { outcome: "outcome_uncertain"; billingDocumentId: number; submissionId: number; errorCode: string; userActionRequired: true; safeToRetry: false };

export type ExecuteAuthorityApprovalInput = {
  businessId: number;
  billingDocumentId: number;
  actorUserId: number;
};

export type LoadedDocumentSubmission = {
  id: number;
  businessId: number;
  status: BillingDocumentStatus;
  lockedAt: Date | null;
  legalSnapshotHash: string | null;
  issuedSnapshot: Prisma.JsonValue | null;
  submission: {
    id: number;
    status: BillingAuthoritySubmissionStatus;
    authorityPayloadHash: string | null;
    errorCode: string | null;
    lastAttemptAt: Date | null;
  } | null;
};

/** Sanitized safety evidence for logs — ids, codes and hashes only. */
export type AuthoritySafetyEvent = {
  event:
    | "AUTHORITY_APPROVED_PERSIST_FAILED"
    | "AUTHORITY_UNCERTAIN_MARKER_WRITE_FAILED"
    | "AUTHORITY_NOT_SENT_FAILURE_WRITE_FAILED";
  businessId: number;
  billingDocumentId: number;
  submissionId: number;
  errorCode: string;
  /** sha256 of the received allocation number (hex, first 16) — never the number. */
  allocationNumberSha256Prefix?: string;
  allocationNumberLength?: number;
  persistErrorName?: string;
};

export type SubmissionExecutionDeps = {
  loadDocumentWithSubmission: (businessId: number, billingDocumentId: number) => Promise<LoadedDocumentSubmission | null>;
  resolveEnvironment: () => BillingAuthorityEnvironment;
  resolveRuntimeContext: (input: { businessId: number; environment: BillingAuthorityEnvironment; forceRefresh?: boolean }) => Promise<RuntimeContextResult>;
  buildPayload: (input: BuildInvoiceApprovalPayloadInput) => ApprovalPayloadBuildResult;
  requestApproval: (input: RequestInvoiceApprovalInput) => Promise<ApprovalDomainResult>;
  hashPayload: (payload: InvoiceApprovalRequest) => string;
  now: () => Date;
  /**
   * D2/P7-W4E-B-2: the transaction is opened for a specific tenant. Without
   * the businessId this dependency would open a context-less transaction,
   * which under FORCE RLS reads and writes nothing.
   */
  runInTransaction: <T>(
    businessId: number,
    fn: (tx: Prisma.TransactionClient) => Promise<T>
  ) => Promise<T>;
  recordAttempt: (tx: Prisma.TransactionClient, input: RecordAuthoritySubmissionAttemptInput) => Promise<{ submission: { id: number } }>;
  recordApproved: (tx: Prisma.TransactionClient, input: RecordAuthorityApprovedTxInput) => Promise<unknown>;
  recordRejected: (tx: Prisma.TransactionClient, input: RecordAuthorityRejectedTxInput) => Promise<unknown>;
  recordFailed: (tx: Prisma.TransactionClient, input: RecordAuthorityFailedTxInput) => Promise<unknown>;
  recordHeld: (tx: Prisma.TransactionClient, input: RecordAuthorityHeldTxInput) => Promise<unknown>;
  recordOutcomeUncertain: (tx: Prisma.TransactionClient, input: RecordAuthorityOutcomeUncertainTxInput) => Promise<unknown>;
  reportSafetyEvent: (event: AuthoritySafetyEvent) => void;
};

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
}

export function hashApprovalPayload(payload: InvoiceApprovalRequest): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

export const defaultSubmissionExecutionDeps: SubmissionExecutionDeps = {
  loadDocumentWithSubmission: async (businessId, billingDocumentId) => {
    const doc = await billingTenantTx(businessId, (tx) =>
    tx.billingDocument.findFirst({
      where: { id: billingDocumentId, businessId },
      select: {
        id: true, businessId: true, status: true, lockedAt: true,
        legalSnapshotHash: true, issuedSnapshot: true,
        authoritySubmission: { select: { id: true, status: true, authorityPayloadHash: true, errorCode: true, lastAttemptAt: true } },
      },
    })
  );
    if (!doc) return null;
    const { authoritySubmission, ...rest } = doc;
    return { ...rest, submission: authoritySubmission };
  },
  resolveEnvironment: () => resolveRuntimeAuthorityEnvironment(),
  resolveRuntimeContext: (input) => resolveApprovalRuntimeContext(input),
  buildPayload: buildInvoiceApprovalPayload,
  requestApproval: (input) => requestInvoiceApproval(input),
  hashPayload: hashApprovalPayload,
  now: () => new Date(),
  runInTransaction: <T>(
    businessId: number,
    fn: (tx: Prisma.TransactionClient) => Promise<T>
  ) => billingTenantTx(businessId, fn),
  recordAttempt: recordAuthoritySubmissionAttemptTx,
  recordApproved: recordAuthorityApprovedTx,
  recordRejected: recordAuthorityRejectedTx,
  recordFailed: recordAuthorityFailedTx,
  recordHeld: recordAuthorityHeldTx,
  recordOutcomeUncertain: recordAuthorityOutcomeUncertainTx,
  reportSafetyEvent: (event) => {
    // Filtered: ids, internal codes and a hash only — no token/payload/number.
    console.error("billing-authority: approval safety event", event);
  },
};

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}

function sha256Prefix(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Possibly-sent infrastructure outcome → uncertain reason. */
function uncertainReasonForInfrastructure(
  result: Extract<ApprovalDomainResult, { outcome: "infrastructure_failure" }>
): AuthorityOutcomeUncertainReason {
  // A 5xx status is the more informative signal even when its body is malformed.
  if (result.classification === "SERVER") return "SERVER";
  if (result.failureKind === "MALFORMED_BODY") return "MALFORMED_RESPONSE";
  switch (result.classification) {
    case "TIMEOUT":
      return "TIMEOUT";
    case "NETWORK":
      return result.failureKind === "BODY_READ" ? "MALFORMED_RESPONSE" : "NETWORK";
    case "AUTHENTICATION":
      return "AUTHENTICATION";
    case "AUTHORIZATION":
      return "AUTHORIZATION";
    default:
      return result.failureKind === "HTTP_STATUS" ? "UNEXPECTED_STATUS" : "UNKNOWN";
  }
}

function notSentReasonForInfrastructure(
  result: Extract<ApprovalDomainResult, { outcome: "infrastructure_failure" }>
): AuthorityNotSentReason {
  return result.classification === "CONFIGURATION" ? "CONFIGURATION" : "NETWORK";
}

const NO_EVIDENCE: AuthorityOutcomeUncertainEvidence = {
  sendCertainty: "POSSIBLY_SENT",
  classification: null,
  failureKind: null,
  providerHttpStatus: null,
  providerErrorId: null,
  transportCode: null,
  receivedAllocationNumber: null,
};

type Ctx = {
  deps: SubmissionExecutionDeps;
  input: ExecuteAuthorityApprovalInput;
  submissionId: number;
};

/**
 * Persist a provably NOT_SENT failure (TX2 → FAILED, re-executable). If the
 * write fails the row stays SUBMITTED from TX1 — non-executable, still safe.
 */
async function persistNotSent(ctx: Ctx, reason: AuthorityNotSentReason): Promise<string> {
  const errorCode = buildAuthorityNotSentErrorCode(reason);
  const { deps, input } = ctx;
  await deps.runInTransaction(input.businessId, (tx) =>
    deps.recordFailed(tx, {
      businessId: input.businessId,
      billingDocumentId: input.billingDocumentId,
      lastAttemptAt: deps.now(),
      errorCode,
      // Sanitized: our own internal code only — never authority PII/tokens.
      errorMessage: errorCode,
      actorUserId: input.actorUserId,
    }),
  );
  return errorCode;
}

/**
 * Marks the SUBMITTED row as outcome-uncertain and returns the non-retryable
 * result. Never throws: if the marker cannot be written the row is still
 * SUBMITTED from TX1 (non-executable) and a sanitized safety event is emitted.
 */
async function markUncertain(
  ctx: Ctx,
  reason: AuthorityOutcomeUncertainReason,
  evidence: AuthorityOutcomeUncertainEvidence,
): Promise<ExecutionResult> {
  const { deps, input, submissionId } = ctx;
  const errorCode = buildAuthorityOutcomeUncertainErrorCode(reason);
  try {
    await deps.runInTransaction(input.businessId, (tx) =>
      deps.recordOutcomeUncertain(tx, {
        businessId: input.businessId,
        billingDocumentId: input.billingDocumentId,
        reason,
        observedAt: deps.now(),
        evidence,
        actorUserId: input.actorUserId,
      }),
    );
  } catch (error) {
    deps.reportSafetyEvent({
      event: "AUTHORITY_UNCERTAIN_MARKER_WRITE_FAILED",
      businessId: input.businessId,
      billingDocumentId: input.billingDocumentId,
      submissionId,
      errorCode,
      persistErrorName: errorName(error),
      ...(evidence.receivedAllocationNumber
        ? {
            allocationNumberSha256Prefix: sha256Prefix(evidence.receivedAllocationNumber),
            allocationNumberLength: evidence.receivedAllocationNumber.length,
          }
        : {}),
    });
  }
  return {
    outcome: "outcome_uncertain",
    billingDocumentId: input.billingDocumentId,
    submissionId,
    errorCode,
    userActionRequired: true,
    safeToRetry: false,
  };
}

async function already(ctx: Ctx): Promise<ExecutionResult> {
  const after = await ctx.deps.loadDocumentWithSubmission(ctx.input.businessId, ctx.input.billingDocumentId);
  const st = after?.submission?.status ?? BillingAuthoritySubmissionStatus.SUBMITTED;
  return { outcome: "already_processed", billingDocumentId: ctx.input.billingDocumentId, submissionId: ctx.submissionId, status: st, safeToRetry: false };
}

export async function executeAuthorityApproval(
  input: ExecuteAuthorityApprovalInput,
  deps: SubmissionExecutionDeps = defaultSubmissionExecutionDeps,
): Promise<ExecutionResult> {
  const { businessId, billingDocumentId, actorUserId } = input;
  if (!isPositiveInt(businessId) || !isPositiveInt(billingDocumentId) || !isPositiveInt(actorUserId)) {
    return { outcome: "preflight_failed", billingDocumentId: Number(billingDocumentId) || 0, errorCode: "INVALID_INPUT", safeToRetry: false };
  }

  // ---- environment ----
  let environment: BillingAuthorityEnvironment;
  try {
    environment = deps.resolveEnvironment();
  } catch {
    return { outcome: "preflight_failed", billingDocumentId, errorCode: "ENVIRONMENT_NOT_CONFIGURED", safeToRetry: true };
  }

  // ---- load ----
  const loaded = await deps.loadDocumentWithSubmission(businessId, billingDocumentId);
  if (!loaded) return { outcome: "preflight_failed", billingDocumentId, errorCode: "DOCUMENT_NOT_FOUND", safeToRetry: false };
  if (loaded.status !== BillingDocumentStatus.ISSUED) return { outcome: "preflight_failed", billingDocumentId, errorCode: "DOCUMENT_NOT_ISSUED", safeToRetry: false };
  if (loaded.lockedAt == null) return { outcome: "preflight_failed", billingDocumentId, errorCode: "DOCUMENT_NOT_LOCKED", safeToRetry: false };
  if (loaded.legalSnapshotHash == null) return { outcome: "preflight_failed", billingDocumentId, errorCode: "LEGAL_HASH_MISSING", safeToRetry: false };
  if (!loaded.submission) return { outcome: "preflight_failed", billingDocumentId, errorCode: "SUBMISSION_MISSING", safeToRetry: false };

  // ---- re-entry gate: only READY or a provably not-sent FAILED may POST ----
  const submission = loaded.submission;
  switch (submission.status) {
    case BillingAuthoritySubmissionStatus.SUBMITTED: {
      // A POST may be in flight or may already have reached the authority.
      const marked = isAuthorityOutcomeUncertainErrorCode(submission.errorCode);
      const stale =
        submission.lastAttemptAt != null &&
        deps.now().getTime() - submission.lastAttemptAt.getTime() > AUTHORITY_IN_FLIGHT_STALE_MS;
      if (marked || stale) {
        return {
          outcome: "outcome_uncertain",
          billingDocumentId,
          submissionId: submission.id,
          errorCode: marked
            ? (submission.errorCode as string)
            : buildAuthorityOutcomeUncertainErrorCode("UNKNOWN"),
          userActionRequired: true,
          safeToRetry: false,
        };
      }
      return { outcome: "in_progress", billingDocumentId, submissionId: submission.id, safeToRetry: false };
    }
    case BillingAuthoritySubmissionStatus.APPROVED:
    case BillingAuthoritySubmissionStatus.REJECTED:
      return { outcome: "already_processed", billingDocumentId, submissionId: submission.id, status: submission.status, safeToRetry: false };
    case BillingAuthoritySubmissionStatus.READY:
      break;
    case BillingAuthoritySubmissionStatus.FAILED:
      if (!isAuthorityNotSentErrorCode(submission.errorCode)) {
        // Legacy/unknown failure code: the previous POST may have been sent.
        return { outcome: "preflight_failed", billingDocumentId, submissionId: submission.id, errorCode: "SUBMISSION_NOT_PROVABLY_UNSENT", safeToRetry: false };
      }
      break;
    default:
      // NOT_REQUIRED / PENDING / HELD — fail-closed, not executable.
      return { outcome: "preflight_failed", billingDocumentId, submissionId: submission.id, errorCode: "SUBMISSION_NOT_EXECUTABLE", safeToRetry: false };
  }

  // ---- snapshot ----
  let snapshot: BillingIssuedSnapshotV1;
  try {
    assertSnapshotV1(loaded.issuedSnapshot);
    snapshot = loaded.issuedSnapshot as unknown as BillingIssuedSnapshotV1;
  } catch {
    return { outcome: "preflight_failed", billingDocumentId, submissionId: submission.id, errorCode: "SNAPSHOT_INVALID", safeToRetry: false };
  }

  // ---- runtime context (needed for accountingSoftwareNumber before build) ----
  const ctx = await deps.resolveRuntimeContext({ businessId, environment });
  if (!ctx.ok) {
    return { outcome: "preflight_failed", billingDocumentId, submissionId: submission.id, errorCode: ctx.code, safeToRetry: true };
  }

  // ---- build payload (customerTaxId ONLY from the frozen snapshot) ----
  const built = deps.buildPayload({
    snapshot,
    customerTaxId: snapshot.customer.taxId,
    accountingSoftwareNumber: ctx.context.accountingSoftwareNumber,
    operatorUserName: String(actorUserId),
  });
  if (!built.ok) {
    return { outcome: "local_validation_failed", billingDocumentId, submissionId: submission.id, errorCode: built.errors[0]?.code ?? "LOCAL_VALIDATION_FAILED", safeToRetry: true };
  }

  // ---- payload-hash determinism ----
  const payloadHash = deps.hashPayload(built.payload);
  if (submission.authorityPayloadHash != null && submission.authorityPayloadHash !== payloadHash) {
    return { outcome: "preflight_failed", billingDocumentId, submissionId: submission.id, errorCode: "AUTHORITY_PAYLOAD_HASH_MISMATCH", safeToRetry: false };
  }

  // ---- TX1 reserve: compare-and-set READY | FAILED[not-sent] -> SUBMITTED ----
  // The ownership boundary: at most one concurrent caller passes it.
  try {
    await deps.runInTransaction(input.businessId, (tx) =>
      deps.recordAttempt(tx, {
        businessId, billingDocumentId, actorUserId,
        authorityPayloadHash: payloadHash,
        occurredAt: deps.now(),
      }),
    );
  } catch (error) {
    // Nothing has been sent. Report what the row says now.
    const after = await deps.loadDocumentWithSubmission(businessId, billingDocumentId);
    const st = after?.submission?.status;
    if (st === BillingAuthoritySubmissionStatus.APPROVED || st === BillingAuthoritySubmissionStatus.REJECTED) {
      return { outcome: "already_processed", billingDocumentId, submissionId: submission.id, status: st, safeToRetry: false };
    }
    if (st === BillingAuthoritySubmissionStatus.SUBMITTED || error instanceof AuthorityConditionalUpdateMissedError) {
      return { outcome: "in_progress", billingDocumentId, submissionId: submission.id, safeToRetry: false };
    }
    if (error instanceof ForbiddenError) {
      return { outcome: "preflight_failed", billingDocumentId, submissionId: submission.id, errorCode: "SUBMISSION_NOT_PROVABLY_UNSENT", safeToRetry: false };
    }
    return { outcome: "preflight_failed", billingDocumentId, submissionId: submission.id, errorCode: "RESERVE_FAILED", safeToRetry: true };
  }

  const owned: Ctx = { deps, input, submissionId: submission.id };

  // ---- exactly ONE Approval POST (outside any tx). No in-attempt re-POST. ----
  let result: ApprovalDomainResult;
  try {
    result = await deps.requestApproval({
      snapshot,
      customerTaxId: snapshot.customer.taxId,
      accountingSoftwareNumber: ctx.context.accountingSoftwareNumber,
      operatorUserName: String(actorUserId),
      accessToken: ctx.context.accessToken,
      config: { ...ctx.context.approvalConfig, scope: ORCHESTRATOR_SCOPE_UNUSED },
    });
  } catch {
    // The orchestrator contains its own catch; a throw here is unexpected and
    // its send status cannot be proven.
    return markUncertain(owned, "UNKNOWN", { ...NO_EVIDENCE, failureKind: "CLIENT_THREW" });
  }

  // ---- TX2 persist outcome ----
  switch (result.outcome) {
    case "approved": {
      if (result.confirmationNumber == null) {
        return markUncertain(owned, "APPROVED_NO_CONFIRMATION", { ...NO_EVIDENCE, providerHttpStatus: 200 });
      }
      const allocationNumber = result.confirmationNumber;
      try {
        await deps.runInTransaction(input.businessId, (tx) =>
          deps.recordApproved(tx, {
            businessId, billingDocumentId,
            allocationNumber, approvedAt: deps.now(),
            actorUserId,
          }),
        );
        return { outcome: "completed_approved", billingDocumentId, submissionId: submission.id, allocationNumber, safeToRetry: false };
      } catch (error) {
        if (error instanceof AuthorityConditionalUpdateMissedError) {
          const after = await deps.loadDocumentWithSubmission(businessId, billingDocumentId).catch(() => null);
          if (after?.submission?.status === BillingAuthoritySubmissionStatus.APPROVED) {
            return { outcome: "already_processed", billingDocumentId, submissionId: submission.id, status: BillingAuthoritySubmissionStatus.APPROVED, safeToRetry: false };
          }
        }
        // ITA approved but we could not persist it. Never FAILED: keep the
        // number (marker evidence) and block every re-POST.
        deps.reportSafetyEvent({
          event: "AUTHORITY_APPROVED_PERSIST_FAILED",
          businessId, billingDocumentId, submissionId: submission.id,
          errorCode: buildAuthorityOutcomeUncertainErrorCode("APPROVED_PERSIST_FAILED"),
          allocationNumberSha256Prefix: sha256Prefix(allocationNumber),
          allocationNumberLength: allocationNumber.length,
          persistErrorName: errorName(error),
        });
        return markUncertain(owned, "APPROVED_PERSIST_FAILED", {
          ...NO_EVIDENCE,
          providerHttpStatus: 200,
          receivedAllocationNumber: allocationNumber,
        });
      }
    }
    case "authority_validation_failed": {
      // Definitive provider rejection (400 with the contract error schema).
      const errorCode = result.errors[0] ? `ITA_${result.errors[0].code}` : "ITA_VALIDATION";
      try {
        await deps.runInTransaction(input.businessId, (tx) =>
          deps.recordRejected(tx, {
            businessId, billingDocumentId,
            rejectedAt: deps.now(), errorCode,
            // Sanitized summary: our own code only (no authority PII).
            errorMessage: errorCode,
            actorUserId,
          }),
        );
      } catch (error) {
        if (!(error instanceof AuthorityConditionalUpdateMissedError)) throw error;
        return already(owned);
      }
      return { outcome: "completed_rejected", billingDocumentId, submissionId: submission.id, errorCode, safeToRetry: false };
    }
    case "not_acceptable":
      // 406: documented shape, undocumented processing semantics → fail closed.
      return markUncertain(owned, "NOT_ACCEPTABLE", {
        ...NO_EVIDENCE,
        classification: "BUSINESS_VALIDATION",
        providerHttpStatus: 406,
        providerErrorId: result.errorId,
      });
    case "infrastructure_failure": {
      if (result.sendCertainty === "NOT_SENT") {
        const reason = notSentReasonForInfrastructure(result);
        try {
          const errorCode = await persistNotSent(owned, reason);
          return { outcome: "infrastructure_failed", billingDocumentId, submissionId: submission.id, errorCode, safeToRetry: true };
        } catch (error) {
          // Row stays SUBMITTED (non-executable): safe, just not retryable yet.
          deps.reportSafetyEvent({
            event: "AUTHORITY_NOT_SENT_FAILURE_WRITE_FAILED",
            businessId, billingDocumentId, submissionId: submission.id,
            errorCode: buildAuthorityNotSentErrorCode(reason),
            persistErrorName: errorName(error),
          });
          return { outcome: "in_progress", billingDocumentId, submissionId: submission.id, safeToRetry: false };
        }
      }
      return markUncertain(owned, uncertainReasonForInfrastructure(result), {
        ...NO_EVIDENCE,
        classification: result.classification,
        failureKind: result.failureKind,
        providerHttpStatus: result.providerHttpStatus,
        providerErrorId: result.providerErrorId,
        transportCode: result.transportCode,
      });
    }
    case "decision_required": {
      // Definitive business rejection (460/461) requiring a user decision →
      // SUBMITTED → HELD (non-terminal, non-executable).
      const errorCode = buildAuthorityHeldErrorCode(result.code);
      try {
        await deps.runInTransaction(input.businessId, (tx) =>
          deps.recordHeld(tx, {
            businessId, billingDocumentId,
            heldAt: deps.now(),
            authorityCode: result.code,
            message: errorCode,
            actorUserId,
          }),
        );
      } catch (error) {
        if (!(error instanceof AuthorityConditionalUpdateMissedError)) throw error;
        return already(owned);
      }
      return { outcome: "decision_required", billingDocumentId, submissionId: submission.id, code: result.code, errorCode, userActionRequired: true, safeToRetry: false };
    }
    case "decision_already_reported": {
      // 462 — the authority says a decision was already reported. Do not
      // re-decide; keep SUBMITTED and mark it for explicit reconciliation.
      await markUncertain(owned, "DECISION_ALREADY_REPORTED", { ...NO_EVIDENCE, providerHttpStatus: 200 });
      return { outcome: "decision_already_reported", billingDocumentId, submissionId: submission.id, code: result.code, errorCode: "AUTHORITY_DECISION_ALREADY_REPORTED", safeToRetry: false };
    }
    case "not_approved_unknown":
      // approved:false with no verified 460/461/462 — processing unknown.
      return markUncertain(owned, "NOT_APPROVED_AMBIGUOUS", { ...NO_EVIDENCE, providerHttpStatus: 200 });
    case "local_validation_failed": {
      // The orchestrator's own build failed: the client was never called.
      try {
        const errorCode = await persistNotSent(owned, "LOCAL_VALIDATION");
        return { outcome: "local_validation_failed", billingDocumentId, submissionId: submission.id, errorCode, safeToRetry: true };
      } catch (error) {
        if (!(error instanceof AuthorityConditionalUpdateMissedError)) throw error;
        return already(owned);
      }
    }
    default: {
      const _never: never = result;
      return _never;
    }
  }
}
