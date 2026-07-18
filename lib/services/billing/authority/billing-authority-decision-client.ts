/**
 * ITA Invoice-decision HTTP client (Cancel / Continue / FurtherObjection) + parser.
 *
 * Responsibilities ONLY: URL build, POST, headers, timeout, (de)serialization,
 * parsing, classification. Knows nothing about BillingDocument, Prisma, DB, UI,
 * PDF, routes, or the state machine. Never throws for HTTP/business outcomes and
 * never logs tokens or the payload. Mirrors the Approval client's transport shape.
 */

import type {
  InvoiceDecisionAction,
  InvoiceDecisionRequest,
} from "@/lib/services/billing/authority/billing-authority-decision.types";
import { isInvoiceDecisionResponse } from "@/lib/services/billing/authority/billing-authority-decision.types";
import {
  buildInvoiceDecisionUrl,
  type AuthorityDecisionConfig,
} from "@/lib/services/billing/authority/billing-authority-decision-client.config";
import type {
  DecisionClientErrorClass,
  DecisionClientResult,
} from "@/lib/services/billing/authority/billing-authority-decision-client.types";

export type SendInvoiceDecisionInput = {
  accessToken: string;
  action: InvoiceDecisionAction;
  payload: InvoiceDecisionRequest;
  config: AuthorityDecisionConfig;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function classifyDecisionHttpStatus(status: number): DecisionClientErrorClass {
  switch (status) {
    case 400:
      return "BUSINESS_VALIDATION";
    case 401:
      return "AUTHENTICATION";
    case 403:
      return "AUTHORIZATION";
    case 408:
      return "TIMEOUT";
    case 429:
      return "NETWORK";
    default:
      if (status >= 500) return "SERVER";
      return "UNKNOWN";
  }
}

/**
 * Maps an HTTP status + parsed body to an explicit result. Pure.
 *
 * A decision is `accepted` ONLY when HTTP is 200 AND the body is a valid
 * decision envelope with `status === 200` (the message text is never the gate).
 * 462/463 may appear either as the HTTP status OR as the body `status` field
 * (the contract does not fix which), so both are checked — fail-closed otherwise.
 */
export function parseDecisionResponse(
  httpStatus: number,
  body: unknown
): DecisionClientResult {
  const rec = asRecord(body);
  const bodyStatus = typeof rec.status === "number" ? rec.status : null;
  const message = asStringOrNull(rec.message);
  // Effective business code: the body status wins when present, else the HTTP status.
  const effective = bodyStatus ?? httpStatus;

  if (httpStatus === 200 && isInvoiceDecisionResponse(body) && body.status === 200) {
    return {
      kind: "accepted",
      httpStatus,
      response: { status: 200, message: message ?? "" },
    };
  }

  if (effective === 462) {
    return { kind: "already_reported", httpStatus, code: 462, message };
  }
  if (effective === 463) {
    return { kind: "no_matching_invoice", httpStatus, code: 463, message };
  }

  if (httpStatus === 400 || effective === 400) {
    return {
      kind: "validation_error",
      httpStatus,
      classification: "BUSINESS_VALIDATION",
      message,
    };
  }

  // Auth / server / unknown → infrastructure (never a business decision).
  return {
    kind: "infrastructure_error",
    httpStatus,
    classification: classifyDecisionHttpStatus(httpStatus),
    message: message ?? `Unexpected decision response (${httpStatus})`,
  };
}

export async function sendInvoiceDecision(
  input: SendInvoiceDecisionInput
): Promise<DecisionClientResult> {
  const fetchFn = input.fetchImpl ?? fetch;
  const url = buildInvoiceDecisionUrl(input.config, input.action);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.config.timeoutMs);

  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(input.payload),
      signal: controller.signal,
    });

    const text = await response.text();
    let json: unknown = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        return {
          kind: "infrastructure_error",
          httpStatus: response.status,
          classification: classifyDecisionHttpStatus(response.status),
          message: "Response body was not valid JSON",
        };
      }
    }

    return parseDecisionResponse(response.status, json);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        kind: "infrastructure_error",
        httpStatus: null,
        classification: "TIMEOUT",
        message: "Decision request timed out",
      };
    }
    return {
      kind: "infrastructure_error",
      httpStatus: null,
      classification: "NETWORK",
      message: "Decision request failed to reach the authority",
    };
  } finally {
    clearTimeout(timer);
  }
}
