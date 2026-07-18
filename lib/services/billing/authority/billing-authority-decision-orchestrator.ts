/**
 * Invoice-decision Orchestrator — the one layer that knows BOTH the DTO builder
 * and the HTTP client. It builds the payload, (on success) sends ONE decision,
 * and maps the client result to a DOMAIN result. No persistence, no audit, no
 * state transitions, no retry, no Prisma. Dependencies are injected.
 *
 * HTTP status codes are never exposed upward — callers see domain outcomes.
 */

import {
  buildInvoiceDecisionPayload,
  type BuildInvoiceDecisionPayloadInput,
  type DecisionPayloadBuildResult,
  type DecisionPayloadValidationError,
} from "@/lib/services/billing/authority/billing-authority-decision-payload";
import {
  sendInvoiceDecision,
  type SendInvoiceDecisionInput,
} from "@/lib/services/billing/authority/billing-authority-decision-client";
import type { AuthorityDecisionConfig } from "@/lib/services/billing/authority/billing-authority-decision-client.config";
import type {
  DecisionClientErrorClass,
  DecisionClientResult,
} from "@/lib/services/billing/authority/billing-authority-decision-client.types";
import type { InvoiceDecisionAction } from "@/lib/services/billing/authority/billing-authority-decision.types";

export type RequestInvoiceDecisionInput = {
  action: InvoiceDecisionAction;
  payloadInput: BuildInvoiceDecisionPayloadInput;
  accessToken: string;
  config: AuthorityDecisionConfig;
};

export type DecisionDomainResult =
  | { outcome: "accepted"; message: string | null }
  | { outcome: "already_reported"; code: number; message: string | null }
  | { outcome: "no_matching_invoice"; code: number; message: string | null }
  | { outcome: "local_validation_failed"; errors: DecisionPayloadValidationError[] }
  | { outcome: "authority_validation_failed"; message: string | null }
  | { outcome: "infrastructure_failure"; classification: DecisionClientErrorClass; message: string };

export type DecisionOrchestratorDeps = {
  buildPayload: (input: BuildInvoiceDecisionPayloadInput) => DecisionPayloadBuildResult;
  sendDecision: (input: SendInvoiceDecisionInput) => Promise<DecisionClientResult>;
};

export const defaultDecisionOrchestratorDeps: DecisionOrchestratorDeps = {
  buildPayload: buildInvoiceDecisionPayload,
  sendDecision: sendInvoiceDecision,
};

function mapClientResultToDomain(result: DecisionClientResult): DecisionDomainResult {
  switch (result.kind) {
    case "accepted":
      return { outcome: "accepted", message: result.response.message };
    case "already_reported":
      return { outcome: "already_reported", code: result.code, message: result.message };
    case "no_matching_invoice":
      return { outcome: "no_matching_invoice", code: result.code, message: result.message };
    case "validation_error":
      return { outcome: "authority_validation_failed", message: result.message };
    case "infrastructure_error":
      return { outcome: "infrastructure_failure", classification: result.classification, message: result.message };
    default: {
      const _never: never = result;
      return _never;
    }
  }
}

export async function requestInvoiceDecision(
  input: RequestInvoiceDecisionInput,
  deps: DecisionOrchestratorDeps = defaultDecisionOrchestratorDeps
): Promise<DecisionDomainResult> {
  const built = deps.buildPayload(input.payloadInput);
  if (!built.ok) {
    return { outcome: "local_validation_failed", errors: built.errors };
  }

  let clientResult: DecisionClientResult;
  try {
    clientResult = await deps.sendDecision({
      accessToken: input.accessToken,
      action: input.action,
      payload: built.payload,
      config: input.config,
    });
  } catch {
    return {
      outcome: "infrastructure_failure",
      classification: "UNKNOWN",
      message: "Decision client threw unexpectedly",
    };
  }

  return mapClientResultToDomain(clientResult);
}
