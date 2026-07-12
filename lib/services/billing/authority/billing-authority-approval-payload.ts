/**
 * Deterministic, pure builder for the ITA "Invoices in Israel" allocation
 * request (POST /Invoices/v2/Approval).
 *
 * PURE — no I/O, no DB, no env, no network, no Date.now(), no randomness. Every
 * value is derived from the explicit input. The frozen issued snapshot is the
 * primary data source; the two values it cannot carry (customer tax id, which
 * the snapshot stores as null, and the software registration number, which is
 * config) are passed in explicitly.
 *
 * This module intentionally defines a DEDICATED document-type → HsbSug code map
 * for the allocation module. It does NOT reuse the uniform-file (appendix-1)
 * map, even where values coincide, because the two contexts are distinct.
 */

import { BillingDocumentType, Prisma } from "@prisma/client";
import { dateKeyJerusalem } from "@/lib/utils/jerusalem-month-range";
import type { BillingIssuedSnapshotV1 } from "@/lib/services/billing/pdf/billing-pdf-template";
import type {
  InvoiceApprovalItem,
  InvoiceApprovalRequest,
} from "@/lib/services/billing/authority/billing-authority-approval.types";

/**
 * Dubiz document type → ITA allocation HsbSug code (ACTIVE domain mapping).
 *
 * Any type absent here resolves to `undefined` and is rejected by the builder
 * as UNSUPPORTED_DOCUMENT_TYPE.
 *
 * CREDIT_NOTE (code 330) is deliberately EXCLUDED. 330 is a valid OpenAPI
 * invoice_type value, but activating it is blocked pending evidence:
 *  - The official מע"מ 01/2025 instruction does not mention credit notes /
 *    זיכוי / 330 at all — it addresses חשבונית מס only.
 *  - The supplied OpenAPI facts list 330 as a code but do not establish that a
 *    credit note requires an allocation request, nor the header-amount sign
 *    (`minimum`) rules for a credit payload.
 *  - Dubiz stores credit-note amounts as POSITIVE and its (currently unwired)
 *    readiness returns NOT_REQUIRED for CREDIT_NOTE.
 * Until a regulatory + contract decision, credit notes are not submitted here.
 * readiness.ts is intentionally left unchanged.
 */
export const APPROVAL_DOCUMENT_TYPE_CODE: Readonly<Record<string, number>> = {
  [BillingDocumentType.TAX_INVOICE]: 305,
  [BillingDocumentType.TAX_INVOICE_RECEIPT]: 320,
};

export const MAX_INVOICE_ID_LENGTH = 50;
export const MAX_DOCUMENT_NUMBER_LENGTH = 20;
export const MAX_ITEM_DESCRIPTION_LENGTH = 30;

const MONEY_DECIMAL_PLACES = 2;
const QUANTITY_DECIMAL_PLACES = 4;
// The exact numeric range for money is NOT documented in the supplied contract
// facts; guard only against float-unsafe magnitudes (flagged in PR report).
const MAX_SAFE_ABS_AMOUNT = 9_999_999_999.99;

export type ApprovalPayloadErrorCode =
  | "UNSUPPORTED_DOCUMENT_TYPE"
  | "MISSING_DOCUMENT_NUMBER"
  | "DOCUMENT_NUMBER_TOO_LONG"
  | "INVALID_INVOICE_ID"
  | "INVALID_ISSUER_VAT_NUMBER"
  | "MISSING_CUSTOMER_VAT_NUMBER"
  | "INVALID_CUSTOMER_VAT_NUMBER"
  | "MISSING_ACCOUNTING_SOFTWARE_NUMBER"
  | "INVALID_ACCOUNTING_SOFTWARE_NUMBER"
  | "DESCRIPTION_TOO_LONG"
  | "INVALID_AMOUNT_VALUE"
  | "INVALID_AMOUNT_RELATION"
  | "INVALID_DOCUMENT_DATE";

export type ApprovalPayloadValidationError = {
  code: ApprovalPayloadErrorCode;
  field: string;
  message: string;
};

