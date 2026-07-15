/**
 * Submission Execution Service — runs ONE end-to-end allocation attempt for an
 * issued billing document. NOT wired to issueBillingDocument / routes / jobs.
 *
 * Flow: load doc+submission -> pre-flight validate -> resolve runtime context
 * -> build payload (customerTaxId from the frozen snapshot) -> payload-hash
 * determinism check -> TX1 reserve READY/FAILED->SUBMITTED -> HTTP (orchestrator)
 * outside any tx -> optional 401 force-refresh once (same attempt) -> TX2 persist
 * outcome -> ExecutionResult.
 *
 * Composes existing layers unchanged (builder, HTTP client, orchestrator,
 * runtime providers, transitions). No schema/state-machine change. No
 * recordAuthorityScheduleRetryTx (retry scheduling is a future service).
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
import type { AuthorityApprovalConfig } from "@/lib/services/billing/authority/billing-authority-approval-client.config";
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
  recordAuthorityApprovedTx,
  recordAuthorityFailedTx,
  recordAuthorityRejectedTx,
  recordAuthoritySubmissionAttemptTx,
  type RecordAuthorityApprovedTxInput,
  type RecordAuthorityFailedTxInput,
  type RecordAuthorityRejectedTxInput,
  type RecordAuthoritySubmissionAttemptInput,
} from "@/lib/services/billing/authority/billing-authority-transition.service";

/** The HTTP send path ignores `scope` (OAuth-only); a placeholder satisfies the
 *  client config type without leaking scope into the runtime context. */
const ORCHESTRATOR_SCOPE_UNUSED = "" as const;

export type SafeToRetry = boolean | "manual";

export type ExecutionResult =
  | { outcome: "completed_approved"; billingDocumentId: number; submissionId: number; allocationNumber: string; safeToRetry: false }
  | { outcome: "completed_rejected"; billingDocumentId: number; submissionId: number; errorCode: string; safeToRetry: false }
  | { outcome: "preflight_failed"; billingDocumentId: number; submissionId?: number; errorCode: string; safeToRetry: SafeToRetry }
  | { outcome: "local_validation_failed"; billingDocumentId: number; submissionId?: number; errorCode: string; safeToRetry: true }
  | { outcome: "authentication_failed"; billingDocumentId: number; submissionId: number; errorCode: string; safeToRetry: true }
  | { outcome: "infrastructure_failed"; billingDocumentId: number; submissionId: number; errorCode: string; safeToRetry: SafeToRetry }
  | { outcome: "already_processed"; billingDocumentId: number; submissionId: number; status: BillingAuthoritySubmissionStatus; safeToRetry: false }
  | { outcome: "in_progress"; billingDocumentId: number; submissionId: number; safeToRetry: false }
  | { outcome: "decision_required"; billingDocumentId: number; submissionId: number; code: number; errorCode: string; safeToRetry: false }
  | { outcome: "decision_already_reported"; billingDocumentId: number; submissionId: number; code: number; errorCode: string; safeToRetry: false }
  | { outcome: "ambiguous_result"; billingDocumentId: number; submissionId: number; errorCode: string; safeToRetry: SafeToRetry };

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
  } | null;
};

export type SubmissionExecutionDeps = {
  loadDocumentWithSubmission: (businessId: number, billingDocumentId: number) => Promise<LoadedDocumentSubmission | null>;
  resolveEnvironment: () => BillingAuthorityEnvironment;
  resolveRuntimeContext: (input: { businessId: number; environment: BillingAuthorityEnvironment; forceRefresh?: boolean }) => Promise<RuntimeContextResult>;
  buildPayload: (input: BuildInvoiceApprovalPayloadInput) => ApprovalPayloadBuildResult;
  requestApproval: (input: RequestInvoiceApprovalInput) => Promise<ApprovalDomainResult>;
  hashPayload: (payload: InvoiceApprovalRequest) => string;
  now: () => Date;
  runInTransaction: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
  recordAttempt: (tx: Prisma.TransactionClient, input: RecordAuthoritySubmissionAttemptInput) => Promise<{ submission: { id: number } }>;
  recordApproved: (tx: Prisma.TransactionClient, input: RecordAuthorityApprovedTxInput) => Promise<unknown>;
  recordRejected: (tx: Prisma.TransactionClient, input: RecordAuthorityRejectedTxInput) => Promise<unknown>;
  recordFailed: (tx: Prisma.TransactionClient, input: RecordAuthorityFailedTxInput) => Promise<unknown>;
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
    const doc = await prisma.billingDocument.findFirst({
      where: { id: billingDocumentId, businessId },
      select: {
        id: true, businessId: true, status: true, lockedAt: true,
        legalSnapshotHash: true, issuedSnapshot: true,
        authoritySubmission: { select: { id: true, status: true, authorityPayloadHash: true } },
      },
    });
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
  runInTransaction: (fn) => prisma.$transaction(fn),
  recordAttempt: recordAuthoritySubmissionAttemptTx,
  recordApproved: recordAuthorityApprovedTx,
  recordRejected: recordAuthorityRejectedTx,
  recordFailed: recordAuthorityFailedTx,
};

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}

