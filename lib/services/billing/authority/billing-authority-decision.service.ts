/**
 * Held-decision execution service — runs ONE decision (Cancel / Continue /
 * FurtherObjection) for a submission in HELD. Composes the existing runtime
 * context, DTO builder, HTTP client and transition writer. NOT an Approval retry.
 *
 * Atomic order (never record a local decision before the authority accepts it):
 *   validate → load doc+submission → assert HELD & no decision yet → resolve
 *   runtime context → build payload → CALL authority → only on verified Accepted:
 *   TX recordAuthorityHeldDecisionTx → commit → delivery derives from new state.
 * Network / timeout / 4xx / invalid body → NO local decision, NO delivery release.
 */

import { randomUUID } from "node:crypto";
import {
  BillingAuthorityDecisionType,
  BillingAuthorityEnvironment,
  BillingAuthoritySubmissionStatus,
  BillingDocumentStatus,
  Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ConflictError } from "@/lib/errors";
import { resolveRuntimeAuthorityEnvironment } from "@/lib/services/billing/authority/billing-authority-env.service";
import {
  assertSnapshotV1,
  type BillingIssuedSnapshotV1,
} from "@/lib/services/billing/pdf/billing-pdf-template";
import {
  resolveApprovalRuntimeContext,
  type RuntimeContextResult,
} from "@/lib/services/billing/authority/billing-authority-approval-runtime-context.provider";
import { INVOICE_DECISION_API_VERSION } from "@/lib/services/billing/authority/billing-authority-decision-client.config";
import {
  requestInvoiceDecision,
  type DecisionDomainResult,
  type RequestInvoiceDecisionInput,
} from "@/lib/services/billing/authority/billing-authority-decision-orchestrator";
import type { InvoiceDecisionAction } from "@/lib/services/billing/authority/billing-authority-decision.types";
import {
  HELD_DECISION_ACTION_TO_TYPE,
  recordAuthorityHeldDecisionTx,
  type RecordAuthorityHeldDecisionTxInput,
  type RecordAuthorityHeldDecisionTxResult,
} from "@/lib/services/billing/authority/billing-authority-transition.service";
import { createBillingAuditEventBestEffort } from "@/lib/services/billing/billing-audit.service";
import { billingTenantTx } from "../billing-tenant-tx";

export type DecisionExecutionResult =
  | { outcome: "decision_recorded"; billingDocumentId: number; submissionId: number; action: InvoiceDecisionAction; decisionType: BillingAuthorityDecisionType; deliverable: boolean }
  | { outcome: "already_recorded_idempotent"; billingDocumentId: number; submissionId: number; decisionType: BillingAuthorityDecisionType }
  | { outcome: "reconciliation_required"; billingDocumentId: number; submissionId: number; code: number }
  | { outcome: "no_matching_invoice"; billingDocumentId: number; submissionId: number; code: number }
  | { outcome: "not_held"; billingDocumentId: number; submissionId?: number; status: BillingAuthoritySubmissionStatus | null }
  | { outcome: "already_decided_conflict"; billingDocumentId: number; submissionId: number }
  | { outcome: "local_validation_failed"; billingDocumentId: number; submissionId?: number; errorCode: string }
  | { outcome: "authority_validation_failed"; billingDocumentId: number; submissionId: number }
  | { outcome: "infrastructure_failed"; billingDocumentId: number; submissionId: number; errorCode: string; safeToRetry: boolean }
  | { outcome: "preflight_failed"; billingDocumentId: number; submissionId?: number; errorCode: string };

export type ExecuteAuthorityDecisionInput = {
  businessId: number;
  billingDocumentId: number;
  actorUserId: number;
  action: InvoiceDecisionAction;
};

export type LoadedDecisionContext = {
  id: number;
  businessId: number;
  status: BillingDocumentStatus;
  issuedSnapshot: Prisma.JsonValue | null;
  submission: {
    id: number;
    status: BillingAuthoritySubmissionStatus;
    heldDecisionType: BillingAuthorityDecisionType | null;
    heldDecisionReportedAt: Date | null;
  } | null;
};