export type ApprovalPayloadBuildResult =
  | { ok: true; payload: InvoiceApprovalRequest }
  | { ok: false; errors: ApprovalPayloadValidationError[] };

export type BuildInvoiceApprovalPayloadInput = {
  /** Frozen legal snapshot produced at issue time — the primary data source. */
  snapshot: BillingIssuedSnapshotV1;
  /**
   * Customer VAT / tax id. Required by the contract but absent from the frozen
   * snapshot (stored there as null), so it is passed in explicitly. The
   * snapshot data gap is NOT resolved here.
   */
  customerTaxId: string | null;
  /**
   * Software registration number, sourced from BillingAuthorityApp config by
   * the caller. Passed in explicitly; never defaulted or invented here.
   */
  accountingSoftwareNumber: string | number | null;
};

function err(
  code: ApprovalPayloadErrorCode,
  field: string,
  message: string
): ApprovalPayloadValidationError {
  return { code, field, message };
}

/** Strict digits-only integer parse: rejects any non-digit content (no silent parseInt). */
function parseStrictDigits(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || !/^[0-9]+$/.test(trimmed)) {
    return null;
  }
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}

/** Parse a fixed-scale decimal string into a contract number, or push an error. */
function decimalToNumber(
  raw: string,
  field: string,
  maxDecimalPlaces: number,
  errors: ApprovalPayloadValidationError[]
): number | null {
  let d: Prisma.Decimal;
  try {
    d = new Prisma.Decimal(raw);
  } catch {
    errors.push(err("INVALID_AMOUNT_VALUE", field, `Not a valid decimal: "${raw}"`));
    return null;
  }
  if (!d.isFinite()) {
    errors.push(err("INVALID_AMOUNT_VALUE", field, `Non-finite amount: "${raw}"`));
    return null;
  }
  if (d.decimalPlaces() > maxDecimalPlaces) {
    errors.push(
      err(
        "INVALID_AMOUNT_VALUE",
        field,
        `More than ${maxDecimalPlaces} decimal places: "${raw}"`
      )
    );
    return null;
  }
  const n = d.toNumber();
  if (!Number.isFinite(n) || Math.abs(n) > MAX_SAFE_ABS_AMOUNT) {
    errors.push(err("INVALID_AMOUNT_VALUE", field, `Amount out of safe range: "${raw}"`));
    return null;
  }
  return n;
}

function buildItems(
  snapshot: BillingIssuedSnapshotV1,
  errors: ApprovalPayloadValidationError[]
): InvoiceApprovalItem[] {
  const items: InvoiceApprovalItem[] = [];
  for (const line of snapshot.lines) {
    const base = `items[${line.lineIndex}]`;
    const description = line.description ?? "";
    if (description.length > MAX_ITEM_DESCRIPTION_LENGTH) {
      errors.push(
        err(
          "DESCRIPTION_TOO_LONG",
          `${base}.description`,
          `Line description exceeds ${MAX_ITEM_DESCRIPTION_LENGTH} characters (${description.length})`
        )
      );
      continue;
    }

    const quantity = decimalToNumber(line.quantity, `${base}.quantity`, QUANTITY_DECIMAL_PLACES, errors);
    const pricePerUnit = decimalToNumber(line.unitPrice, `${base}.price_per_unit`, QUANTITY_DECIMAL_PLACES, errors);
    const totalAmount = decimalToNumber(line.lineSubtotal, `${base}.total_amount`, MONEY_DECIMAL_PLACES, errors);
    const vatRate = decimalToNumber(line.vatRatePercent, `${base}.vat_rate`, MONEY_DECIMAL_PLACES, errors);
    const vatAmount = decimalToNumber(line.vatAmount, `${base}.vat_amount`, MONEY_DECIMAL_PLACES, errors);

    if (
      quantity === null ||
      pricePerUnit === null ||
      totalAmount === null ||
      vatRate === null ||
      vatAmount === null
    ) {
      continue;
    }

    items.push({
      index: line.lineIndex,
      description,
      quantity,
      price_per_unit: pricePerUnit,
      // No document/line discount exists in the Dubiz domain → factual 0.
      discount: 0,
      total_amount: totalAmount,
      vat_rate: vatRate,
      vat_amount: vatAmount,
    });
  }
  return items;
}

