/**
 * Contract types for the Israel Tax Authority ("Invoices in Israel") allocation
 * endpoint:
 *
 *   POST /Invoices/v2/Approval   (operationId: InvoiceApproval)
 *
 * PURE TYPE LAYER — no runtime, no I/O, no network. Field names mirror the
 * official OpenAPI contract verbatim (snake_case).
 *
 * Provenance / non-negotiables (evidence-first):
 * - `confirmation_number` is a nullable STRING and is NOT a 9-digit number.
 *   Do NOT add 9-digit validation anywhere against it.
 * - Scalar JSON types follow the supplied contract facts: identifier fields
 *   (vat_number, customer_vat_number, accounting_software_number) are
 *   integer/int32; money/VAT fields are number/double. Internal money math uses
 *   Prisma.Decimal; conversion to `number` happens only at the payload boundary.
 * - The 400 / 406 / 500 error body shapes below are the verified contract
 *   schemas (400 nests errors under `message.errors`; 406/500 carry `error_id`).
 */

/**
 * One invoice line inside the approval request (contract: InvoiceItem).
 *
 * The Dubiz payload builder populates only the fields that have a real domain
 * source. The contract's `catalog_id`, `category`, and
 * `measure_unit_description` are intentionally absent here because Dubiz has no
 * domain source for them at this stage — they are neither built nor sent.
 */
export type InvoiceApprovalItem = {
  index: number;
  description: string;
  quantity: number;
  price_per_unit: number;
  discount: number;
  total_amount: number;
  vat_rate: number;
  vat_amount: number;
};

/**
 * The approval request body (contract: InvoiceRequest).
 *
 * Required fields are always populated by the builder. Optional fields are
 * populated only when Dubiz has a real, non-placeholder source.
 */
export type InvoiceApprovalRequest = {
  // ---- required ----
  invoice_id: string;
  invoice_type: number;
  vat_number: number;
  invoice_reference_number: string;
  customer_vat_number: number;
  invoice_date: string;
  invoice_issuance_date: string;
  accounting_software_number: number;
  amount_before_discount: number;
  discount: number;
  payment_amount: number;
  vat_amount: number;
  payment_amount_including_vat: number;
  // ---- operator identity (§2.3 fields 6/7, CM) ----
  // "At least one of the fields ID or username must be entered." Dubiz has no ITA
  // Service-Operator national id (N9), so it sends user_name (A25) = the internal
  // user id of the operator performing the allocation (footnote 3: "Name/user
  // code (internal user ID) performing the actual allocation"). user_id (N9) is
  // left unset because no valid national operator id exists — never invented.
  user_id?: number;
  user_name?: string;
  // ---- optional (sent only when a real source exists) ----
  customer_name?: string;
  invoice_note?: string;
  items?: InvoiceApprovalItem[];
};

/** 200 — ResponseApproval. */
export type InvoiceApprovalSuccessResponse = {
  status: number;
  message: string;
  /** Nullable string per contract. NOT a 9-digit number. */
  confirmation_number: string | null;
  approved: boolean;
};

/** One error entry inside a 400 response's `message.errors` array. */
export type InvoiceApprovalValidationErrorDetail = {
  code: number;
  message: string;
  param: string;
  location: string;
};

/**
 * 400 — validation / business errors. `message` is an OBJECT that wraps the
 * `errors` array (not a plain string). `confirmation_number` may be "0".
 */
export type InvoiceApprovalValidationErrorResponse = {
  status: number;
  message: { errors: InvoiceApprovalValidationErrorDetail[] };
  confirmation_number: string | null;
  approved: boolean;
};

/** 406 — Not Acceptable. */
export type InvoiceApprovalNotAcceptableResponse = {
  status: number;
  message: string | null;
  error_id: string | null;
};

/** 500 — server error. */
export type InvoiceApprovalServerErrorResponse = {
  status: number;
  message: string | null;
  error_id: string | null;
};

/**
 * 200 with `approved:false` and `confirmation_number:"0"` — a NOT-approved
 * outcome. `message` is the SAME errors-object shape as a 400 (NOT a string),
 * but at HTTP 200. The business decision code lives in `message.errors[].code`
 * with `location:"approval"` (460/461 → decision required; 462 → already
 * reported). This is why `InvoiceApprovalSuccessResponse.message: string` alone
 * cannot represent a 200 response.
 */
export type InvoiceApprovalNotApprovedResponse = {
  status: number;
  message: { errors: InvoiceApprovalValidationErrorDetail[] };
  confirmation_number: string | null;
  approved: boolean;
};

/**
 * Type guard: true when a response `message` is the errors-object shape
 * (200-not-approved or 400), as opposed to a plain approved-string.
 */
export function hasInvoiceApprovalErrors(
  message: unknown
): message is { errors: InvoiceApprovalValidationErrorDetail[] } {
  return (
    typeof message === "object" &&
    message !== null &&
    Array.isArray((message as { errors?: unknown }).errors)
  );
}

/**
 * Union of the documented responses. 401 / 403 are NOT part of this union:
 * they are undocumented infrastructural outcomes to be handled defensively at
 * the (future) transport layer, not modeled as contract responses here.
 */
export type InvoiceApprovalResponse =
  | InvoiceApprovalSuccessResponse
  | InvoiceApprovalNotApprovedResponse
  | InvoiceApprovalValidationErrorResponse
  | InvoiceApprovalNotAcceptableResponse
  | InvoiceApprovalServerErrorResponse;
