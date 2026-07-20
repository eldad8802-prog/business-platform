/**
 * Contract types for the ITA "Invoice decision" endpoints (exit from HELD):
 *
 *   POST /InvoiceDecisionApi/v1/Cancel
 *   POST /InvoiceDecisionApi/v1/Continue
 *   POST /InvoiceDecisionApi/v1/FurtherObjection
 *
 * Source: official ITA "מודל חשבוניות ישראל – תיאור ה-API's", 2.0/7.2024, §4.2.
 * PURE TYPE LAYER — no runtime, no I/O. Field names mirror the contract verbatim
 * (snake_case). Distinct base segment (`InvoiceDecisionApi`) and version (`v1`)
 * from the Approval endpoint (`/Invoices/v2/Approval`) — do NOT share the URL.
 *
 * Not-guessed provenance:
 * - Success is HTTP 200 with body `{ status: 200, message: "Decision accepted" }`.
 *   There is NO confirmation_number in a decision response.
 * - 462 = a decision was already reported for this invoice.
 * - 463 = no matching unapproved invoice found.
 *   The contract does not state whether 462/463 arrive as the HTTP status or as
 *   a `status` field in the body, so the parser accepts EITHER (documented).
 */

/** The three documented decision actions (path segment, PascalCase per contract). */
export const INVOICE_DECISION_ACTIONS = ["Cancel", "Continue", "FurtherObjection"] as const;
export type InvoiceDecisionAction = (typeof INVOICE_DECISION_ACTIONS)[number];

/**
 * Shared request body for all three decisions.
 *
 * - invoice_id: String(BillingDocument.id) — the same value the Approval request
 *   used (stable, retry-safe).
 * - vat_number: issuer VAT (N9), digits-only, from the frozen issued snapshot.
 * - accounting_software_number: software registration number (from config).
 * - authorized_company (N9): CONDITIONAL — sent only when issuance is performed
 *   via a company / authorized entity. There is no canonical source for it in the
 *   model, so it is omitted unless a source is supplied (never invented).
 * - user_id (N9) OR user_name (A25): at least one is required. Prefer user_id when
 *   a valid operator national id exists; otherwise user_name.
 */
export type InvoiceDecisionRequest = {
  invoice_id: string;
  vat_number: number;
  accounting_software_number: number;
  authorized_company?: number;
  user_id?: number;
  user_name?: string;
};

/** 200 — a decision was accepted. No confirmation_number in a decision response. */
export type InvoiceDecisionSuccessResponse = {
  status: number;
  message: string;
};

/** Type guard: a well-formed decision response envelope. */
export function isInvoiceDecisionResponse(
  body: unknown
): body is { status: number; message?: unknown } {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { status?: unknown }).status === "number"
  );
}
