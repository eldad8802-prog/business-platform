/**
 * ITA allocation Orchestrator.
 *
 * The single layer that knows BOTH the payload builder and the HTTP client.
 * No other service should call the HTTP client directly.
 *
 * It orchestrates one attempt: build → (on success) send → map to a DOMAIN
 * result. It has NO persistence, NO audit, NO state transitions, NO retry, and
 * knows nothing about Prisma, DB, BillingAuthoritySubmission, PDF, OAuth,
 * routes, UI, or issueBillingDocument. Dependencies are injected so it is fully
 * unit-testable without a network.
 *
 * HTTP status codes are never exposed upward — callers see domain outcomes.
 */

import type { BillingIssuedSnapshotV1 } from "@/lib/services/billing/pdf/billing-pdf-template";
import type { InvoiceApprovalValidationErrorDetail } from "@/lib/services/billing/authority/billing-authority-approval.types";
import {
  buildInvoiceApprovalPayload,
  type ApprovalPayloadBuildResult,
  type ApprovalPayloadValidationError,
  type BuildInvoiceApprovalPayloadInput,
} from "@/lib/services/billing/authority/billing-authority-approval-payload";
import { sendInvoiceApproval } from "@/lib/services/billing/authority/billing-authority-approval-client";
import type { AuthorityApprovalConfig } from "@/lib/services/billing/authority/billing-authority-approval-client.config";
import type {
  ApprovalClientErrorClass,
  ApprovalClientResult,
} from "@/lib/services/billing/authority/billing-authority-approval-client.types";
import type { SendInvoiceApprovalInput } from "@/lib/services/billing/authority/billing-authority-approval-client";

/** Business-level input. No DB/env/Prisma — everything is passed in explicitly. */
export type RequestInvoiceApprovalInput = {
  /** Frozen legal snapshot of the issued document. */
  snapshot: BillingIssuedSnapshotV1;
  /** Customer VAT/tax id (absent from the snapshot; supplied by the caller). */
  customerTaxId: string | null;
  /** Software registration number from config (never invented). */
  accountingSoftwareNumber: string | number | null;
  /** Operator identity (§2.3): internal user id of the allocation actor. */
  operatorUserName: string;
  /** Bearer access token, already acquired by the (future) OAuth layer. */
  accessToken: string;
  /** Runtime configuration for the HTTP client. */
  config: AuthorityApprovalConfig;
};

/**
 * Domain result — deliberately free of HTTP status codes.
 * `authority_validation_failed.errors` carries ITA business error entries
 * (not HTTP statuses). `infrastructure_failure.classification` is a transport
 * bucket, not a status code.
 */
export type ApprovalDomainResult =
  | { outcome: "approved"; confirmationNumber: string | null }
  | { outcome: "decision_required"; code: number; confirmationNumber: string | null; message: string | null }
  | { outcome: "decision_already_reported"; code: number; confirmationNumber: string | null; message: string | null }
  | { outcome: "not_approved_unknown"; confirmationNumber: string | null; message: string | null }
  | { outcome: "local_validation_failed"; errors: ApprovalPayloadValidationError[] }
  | { outcome: "authority_validation_failed"; errors: InvoiceApprovalValidationErrorDetail[] }
  | { outcome: "not_acceptable"; errorId: string | null; message: string | null }
  | { outcome: "infrastructure_failure"; classification: ApprovalClientErrorClass; message: string };

/** Injected collaborators — the only place both are referenced together. */
export type ApprovalOrchestratorDeps = {
  buildPayload: (input: BuildInvoiceApprovalPayloadInput) => ApprovalPayloadBuildResult;
  sendApproval: (input: SendInvoiceApprovalInput) => Promise<ApprovalClientResult>;
};

/** Production wiring of the real builder + HTTP client. */
export const defaultApprovalOrchestratorDeps: ApprovalOrchestratorDeps = {
  buildPayload: buildInvoiceApprovalPayload,
  sendApproval: sendInvoiceApproval,
};

function mapClientResultToDomain(result: ApprovalClientResult): ApprovalDomainResult {
  switch (result.kind) {
    case "success":
      // The client only emits `success` for approved:true (200+approved:false
      // is split into decision_* / not_approved_unknown below).
      return result.response.approved
        ? { outcome: "approved", confirmationNumber: result.response.confirmation_number }
        : { outcome: "not_approved_unknown", confirmationNumber: result.response.confirmation_number, message: result.response.message };
    case "decision_required":
      return { outcome: "decision_required", code: result.code, confirmationNumber: result.confirmationNumber, message: result.message };
    case "decision_already_reported":
      return { outcome: "decision_already_reported", code: result.code, confirmationNumber: result.confirmationNumber, message: result.message };
    case "not_approved_unknown":
      return { outcome: "not_approved_unknown", confirmationNumber: result.confirmationNumber, message: result.message };
    case "validation_error":
      return { outcome: "authority_validation_failed", errors: result.response.message.errors };
    case "not_acceptable":
      return {
        outcome: "not_acceptable",
        errorId: result.response.error_id,
        message: result.response.message,
      };
    case "server_error":
      return { outcome: "infrastructure_failure", classification: result.classification, message: "Authority server error" };
    case "infrastructure_error":
      return { outcome: "infrastructure_failure", classification: result.classification, message: result.message };
    default: {
      // Exhaustiveness guard — all ApprovalClientResult kinds are handled above.
      const _never: never = result;
      return _never;
    }
  }
}

/**
 * Orchestrates a single allocation attempt.
 *
 * Build fails → returns local_validation_failed WITHOUT calling the client.
 * Build succeeds → calls the client once and maps its result to a domain
 * outcome. The client is not expected to throw, but a defensive catch maps any
 * throw to an infrastructure failure.
 */
export async function requestInvoiceApproval(
  input: RequestInvoiceApprovalInput,
  deps: ApprovalOrchestratorDeps = defaultApprovalOrchestratorDeps
): Promise<ApprovalDomainResult> {
  const built = deps.buildPayload({
    snapshot: input.snapshot,
    customerTaxId: input.customerTaxId,
    accountingSoftwareNumber: input.accountingSoftwareNumber,
    operatorUserName: input.operatorUserName,
  });

  if (!built.ok) {
    return { outcome: "local_validation_failed", errors: built.errors };
  }

  let clientResult: ApprovalClientResult;
  try {
    clientResult = await deps.sendApproval({
      accessToken: input.accessToken,
      payload: built.payload,
      config: input.config,
    });
  } catch {
    return {
      outcome: "infrastructure_failure",
      classification: "UNKNOWN",
      message: "Approval client threw unexpectedly",
    };
  }

  return mapClientResultToDomain(clientResult);
}