/**
 * Builds the approval request payload from the frozen snapshot + explicit
 * inputs. Returns a discriminated result; never throws for validation issues.
 */
export function buildInvoiceApprovalPayload(
  input: BuildInvoiceApprovalPayloadInput
): ApprovalPayloadBuildResult {
  const { snapshot } = input;
  const errors: ApprovalPayloadValidationError[] = [];

  // ---- invoice_type (HsbSug) ----
  const invoiceType = APPROVAL_DOCUMENT_TYPE_CODE[snapshot.document.type];
  if (invoiceType === undefined) {
    errors.push(
      err(
        "UNSUPPORTED_DOCUMENT_TYPE",
        "invoice_type",
        `Document type "${snapshot.document.type}" is not mapped for allocation`
      )
    );
  }

  // ---- invoice_id = String(BillingDocument.id) (stable, retry-safe, reusable by Decision API) ----
  const invoiceId = String(snapshot.document.id);
  if (invoiceId.length === 0 || invoiceId.length > MAX_INVOICE_ID_LENGTH) {
    errors.push(
      err("INVALID_INVOICE_ID", "invoice_id", `invoice_id length invalid (${invoiceId.length})`)
    );
  }

  // ---- invoice_reference_number = documentNumberFormatted (assigned at issue) ----
  const referenceNumber = (snapshot.document.numberFormatted ?? "").trim();
  if (referenceNumber.length === 0) {
    errors.push(
      err("MISSING_DOCUMENT_NUMBER", "invoice_reference_number", "Document number is not assigned yet")
    );
  } else if (referenceNumber.length > MAX_DOCUMENT_NUMBER_LENGTH) {
    errors.push(
      err(
        "DOCUMENT_NUMBER_TOO_LONG",
        "invoice_reference_number",
        `Document number exceeds ${MAX_DOCUMENT_NUMBER_LENGTH} characters`
      )
    );
  }

  // ---- vat_number (issuer) from the identity-gated snapshot issuer.taxId ----
  const issuerVat = parseStrictDigits(snapshot.issuer.taxId ?? "");
  if (issuerVat === null) {
    errors.push(
      err("INVALID_ISSUER_VAT_NUMBER", "vat_number", "Issuer VAT/tax id is missing or not digits-only")
    );
  }

  // ---- customer_vat_number (required by contract; explicit input) ----
  const customerRaw = (input.customerTaxId ?? "").trim();
  let customerVat: number | null = null;
  if (customerRaw.length === 0) {
    errors.push(err("MISSING_CUSTOMER_VAT_NUMBER", "customer_vat_number", "Customer VAT/tax id is required"));
  } else {
    customerVat = parseStrictDigits(customerRaw);
    if (customerVat === null) {
      errors.push(
        err("INVALID_CUSTOMER_VAT_NUMBER", "customer_vat_number", "Customer VAT/tax id is not digits-only")
      );
    }
  }

  // ---- accounting_software_number (explicit config input; never invented) ----
  let softwareNumber: number | null = null;
  const rawSoftware = input.accountingSoftwareNumber;
  if (rawSoftware === null || rawSoftware === undefined || String(rawSoftware).trim().length === 0) {
    errors.push(
      err("MISSING_ACCOUNTING_SOFTWARE_NUMBER", "accounting_software_number", "Software registration number is required")
    );
  } else if (typeof rawSoftware === "number") {
    softwareNumber = Number.isInteger(rawSoftware) && rawSoftware > 0 ? rawSoftware : null;
    if (softwareNumber === null) {
      errors.push(
        err("INVALID_ACCOUNTING_SOFTWARE_NUMBER", "accounting_software_number", "Software number must be a positive integer")
      );
    }
  } else {
    softwareNumber = parseStrictDigits(rawSoftware);
    if (softwareNumber === null) {
      errors.push(
        err("INVALID_ACCOUNTING_SOFTWARE_NUMBER", "accounting_software_number", "Software number is not a digits-only integer")
      );
    }
  }

  // ---- dates: single domain date (issuedAt) → both fields, Asia/Jerusalem ----
  const issuedAtDate = new Date(snapshot.issuedAt);
  let invoiceDate: string | null = null;
  if (Number.isNaN(issuedAtDate.getTime())) {
    errors.push(err("INVALID_DOCUMENT_DATE", "invoice_date", `Invalid issuedAt: "${snapshot.issuedAt}"`));
  } else {
    invoiceDate = dateKeyJerusalem(issuedAtDate);
  }

  // ---- amounts (no document discount exists in the domain) ----
  // Relation invariants are checked with Decimal (never floating point).
  let amountBeforeDiscount: number | null = null;
  let paymentAmount: number | null = null;
  let vatAmountNum: number | null = null;
  let paymentInclVatNum: number | null = null;
  const discount = 0;

  let subtotalD: Prisma.Decimal | null = null;
  let vatD: Prisma.Decimal | null = null;
  let totalD: Prisma.Decimal | null = null;
  try {
    subtotalD = new Prisma.Decimal(snapshot.totals.subtotal);
    vatD = new Prisma.Decimal(snapshot.totals.vat);
    totalD = new Prisma.Decimal(snapshot.totals.total);
  } catch {
    errors.push(err("INVALID_AMOUNT_VALUE", "totals", "Snapshot totals are not valid decimals"));
  }

  if (subtotalD && vatD && totalD) {
    const discountD = new Prisma.Decimal(0);
    const paymentD = subtotalD.minus(discountD); // = subtotal (no discount)
    const paymentInclVatD = paymentD.plus(vatD);
    // amount_before_discount - discount = payment_amount  &&
    // payment_amount + vat_amount = payment_amount_including_vat (== snapshot total)
    if (!paymentInclVatD.equals(totalD)) {
      errors.push(
        err(
          "INVALID_AMOUNT_RELATION",
          "payment_amount_including_vat",
          "subtotal + vat does not equal snapshot total"
        )
      );
    } else {
      amountBeforeDiscount = decimalToNumber(subtotalD.toFixed(2), "amount_before_discount", MONEY_DECIMAL_PLACES, errors);
      paymentAmount = decimalToNumber(paymentD.toFixed(2), "payment_amount", MONEY_DECIMAL_PLACES, errors);
      vatAmountNum = decimalToNumber(vatD.toFixed(2), "vat_amount", MONEY_DECIMAL_PLACES, errors);
      paymentInclVatNum = decimalToNumber(paymentInclVatD.toFixed(2), "payment_amount_including_vat", MONEY_DECIMAL_PLACES, errors);
    }
  }

  // ---- items (optional in the contract; Dubiz always has lines) ----
  const items = buildItems(snapshot, errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // All required locals are non-null here: any failure above pushed an error
  // and we returned. Assertions document that guarantee.
  const payload: InvoiceApprovalRequest = {
    invoice_id: invoiceId,
    invoice_type: invoiceType!,
    vat_number: issuerVat!,
    invoice_reference_number: referenceNumber,
    customer_vat_number: customerVat!,
    invoice_date: invoiceDate!,
    invoice_issuance_date: invoiceDate!,
    accounting_software_number: softwareNumber!,
    amount_before_discount: amountBeforeDiscount!,
    discount,
    payment_amount: paymentAmount!,
    vat_amount: vatAmountNum!,
    payment_amount_including_vat: paymentInclVatNum!,
  };

  const customerName = (snapshot.customer.name ?? "").trim();
  if (customerName.length > 0) {
    payload.customer_name = customerName;
  }

  const footerNote =
    typeof snapshot.extensions.billingFooterNote === "string"
      ? snapshot.extensions.billingFooterNote.trim()
      : "";
  if (footerNote.length > 0) {
    payload.invoice_note = footerNote;
  }

  if (items.length > 0) {
    payload.items = items;
  }

  return { ok: true, payload };
}