/** Persist a FAILED outcome (TX2) and return an error-shaped ExecutionResult. */
async function persistFailed(
  deps: SubmissionExecutionDeps,
  input: ExecuteAuthorityApprovalInput,
  submissionId: number,
  errorCode: string,
): Promise<void> {
  await deps.runInTransaction((tx) =>
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

  const submission = loaded.submission;
  switch (submission.status) {
    case BillingAuthoritySubmissionStatus.SUBMITTED:
      return { outcome: "in_progress", billingDocumentId, submissionId: submission.id, safeToRetry: false };
    case BillingAuthoritySubmissionStatus.APPROVED:
    case BillingAuthoritySubmissionStatus.REJECTED:
      return { outcome: "already_processed", billingDocumentId, submissionId: submission.id, status: submission.status, safeToRetry: false };
    case BillingAuthoritySubmissionStatus.READY:
    case BillingAuthoritySubmissionStatus.FAILED:
      break;
    default:
      // NOT_REQUIRED / PENDING / INITIAL — fail-closed, not executable.
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
  });
  if (!built.ok) {
    return { outcome: "local_validation_failed", billingDocumentId, submissionId: submission.id, errorCode: built.errors[0]?.code ?? "LOCAL_VALIDATION_FAILED", safeToRetry: true };
  }

  // ---- payload-hash determinism ----
  const payloadHash = deps.hashPayload(built.payload);
  if (submission.authorityPayloadHash != null && submission.authorityPayloadHash !== payloadHash) {
    return { outcome: "preflight_failed", billingDocumentId, submissionId: submission.id, errorCode: "AUTHORITY_PAYLOAD_HASH_MISMATCH", safeToRetry: false };
  }

  // ---- TX1 reserve READY/FAILED -> SUBMITTED ----
  try {
    await deps.runInTransaction((tx) =>
      deps.recordAttempt(tx, {
        businessId, billingDocumentId, actorUserId,
        authorityPayloadHash: payloadHash,
        occurredAt: deps.now(),
      }),
    );
  } catch (error) {
    // Concurrency / status advanced between pre-flight and reserve.
    const after = await deps.loadDocumentWithSubmission(businessId, billingDocumentId);
    const st = after?.submission?.status;
    if (st === BillingAuthoritySubmissionStatus.APPROVED || st === BillingAuthoritySubmissionStatus.REJECTED) {
      return { outcome: "already_processed", billingDocumentId, submissionId: submission.id, status: st, safeToRetry: false };
    }
    if (st === BillingAuthoritySubmissionStatus.SUBMITTED || error instanceof AuthorityConditionalUpdateMissedError) {
      return { outcome: "in_progress", billingDocumentId, submissionId: submission.id, safeToRetry: false };
    }
    return { outcome: "preflight_failed", billingDocumentId, submissionId: submission.id, errorCode: "RESERVE_FAILED", safeToRetry: true };
  }

  // ---- HTTP (outside tx) + 401 force-refresh once (same attempt) ----
  const orchestratorConfig: AuthorityApprovalConfig = { ...ctx.context.approvalConfig, scope: ORCHESTRATOR_SCOPE_UNUSED };
  let result = await deps.requestApproval({
    snapshot,
    customerTaxId: snapshot.customer.taxId,
    accountingSoftwareNumber: ctx.context.accountingSoftwareNumber,
    accessToken: ctx.context.accessToken,
    config: orchestratorConfig,
  });

  if (result.outcome === "infrastructure_failure" && result.classification === "AUTHENTICATION") {
    const ctx2 = await deps.resolveRuntimeContext({ businessId, environment, forceRefresh: true });
    if (!ctx2.ok) {
      await persistFailed(deps, input, submission.id, "AUTHENTICATION");
      return { outcome: "authentication_failed", billingDocumentId, submissionId: submission.id, errorCode: ctx2.code, safeToRetry: true };
    }
    const stableInputs =
      ctx2.context.accountingSoftwareNumber === ctx.context.accountingSoftwareNumber &&
      stableStringify(ctx2.context.approvalConfig) === stableStringify(ctx.context.approvalConfig);
    if (!stableInputs) {
      await persistFailed(deps, input, submission.id, "RUNTIME_CONTEXT_CHANGED");
      return { outcome: "authentication_failed", billingDocumentId, submissionId: submission.id, errorCode: "RUNTIME_CONTEXT_CHANGED", safeToRetry: true };
    }
    // One (and only one) second attempt — identical payload, new access token.
    result = await deps.requestApproval({
      snapshot,
      customerTaxId: snapshot.customer.taxId,
      accountingSoftwareNumber: ctx2.context.accountingSoftwareNumber,
      accessToken: ctx2.context.accessToken,
      config: { ...ctx2.context.approvalConfig, scope: ORCHESTRATOR_SCOPE_UNUSED },
    });
  }

  // ---- TX2 persist outcome (idempotent; concurrent advance -> already_processed) ----
  try {
    switch (result.outcome) {
      case "approved": {
        if (result.confirmationNumber == null) {
          await persistFailed(deps, input, submission.id, "AUTHORITY_APPROVED_NO_CONFIRMATION");
          return { outcome: "ambiguous_result", billingDocumentId, submissionId: submission.id, errorCode: "AUTHORITY_APPROVED_NO_CONFIRMATION", safeToRetry: "manual" };
        }
        const allocationNumber = result.confirmationNumber;
        await deps.runInTransaction((tx) =>
          deps.recordApproved(tx, {
            businessId, billingDocumentId,
            allocationNumber, approvedAt: deps.now(),
            actorUserId,
          }),
        );
        return { outcome: "completed_approved", billingDocumentId, submissionId: submission.id, allocationNumber, safeToRetry: false };
      }
      case "authority_validation_failed": {
        const errorCode = result.errors[0] ? `ITA_${result.errors[0].code}` : "ITA_VALIDATION";
        await deps.runInTransaction((tx) =>
          deps.recordRejected(tx, {
            businessId, billingDocumentId,
            rejectedAt: deps.now(), errorCode,
            // Sanitized summary: our own code only (no authority PII).
            errorMessage: errorCode,
            actorUserId,
          }),
        );
        return { outcome: "completed_rejected", billingDocumentId, submissionId: submission.id, errorCode, safeToRetry: false };
      }
      case "not_acceptable": {
        await persistFailed(deps, input, submission.id, "AUTHORITY_NOT_ACCEPTABLE");
        return { outcome: "infrastructure_failed", billingDocumentId, submissionId: submission.id, errorCode: "AUTHORITY_NOT_ACCEPTABLE", safeToRetry: "manual" };
      }
      case "infrastructure_failure": {
        const errorCode = `AUTHORITY_${result.classification}`;
        await persistFailed(deps, input, submission.id, errorCode);
        if (result.classification === "AUTHENTICATION") {
          return { outcome: "authentication_failed", billingDocumentId, submissionId: submission.id, errorCode, safeToRetry: true };
        }
        const retryable = result.classification === "NETWORK" || result.classification === "TIMEOUT" || result.classification === "SERVER";
        return { outcome: "infrastructure_failed", billingDocumentId, submissionId: submission.id, errorCode, safeToRetry: retryable ? true : "manual" };
      }
      case "decision_required": {
        // Business rejection (460/461) requiring an authority decision. Do NOT
        // persist a technical FAILED nor a terminal REJECTED — that would lose
        // the business meaning and block a future Continue/Objection. The
        // submission is left SUBMITTED (held). Persisting this as a distinct
        // submission state needs a new HELD/DECISION_REQUIRED status — the next
        // PR (out of scope here; see PR report).
        return { outcome: "decision_required", billingDocumentId, submissionId: submission.id, code: result.code, errorCode: `AUTHORITY_DECISION_REQUIRED_${result.code}`, safeToRetry: false };
      }
      case "decision_already_reported": {
        // 462 — a decision was already reported to the authority. Do not
        // re-decide or overwrite local state; flag for reconciliation. The
        // submission is left as-is.
        return { outcome: "decision_already_reported", billingDocumentId, submissionId: submission.id, code: result.code, errorCode: "AUTHORITY_DECISION_ALREADY_REPORTED", safeToRetry: false };
      }
      case "not_approved_unknown": {
        // approved:false with no verified 460/461/462 — fail-closed (no invented
        // decision). Recorded as FAILED; message/confirmation not persisted (no
        // free-form audit field without a schema change) — flagged.
        await persistFailed(deps, input, submission.id, "AUTHORITY_NOT_APPROVED_AMBIGUOUS");
        return { outcome: "ambiguous_result", billingDocumentId, submissionId: submission.id, errorCode: "AUTHORITY_NOT_APPROVED_AMBIGUOUS", safeToRetry: "manual" };
      }
      case "local_validation_failed": {
        await persistFailed(deps, input, submission.id, "AUTHORITY_LOCAL_VALIDATION_UNEXPECTED");
        return { outcome: "local_validation_failed", billingDocumentId, submissionId: submission.id, errorCode: "AUTHORITY_LOCAL_VALIDATION_UNEXPECTED", safeToRetry: true };
      }
      default: {
        const _never: never = result;
        return _never;
      }
    }
  } catch (error) {
    if (error instanceof AuthorityConditionalUpdateMissedError) {
      const after = await deps.loadDocumentWithSubmission(businessId, billingDocumentId);
      const st = after?.submission?.status ?? submission.status;
      return { outcome: "already_processed", billingDocumentId, submissionId: submission.id, status: st, safeToRetry: false };
    }
    throw error;
  }
}
