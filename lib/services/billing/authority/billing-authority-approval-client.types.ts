/**
 * Result + classification types for the ITA allocation HTTP client.
 *
 * The client NEVER throws for HTTP/business outcomes — it returns one of these
 * explicit results so a future Billing flow can decide what to do. Pure types.
 */

import type {
  InvoiceApprovalSuccessResponse,
  InvoiceApprovalValidationErrorResponse,
  InvoiceApprovalNotAcceptableResponse,
  InvoiceApprovalServerErrorResponse,
} from "@/lib/services/billing/authority/billing-authority-approval.types";

/**
 * Transport/outcome classification. This buckets outcomes only — it never
 * invents ITA business error codes.
 *
 * BUSINESS_DECISION is reserved: NO documented Approval response maps to it in
 * the current contract (the held-invoice / Decision-API signal is not part of
 * POST /Invoices/v2/Approval). It exists so callers can model that future case
 * without a later type change.
 */
export type ApprovalClientErrorClass =
  | "BUSINESS_VALIDATION"
  | "BUSINESS_DECISION"
  | "AUTHENTICATION"
  | "AUTHORIZATION"
  | "NETWORK"
  | "TIMEOUT"
  | "SERVER"
  | "UNKNOWN";

export type ApprovalClientResult =
  | {
      kind: "success";
      httpStatus: number;
      response: InvoiceApprovalSuccessResponse;
    }
  | {
      kind: "validation_error";
      httpStatus: number;
      classification: ApprovalClientErrorClass;
      response: InvoiceApprovalValidationErrorResponse;
    }
  | {
      kind: "not_acceptable";
      httpStatus: number;
      classification: ApprovalClientErrorClass;
      response: InvoiceApprovalNotAcceptableResponse;
    }
  | {
      kind: "server_error";
      httpStatus: number;
      classification: ApprovalClientErrorClass;
      response: InvoiceApprovalServerErrorResponse;
    }
  | {
      kind: "infrastructure_error";
      /** Present for undocumented HTTP statuses; null for network/timeout. */
      httpStatus: number | null;
      classification: ApprovalClientErrorClass;
      /** Sanitized, never contains tokens/payload/identifiers. */
      message: string;
      /** ITA `error_id` when the body carried one; otherwise null. */
      errorId: string | null;
    };
