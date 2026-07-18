/**
 * Pure builder for the shared Invoice-decision request DTO. No I/O.
 *
 * Field sources (never invented):
 * - invoice_id: String(BillingDocument.id) — same value the Approval request used.
 * - vat_number: issuer VAT (digits) from the frozen issued snapshot.
 * - accounting_software_number: software registration number (from config).
 * - authorized_company: CONDITIONAL — only when a canonical authorized-company id
 *   is supplied. There is no such source in the model today, so it is omitted
 *   unless provided. Never fabricated.
 * - user_id (N9) OR user_name (A25): prefer a valid operator national id; else the
 *   operator name (truncated to 25). If neither is available → validation error
 *   (no partial request is sent).
 */

import type {
  InvoiceDecisionRequest,
} from "@/lib/services/billing/authority/billing-authority-decision.types";

export type DecisionPayloadValidationError = {
  code: string;
  field: string;
  message: string;
};

export type BuildInvoiceDecisionPayloadInput = {
  billingDocumentId: number;
  /** Issuer VAT/tax id from the frozen snapshot (digits-only expected). */
  issuerVatNumber: string | null;
  /** Software registration number from runtime config. */
  accountingSoftwareNumber: string | number | null;
  /**
   * Operator national id (N9) if the system holds one for the service operator.
   * No such field exists in the User model today → normally null → user_name path.
   */
  operatorNationalId?: string | null;
  /** Operator name (the acting user's name, NOT the business name). */
  operatorName?: string | null;
  /**
   * Authorized-company id (N9), only when issuance is via a company / authorized
   * entity AND a canonical source provides it. Omitted (not sent) when absent.
   */
  authorizedCompany?: string | null;
};

export type DecisionPayloadBuildResult =
  | { ok: true; payload: InvoiceDecisionRequest }
  | { ok: false; errors: DecisionPayloadValidationError[] };

const MAX_INVOICE_ID_LEN = 19;
const USER_NAME_MAX = 25;

function err(code: string, field: string, message: string): DecisionPayloadValidationError {
  return { code, field, message };
}

/** Digits-only → positive integer, or null. No leading-sign, no decimals. */
function parseStrictDigits(value: string): number | null {
  const t = value.trim();
  if (t.length === 0 || !/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function parseN9(value: string): number | null {
  const t = value.trim();
  if (!/^\d{1,9}$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function buildInvoiceDecisionPayload(
  input: BuildInvoiceDecisionPayloadInput
): DecisionPayloadBuildResult {
  const errors: DecisionPayloadValidationError[] = [];

  const invoiceId = String(input.billingDocumentId);
  if (!/^\d+$/.test(invoiceId) || invoiceId.length > MAX_INVOICE_ID_LEN) {
    errors.push(err("INVALID_INVOICE_ID", "invoice_id", `invoice_id invalid (${invoiceId})`));
  }

  const vatNumber = parseStrictDigits(input.issuerVatNumber ?? "");
  if (vatNumber === null) {
    errors.push(err("INVALID_ISSUER_VAT_NUMBER", "vat_number", "Issuer VAT/tax id is missing or not digits-only"));
  }

  const softwareRaw = input.accountingSoftwareNumber;
  const softwareNumber =
    typeof softwareRaw === "number"
      ? (Number.isSafeInteger(softwareRaw) && softwareRaw > 0 ? softwareRaw : null)
      : parseStrictDigits(softwareRaw ?? "");
  if (softwareNumber === null) {
    errors.push(err("INVALID_ACCOUNTING_SOFTWARE_NUMBER", "accounting_software_number", "Software registration number is missing or invalid"));
  }

  // authorized_company — conditional. Only include when a valid N9 source is supplied.
  let authorizedCompany: number | undefined;
  if (input.authorizedCompany != null && input.authorizedCompany.trim().length > 0) {
    const ac = parseN9(input.authorizedCompany);
    if (ac === null) {
      errors.push(err("INVALID_AUTHORIZED_COMPANY", "authorized_company", "authorized_company must be a valid N9 number"));
    } else {
      authorizedCompany = ac;
    }
  }

  // user_id preferred (valid operator national id); else user_name; else error.
  let userId: number | undefined;
  let userName: string | undefined;
  const nationalId =
    input.operatorNationalId != null && input.operatorNationalId.trim().length > 0
      ? parseN9(input.operatorNationalId)
      : null;
  if (nationalId !== null) {
    userId = nationalId;
  } else {
    const name = (input.operatorName ?? "").trim();
    if (name.length > 0) {
      userName = name.slice(0, USER_NAME_MAX);
    } else {
      errors.push(err("MISSING_OPERATOR_IDENTITY", "user_id", "Neither a valid operator id (N9) nor an operator name is available"));
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const payload: InvoiceDecisionRequest = {
    invoice_id: invoiceId,
    vat_number: vatNumber!,
    accounting_software_number: softwareNumber!,
  };
  if (authorizedCompany !== undefined) payload.authorized_company = authorizedCompany;
  if (userId !== undefined) payload.user_id = userId;
  if (userName !== undefined) payload.user_name = userName;

  return { ok: true, payload };
}
