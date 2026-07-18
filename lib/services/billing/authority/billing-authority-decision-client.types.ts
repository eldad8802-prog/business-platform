/**
 * Result union for the Invoice-decision HTTP client. Explicit outcomes — the
 * client never throws for HTTP/business results and never logs tokens/payload.
 */

import type { InvoiceDecisionSuccessResponse } from "@/lib/services/billing/authority/billing-authority-decision.types";

export type DecisionClientErrorClass =
  | "NETWORK"
  | "TIMEOUT"
  | "SERVER"
  | "AUTHENTICATION"
  | "AUTHORIZATION"
  | "BUSINESS_VALIDATION"
  | "UNKNOWN";

export type DecisionClientResult =
  /** HTTP 200 + body.status === 200 → the authority accepted the decision. */
  | { kind: "accepted"; httpStatus: number; response: InvoiceDecisionSuccessResponse }
  /** 462 — a decision was already reported for this invoice (no auto re-send). */
  | { kind: "already_reported"; httpStatus: number; code: number; message: string | null }
  /** 463 — no matching unapproved invoice found (no state change). */
  | { kind: "no_matching_invoice"; httpStatus: number; code: number; message: string | null }
  /** Documented business/validation rejection (e.g. 400) that is not 462/463. */
  | { kind: "validation_error"; httpStatus: number; classification: DecisionClientErrorClass; message: string | null }
  /** Transport / auth / server / invalid body — never a business decision. */
  | { kind: "infrastructure_error"; httpStatus: number | null; classification: DecisionClientErrorClass; message: string };