export type DecisionExecutionDeps = {
  loadContext: (businessId: number, billingDocumentId: number) => Promise<LoadedDecisionContext | null>;
  loadOperatorName: (userId: number) => Promise<string | null>;
  resolveEnvironment: () => BillingAuthorityEnvironment;
  resolveRuntimeContext: (input: { businessId: number; environment: BillingAuthorityEnvironment }) => Promise<RuntimeContextResult>;
  requestDecision: (input: RequestInvoiceDecisionInput) => Promise<DecisionDomainResult>;
  /**
   * D2/P7-W4E-B-2: the transaction is opened for a specific tenant. Without
   * the businessId this dependency would open a context-less transaction,
   * which under FORCE RLS reads and writes nothing.
   */
  runInTransaction: <T>(
    businessId: number,
    fn: (tx: Prisma.TransactionClient) => Promise<T>
  ) => Promise<T>;
  recordDecision: (tx: Prisma.TransactionClient, input: RecordAuthorityHeldDecisionTxInput) => Promise<RecordAuthorityHeldDecisionTxResult>;
  now: () => Date;
  newCorrelationId: () => string;
};

export const defaultDecisionExecutionDeps: DecisionExecutionDeps = {
  loadContext: async (businessId, billingDocumentId) => {
    const doc = await prisma.billingDocument.findFirst({
      where: { id: billingDocumentId, businessId },
      select: {
        id: true, businessId: true, status: true, issuedSnapshot: true,
        authoritySubmission: { select: { id: true, status: true, heldDecisionType: true, heldDecisionReportedAt: true } },
      },
    });
    if (!doc) return null;
    const { authoritySubmission, ...rest } = doc;
    return { ...rest, submission: authoritySubmission };
  },
  loadOperatorName: async (userId) => {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    return u?.name ?? null;
  },
  resolveEnvironment: () => resolveRuntimeAuthorityEnvironment(),
  resolveRuntimeContext: (input) => resolveApprovalRuntimeContext(input),
  requestDecision: (input) => requestInvoiceDecision(input),
  runInTransaction: <T>(
    businessId: number,
    fn: (tx: Prisma.TransactionClient) => Promise<T>
  ) => billingTenantTx(businessId, fn),
  recordDecision: recordAuthorityHeldDecisionTx,
  now: () => new Date(),
  newCorrelationId: () => randomUUID(),
};

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}

/** Best-effort audit for a non-recorded decision attempt (no state change). */
async function auditAttempt(
  input: ExecuteAuthorityDecisionInput,
  submissionId: number | null,
  outcome: string,
  correlationId: string,
  message: string | null,
): Promise<void> {
  await createBillingAuditEventBestEffort({
    businessId: input.businessId,
    billingDocumentId: input.billingDocumentId,
    actorUserId: input.actorUserId,
    eventType: "BILLING_AUTHORITY_HELD_DECISION_REPORTED",
    source: "SYSTEM",
    summary: "Authority held-decision attempt",
    metadata: {
      billingDocumentId: input.billingDocumentId,
      submissionId,
      action: input.action,
      outcome,
      correlationId,
      // Sanitized authority text only (never tokens / PII).
      authorityMessage: message,
    },
  });
}

