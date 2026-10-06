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

import {
  authorityEgressFetch,
  isAuthorityEgressError,
} from "@/lib/services/billing/authority/billing-authority-egress";
import {
  assessTransportFailure,
  sanitizeTransportCode,
} from "@/lib/services/billing/authority/billing-authority-send-certainty";
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
  /** Injectable for tests. Defaults to the ITA egress transport (never global fetch). */
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

  // Undocumented statuses (401/403/404/408/429/other) — infrastructural. A
  // status was received, so the request reached the authority's edge: nothing
  // in the contract proves it was not processed → POSSIBLY_SENT.
  return {
    kind: "infrastructure_error",
    httpStatus: status,
    classification: classifyHttpStatus(status),
    message: infraMessageForStatus(status),
    errorId: asStringOrNull(rec.error_id),
    failureKind: "HTTP_STATUS",
    sendCertainty: "POSSIBLY_SENT",
    transportCode: null,
  };
}

function preSendFailure(message: string): ApprovalClientResult {
  return {
    kind: "infrastructure_error",
    httpStatus: null,
    classification: "CONFIGURATION",
    message,
    errorId: null,
    failureKind: "PRE_SEND",
    sendCertainty: "NOT_SENT",
    transportCode: null,
  };
}

/**
 * Classifies a rejected fetch. Only an egress pre-I/O refusal or an
 * allowlisted connect-phase transport code proves NOT_SENT. Our own abort
 * (timeout) can fire after the body was written → always POSSIBLY_SENT.
 */
export function classifyTransportFailure(error: unknown): ApprovalClientResult {
  if (isAuthorityEgressError(error)) {
    // Thrown by the egress transport before any socket is opened.
    return {
      kind: "infrastructure_error",
      httpStatus: null,
      classification: "CONFIGURATION",
      message: "Authority egress refused the request before sending",
      errorId: null,
      failureKind: "TRANSPORT",
      sendCertainty: "NOT_SENT",
      transportCode: sanitizeTransportCode(error.code),
    };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return {
      kind: "infrastructure_error",
      httpStatus: null,
      classification: "TIMEOUT",
      message: "Approval request timed out",
      errorId: null,
      failureKind: "TRANSPORT",
      sendCertainty: "POSSIBLY_SENT",
      transportCode: null,
    };
  }
  const assessed = assessTransportFailure(error);
  return {
    kind: "infrastructure_error",
    httpStatus: null,
    classification: "NETWORK",
    message:
      assessed.sendCertainty === "NOT_SENT"
        ? "Approval request could not connect to the authority"
        : "Approval request failed after the connection may have carried it",
    errorId: null,
    failureKind: "TRANSPORT",
    sendCertainty: assessed.sendCertainty,
    transportCode: sanitizeTransportCode(assessed.transportCode),
  };
}

/**
 * Sends the approval request. Returns an explicit result; never throws for
 * HTTP/business outcomes. Every failure carries a `sendCertainty`: NOT_SENT is
 * returned only when the code can prove nothing was transmitted.
 *
 * The payload is sent EXACTLY as produced by the builder — no field is added,
 * removed, defaulted, or transformed.
 */
export async function sendInvoiceApproval(
  input: SendInvoiceApprovalInput
): Promise<ApprovalClientResult> {
  const fetchFn = input.fetchImpl ?? authorityEgressFetch;

  // ---- pre-send: nothing has been handed to the transport yet ----
  let url: string;
  let body: string;
  try {
    url = buildInvoiceApprovalUrl(input.config);
    body = JSON.stringify(input.payload);
  } catch {
    return preSendFailure("Approval request could not be constructed");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.config.timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetchFn(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      return classifyTransportFailure(error);
    }

    // A status line was received: from here on the request reached the
    // authority, so every failure is POSSIBLY_SENT.
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      return {
        kind: "infrastructure_error",
        httpStatus: response.status,
        classification: timedOut ? "TIMEOUT" : "NETWORK",
        message: "Approval response body could not be read",
        errorId: null,
        failureKind: "BODY_READ",
        sendCertainty: "POSSIBLY_SENT",
        transportCode: null,
      };
    }

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
          failureKind: "MALFORMED_BODY",
          sendCertainty: "POSSIBLY_SENT",
          transportCode: null,
        };
      }
    }

    return parseApprovalResponse(response.status, json);
  } finally {
    clearTimeout(timer);
  }
}
