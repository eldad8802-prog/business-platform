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
 * - Scalar JSON types for the amount fields follow the implementation
 *   instruction (numbers). The exact contract scalar (number vs string) for
 *   the money/VAT fields was not part of the supplied contract facts; see the
 *   PR report for this flagged assumption.
 * - The 400 / 406 / 500 error BODY shapes beyond `status` were not supplied at
 *   field level in the contract facts; the error types below are intentionally
 *   minimal and marked provisional. Do not treat them as a verified contract.
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

/**
 * A single validation/business error entry inside a 400 response.
 *
 * PROVISIONAL: the field-level schema of the 400 body was not supplied in the
 * contract facts. Fields are nullable/optional to avoid asserting an unverified
 * shape. Do not build local logic that depends on these being present.
 */
export type InvoiceApprovalValidationError = {
  error_code: string | null;
  error_id: string | null;
  message: string | null;
  parameters?: readonly string[];
};

/** 400 — validation / business errors (provisional shape, see above). */
export type InvoiceApprovalValidationErrorResponse = {
  status: number;
  message?: string | null;
  errors?: readonly InvoiceApprovalValidationError[];
  approved?: boolean;
};

/** 406 — Not Acceptable (body shape beyond status not supplied). */
export type InvoiceApprovalNotAcceptableResponse = {
  status: number;
  message?: string | null;
};

/** 500 — server error (body shape beyond status not supplied). */
export type InvoiceApprovalServerErrorResponse = {
  status: number;
  message?: string | null;
};

/**
 * Union of the documented responses. 401 / 403 are NOT part of this union:
 * they are undocumented infrastructural outcomes to be handled defensively at
 * the (future) transport layer, not modeled as contract responses here.
 */
export type InvoiceApprovalResponse =
  | InvoiceApprovalSuccessResponse
  | InvoiceApprovalValidationErrorResponse
  | InvoiceApprovalNotAcceptableResponse
  | InvoiceApprovalServerErrorResponse;