export async function executeAuthorityDecision(
  input: ExecuteAuthorityDecisionInput,
  deps: DecisionExecutionDeps = defaultDecisionExecutionDeps,
): Promise<DecisionExecutionResult> {
  const { businessId, billingDocumentId, actorUserId, action } = input;
  if (!isPositiveInt(businessId) || !isPositiveInt(billingDocumentId) || !isPositiveInt(actorUserId)) {
    return { outcome: "preflight_failed", billingDocumentId: Number(billingDocumentId) || 0, errorCode: "INVALID_INPUT" };
  }
  const decisionType = HELD_DECISION_ACTION_TO_TYPE[action];

  // ---- environment ----
  let environment: BillingAuthorityEnvironment;
  try {
    environment = deps.resolveEnvironment();
  } catch {
    return { outcome: "preflight_failed", billingDocumentId, errorCode: "ENVIRONMENT_NOT_CONFIGURED" };
  }

  // ---- load + preflight (HELD, no decision yet) ----
  const loaded = await deps.loadContext(businessId, billingDocumentId);
  if (!loaded) return { outcome: "preflight_failed", billingDocumentId, errorCode: "DOCUMENT_NOT_FOUND" };
  if (loaded.status !== BillingDocumentStatus.ISSUED) return { outcome: "preflight_failed", billingDocumentId, errorCode: "DOCUMENT_NOT_ISSUED" };
  if (!loaded.submission) return { outcome: "preflight_failed", billingDocumentId, errorCode: "SUBMISSION_MISSING" };

  const submission = loaded.submission;
  if (submission.status !== BillingAuthoritySubmissionStatus.HELD) {
    return { outcome: "not_held", billingDocumentId, submissionId: submission.id, status: submission.status };
  }
  if (submission.heldDecisionType !== null || submission.heldDecisionReportedAt !== null) {
    // A decision was already recorded locally — do not send another.
    return submission.heldDecisionType === decisionType
      ? { outcome: "already_recorded_idempotent", billingDocumentId, submissionId: submission.id, decisionType }
      : { outcome: "already_decided_conflict", billingDocumentId, submissionId: submission.id };
  }

  // ---- snapshot → issuer VAT ----
  let snapshot: BillingIssuedSnapshotV1;
  try {
    assertSnapshotV1(loaded.issuedSnapshot);
    snapshot = loaded.issuedSnapshot as unknown as BillingIssuedSnapshotV1;
  } catch {
    return { outcome: "preflight_failed", billingDocumentId, submissionId: submission.id, errorCode: "SNAPSHOT_INVALID" };
  }

  // ---- runtime context (token, config, software number) ----
  const ctx = await deps.resolveRuntimeContext({ businessId, environment });
  if (!ctx.ok) {
    return { outcome: "preflight_failed", billingDocumentId, submissionId: submission.id, errorCode: ctx.code };
  }

  const operatorName = await deps.loadOperatorName(actorUserId);
  const correlationId = deps.newCorrelationId();

  // ---- call the authority (outside any transaction) ----
  const result = await deps.requestDecision({
    action,
    accessToken: ctx.context.accessToken,
    config: {
      apiBaseUrl: ctx.context.approvalConfig.apiBaseUrl,
      apiVersion: INVOICE_DECISION_API_VERSION,
      timeoutMs: ctx.context.approvalConfig.timeoutMs,
    },
    payloadInput: {
      billingDocumentId,
      issuerVatNumber: snapshot.issuer.taxId,
      accountingSoftwareNumber: ctx.context.accountingSoftwareNumber,
      // No operator national id source exists → user_name path; company id omitted.
      operatorNationalId: null,
      operatorName,
      authorizedCompany: null,
    },
  });

  // ---- map outcome (record locally ONLY on verified Accepted) ----
  switch (result.outcome) {
    case "accepted": {
      const rec = await deps.runInTransaction(input.businessId, (tx) =>
        deps.recordDecision(tx, {
          businessId, billingDocumentId,
          decisionType,
          reportedAt: deps.now(),
          actorUserId,
          authorityMessage: result.message,
          correlationId,
        }),
      ).catch((e: unknown) => {
        if (e instanceof ConflictError) return null;
        throw e;
      });
      if (rec === null) {
        // Concurrent decision won the race — do not overwrite.
        return { outcome: "already_decided_conflict", billingDocumentId, submissionId: submission.id };
      }
      const deliverable = decisionType === BillingAuthorityDecisionType.PROCEED_WITHOUT_ALLOCATION;
      return {
        outcome: rec.outcome === "NOOP" ? "already_recorded_idempotent" : "decision_recorded",
        billingDocumentId, submissionId: submission.id, action, decisionType, deliverable,
      } as DecisionExecutionResult;
    }
    case "already_reported": {
      // 462 — authority already has a decision but we have none locally.
      await auditAttempt(input, submission.id, "RECONCILIATION_REQUIRED_462", correlationId, result.message);
      return { outcome: "reconciliation_required", billingDocumentId, submissionId: submission.id, code: result.code };
    }
    case "no_matching_invoice": {
      await auditAttempt(input, submission.id, "NO_MATCHING_INVOICE_463", correlationId, result.message);
      return { outcome: "no_matching_invoice", billingDocumentId, submissionId: submission.id, code: result.code };
    }
    case "local_validation_failed": {
      return { outcome: "local_validation_failed", billingDocumentId, submissionId: submission.id, errorCode: result.errors[0]?.code ?? "LOCAL_VALIDATION_FAILED" };
    }
    case "authority_validation_failed": {
      await auditAttempt(input, submission.id, "AUTHORITY_VALIDATION_FAILED", correlationId, result.message);
      return { outcome: "authority_validation_failed", billingDocumentId, submissionId: submission.id };
    }
    case "infrastructure_failure": {
      await auditAttempt(input, submission.id, `INFRASTRUCTURE_${result.classification}`, correlationId, null);
      const retryable = result.classification === "NETWORK" || result.classification === "TIMEOUT" || result.classification === "SERVER";
      return { outcome: "infrastructure_failed", billingDocumentId, submissionId: submission.id, errorCode: `AUTHORITY_${result.classification}`, safeToRetry: retryable };
    }
    default: {
      const _never: never = result;
      return _never;
    }
  }
}
