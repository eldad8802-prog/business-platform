/**
 * ITA allocation HTTP client (POST /Invoices/v2/Approval) + response parser.
 *
 * Responsibilities ONLY: URL build, POST, headers, timeout, (de)serialization,
 * parsing, classification. It knows nothing about BillingDocument, Prisma, DB,
 * UI, PDF, routes, state machine, or retry. It takes an access token + a
 * builder-produced payload + config, and returns an explicit result. It never
 * throws for HTTP/business outcomes and never logs tokens, payload, VAT numbers
 * or allocation numbers.
 */

import type { InvoiceApprovalRequest, InvoiceApprovalValidationErrorDetail } from "@/lib/services/billing/authority/billing-authority-approval.types";
import { hasInvoiceApprovalErrors } from "@/lib/services/billing/authority/billing-authority-approval.types";
import {
  buildInvoiceApprovalUrl,
  type AuthorityApprovalConfig,
} from "@/lib/services/billing/authority/billing-authority-approval-client.config";
import type {
  ApprovalClientErrorClass,
  ApprovalClientResult,
} from "@/lib/services/billing/authority/billing-authority-approval-client.types";

export type SendInvoiceApprovalInput = {
  accessToken: string;
  payload: InvoiceApprovalRequest;
  config: AuthorityApprovalConfig;
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

/** Buckets an HTTP status into a transport class. Never invents ITA codes. */
export function classifyHttpStatus(status: number): ApprovalClientErrorClass {
  switch (status) {
    case 400:
      return "BUSINESS_VALIDATION";
    case 401:
      return "AUTHENTICATION";
    case 403:
      return "AUTHORIZATION";
    case 404:
      return "UNKNOWN";
    case 406:
      // Documented business rejection of the request content.
      return "BUSINESS_VALIDATION";
    case 408:
      return "TIMEOUT";
    case 429:
      return "NETWORK";
    default:
      if (status >= 500) return "SERVER";
      return "UNKNOWN";
  }
}

function infraMessageForStatus(status: number): string {
  switch (status) {
    case 401:
      return "Unauthorized (401)";
    case 403:
      return "Forbidden (403)";
    case 404:
      return "Not found (404)";
    case 408:
      return "Request timeout (408)";
    case 429:
      return "Too many requests (429)";
    default:
      return `Unexpected HTTP status (${status})`;
  }
}

function parseValidationErrors(
  message: unknown
): InvoiceApprovalValidationErrorDetail[] {
  const arr = asRecord(message).errors;
  if (!Array.isArray(arr)) return [];
  return arr.map((raw) => {
    const e = asRecord(raw);
    const numericCode =
      typeof e.code === "number"
        ? e.code
        : Number.isFinite(Number(e.code))
          ? Number(e.code)
          : 0;
    return {
      code: numericCode,
      message: asStringOrNull(e.message) ?? "",
      param: asStringOrNull(e.param) ?? "",
      location: asStringOrNull(e.location) ?? "",
    };
  });
}

/** First error entry with the given `location`, or null. */
function firstApprovalError(
  message: unknown,
  location: string
): InvoiceApprovalValidationErrorDetail | null {
  if (!hasInvoiceApprovalErrors(message)) return null;
  return message.errors.find((e) => e.location === location) ?? null;
}

/**
 * Classifies a 200 + approved:false body. Only maps to a decision when a
 * verified approval-location error code (460/461/462) is present; otherwise
 * fail-closed to not_approved_unknown (never invents a decision).
 */
function classifyNotApproved(
  status: number,
  rec: Record<string, unknown>
): ApprovalClientResult {
  const confirmationNumber = asStringOrNull(rec.confirmation_number);
  const approvalError = firstApprovalError(rec.message, "approval");
  if (approvalError) {
    if (approvalError.code === 460 || approvalError.code === 461) {
      return {
        kind: "decision_required",
        httpStatus: status,
        classification: "BUSINESS_DECISION",
        code: approvalError.code,
        message: approvalError.message,
        confirmationNumber,
      };
    }
    if (approvalError.code === 462) {
      return {
        kind: "decision_already_reported",
        httpStatus: status,
        classification: "BUSINESS_DECISION",
        code: approvalError.code,
        message: approvalError.message,
        confirmationNumber,
      };
    }
  }
  return {
    kind: "not_approved_unknown",
    httpStatus: status,
    classification: "UNKNOWN",
    message: asStringOrNull(rec.message),
    confirmationNumber,
  };
}

/**
 * Maps an HTTP status + already-parsed JSON body to a typed result. Pure.
 * Documented statuses (200/400/406/5xx) become their contract responses;
 * anything else becomes an infrastructure_error with a transport class.
 */
export function parseApprovalResponse(
  status: number,
  body: unknown
): ApprovalClientResult {
  const rec = asRecord(body);

  if (status === 200) {
    if (rec.approved === true) {
      return {
        kind: "success",
        httpStatus: status,
        response: {
          status,
          message: asStringOrNull(rec.message) ?? "",
          confirmation_number: asStringOrNull(rec.confirmation_number),
          approved: true,
        },
      };
    }
    // 200 + approved:false → business decision (460/461/462) or unknown.
    return classifyNotApproved(status, rec);
  }

  if (status === 400) {
    return {
      kind: "validation_error",
      httpStatus: status,
      classification: "BUSINESS_VALIDATION",
      response: {
        status,
        message: { errors: parseValidationErrors(rec.message) },
        confirmation_number: asStringOrNull(rec.confirmation_number),
        approved: rec.approved === true,
      },
    };
  }

  if (status === 406) {
    return {
      kind: "not_acceptable",
      httpStatus: status,
      classification: "BUSINESS_VALIDATION",
      response: {
        status,
        message: asStringOrNull(rec.message),
        error_id: asStringOrNull(rec.error_id),
      },
    };
  }

  if (status >= 500) {
    return {
      kind: "server_error",
      httpStatus: status,
      classification: "SERVER",
      response: {
        status,
        message: asStringOrNull(rec.message),
        error_id: asStringOrNull(rec.error_id),
      },
    };
  }

  // Undocumented statuses (401/403/404/408/429/other) — infrastructural.
  return {
    kind: "infrastructure_error",
    httpStatus: status,
    classification: classifyHttpStatus(status),
    message: infraMessageForStatus(status),
    errorId: asStringOrNull(rec.error_id),
  };
}

/**
 * Sends the approval request. Returns an explicit result; never throws for
 * HTTP/business outcomes. Network failures and timeouts become
 * infrastructure_error results.
 *
 * The payload is sent EXACTLY as produced by the builder — no field is added,
 * removed, defaulted, or transformed.
 */
export async function sendInvoiceApproval(
  input: SendInvoiceApprovalInput
): Promise<ApprovalClientResult> {
  const fetchFn = input.fetchImpl ?? fetch;
  const url = buildInvoiceApprovalUrl(input.config);

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
          classification: classifyHttpStatus(response.status),
          message: "Response body was not valid JSON",
          errorId: null,
        };
      }
    }

    return parseApprovalResponse(response.status, json);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        kind: "infrastructure_error",
        httpStatus: null,
        classification: "TIMEOUT",
        message: "Approval request timed out",
        errorId: null,
      };
    }
    return {
      kind: "infrastructure_error",
      httpStatus: null,
      classification: "NETWORK",
      message: "Approval request failed to reach the authority",
      errorId: null,
    };
  } finally {
    clearTimeout(timer);
  }
}
