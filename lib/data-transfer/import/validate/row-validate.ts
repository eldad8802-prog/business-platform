/**
 * One spreadsheet row -> would Dubiz accept it, and as what?
 *
 * # Where the rules come from
 *
 * Nowhere new. Every rule is the domain's own, reached through the pure cores:
 *
 *   Customers   customer-core        normalizeCustomerName / OptionalText + limits
 *   Leads       lead-core            LEAD_*_MAX and the same email shape
 *   Suppliers   supplier-profile     isPlausibleSupplierTaxId, tax-id/payment parsers
 *   Inventory   inventory-core       assertInventoryItemName, unit vocabulary
 *   phone       normalizeCustomerPhone — the same canonicalizer every write uses
 *
 * Restating "a customer needs a name, max 200 chars" here would be a shadow
 * business rule: it would look right, and it would drift the first time the
 * service changed.
 *
 * # Three row states, and what separates them
 *
 *   ERROR    cannot be imported as written — a required field is empty, or a
 *            value is unreadable.
 *   WARNING  importable, but the owner has a decision to make. In I-5 that is
 *            always a possible duplicate; duplicates are attached later, by the
 *            duplicate detector, so this module never invents one.
 *   READY    passes validation with nothing outstanding.
 *
 * Nothing here writes, queries, or opens a transaction.
 */

import type { DataTransferDomainId } from "@/lib/data-transfer/domains";
import type { DomainFieldSpec } from "@/lib/data-transfer/domain-fields";
import { importableFields } from "@/lib/data-transfer/domain-fields";
import {
  CUSTOMER_CITY_MAX,
  CUSTOMER_EMAIL_MAX,
  CUSTOMER_NAME_MAX,
  CUSTOMER_NOTES_MAX,
} from "@/lib/services/crm/customer-core";
import {
  LEAD_EMAIL_MAX,
  LEAD_INTENT_MAX,
  LEAD_NAME_MAX,
  LEAD_SOURCE_MAX,
} from "@/lib/services/crm/lead-core";
import {
  SUPPLIER_PAYMENT_METHOD_LABELS,
  SUPPLIER_PAYMENT_TERMS_MAX_DAYS,
  isPlausibleSupplierTaxId,
} from "@/lib/services/inventory/supplier-profile";
import { CUSTOMER_TAX_ID_TYPE_LABELS } from "@/lib/billing/customer-tax-identity";
import type { ResolvedMapping } from "@/lib/data-transfer/import/mapping/mapping-proposer";
import {
  cellText,
  isBlank,
  normalizeEmail,
  normalizeEnum,
  normalizeNonNegativeInteger,
  normalizeNonNegativeNumber,
  normalizePhone,
  normalizeText,
  type NormalizeResult,
} from "@/lib/data-transfer/import/normalize/value-normalize";

export type RowStatus = "READY" | "WARNING" | "ERROR";

export type FieldIssue = {
  field: string;
  reason: string;
  original: string;
};

/** What one field became, kept as a pair so the preview can show the change. */
export type FieldValue = {
  field: string;
  original: string;
  /** What Dubiz would store, rendered for display. */
  normalized: string;
  /** True when normalization changed the value — worth surfacing. */
  changed: boolean;
};

export type ValidatedRow = {
  /** 1-based row number in the SOURCE file, header excluded. */
  rowNumber: number;
  status: RowStatus;
  errors: FieldIssue[];
  values: FieldValue[];
  /** Canonical values, keyed by field label. Used for duplicate detection. */
  canonical: Record<string, string | number | null>;
};

const TEXT_MAX: Record<string, Record<string, number>> = {
  customers: {
    שם: CUSTOMER_NAME_MAX,
    אימייל: CUSTOMER_EMAIL_MAX,
    עיר: CUSTOMER_CITY_MAX,
    הערות: CUSTOMER_NOTES_MAX,
  },
  leads: {
    שם: LEAD_NAME_MAX,
    אימייל: LEAD_EMAIL_MAX,
    "מקור הפנייה": LEAD_SOURCE_MAX,
    "מה ביקשו": LEAD_INTENT_MAX,
  },
};

/** Generic bound for supplier/inventory free text — the services' own limit. */
const SUPPLIER_TEXT_MAX = 200;
const SUPPLIER_NOTES_MAX = 5000;
const INVENTORY_TEXT_MAX = 200;

function maxFor(domainId: DataTransferDomainId, field: string): number {
  const domain = TEXT_MAX[domainId];
  if (domain && domain[field] !== undefined) return domain[field];
  if (domainId === "suppliers") {
    return field === "הערות" ? SUPPLIER_NOTES_MAX : SUPPLIER_TEXT_MAX;
  }
  return INVENTORY_TEXT_MAX;
}

/** Route one field to its normalizer. Domain-aware, table-driven, no guessing. */
function normalizeField(
  domainId: DataTransferDomainId,
  field: DomainFieldSpec,
  cell: unknown
): NormalizeResult<string | number | null> {
  const label = field.header;

  if (label.includes("טלפון")) return normalizePhone(cell);
  if (label.includes("אימייל")) {
    return normalizeEmail(cell, maxFor(domainId, label));
  }

  if (field.allowedValues) {
    return normalizeEnum(cell, field.allowedValues);
  }

  if (domainId === "suppliers") {
    if (label === "אמצעי תשלום מועדף") {
      return normalizeEnum(cell, Object.values(SUPPLIER_PAYMENT_METHOD_LABELS));
    }
    if (label === "סוג עוסק") {
      return normalizeEnum(cell, Object.values(CUSTOMER_TAX_ID_TYPE_LABELS));
    }
    if (label === "מספר עוסק / ח.פ.") {
      const original = cellText(cell);
      if (original === "") {
        return { ok: true, value: null, original, display: "" };
      }
      if (!isPlausibleSupplierTaxId(original)) {
        return { ok: false, original, reason: "מספר עוסק / ח.פ. לא תקין" };
      }
      const digits = original.replace(/\D/g, "");
      return { ok: true, value: digits, original, display: digits };
    }
    if (label === "ימי תשלום" || label === "ימי אספקה") {
      const result = normalizeNonNegativeInteger(cell);
      if (
        result.ok &&
        typeof result.value === "number" &&
        result.value > SUPPLIER_PAYMENT_TERMS_MAX_DAYS
      ) {
        return {
          ok: false,
          original: result.original,
          reason: `עד ${SUPPLIER_PAYMENT_TERMS_MAX_DAYS} ימים`,
        };
      }
      return result;
    }
  }

  if (field.type === "integer") return normalizeNonNegativeInteger(cell);
  if (field.type === "currency" || field.type === "number") {
    // Quantities and money are never negative in an import.
    return normalizeNonNegativeNumber(cell);
  }
  if (field.type === "date" || field.type === "datetime") {
    // Unreachable today: no importable field is a date. Refused rather than
    // half-parsed, so adding one forces a deliberate decision (and I-5's
    // template note about date format goes with it).
    return {
      ok: false,
      original: cellText(cell),
      reason: "שדות תאריך אינם נתמכים בייבוא כרגע",
    };
  }

  return normalizeText(cell, maxFor(domainId, label));
}

export type ValidateRowsInput = {
  domainId: DataTransferDomainId;
  fields: readonly DomainFieldSpec[];
  mapping: ResolvedMapping;
  rows: readonly (readonly unknown[])[];
};

/** Validate every mapped row. Pure: no DB, no tenant context, no writes. */
export function validateRows(input: ValidateRowsInput): ValidatedRow[] {
  const importable = importableFields(input.fields);

  // Field label -> source column index, from the owner's finalized mapping.
  const columnOf = new Map<string, number>();
  for (const [rawIndex, label] of Object.entries(input.mapping)) {
    columnOf.set(label, Number(rawIndex));
  }

  const out: ValidatedRow[] = [];

  input.rows.forEach((row, index) => {
    // A row with nothing in any mapped column is not a record — it is the blank
    // line at the end of a spreadsheet, and reporting it as an error would bury
    // the real problems.
    const hasAnyValue = [...columnOf.values()].some((c) => !isBlank(row[c]));
    if (!hasAnyValue) return;

    const errors: FieldIssue[] = [];
    const values: FieldValue[] = [];
    const canonical: Record<string, string | number | null> = {};

    for (const field of importable) {
      const column = columnOf.get(field.header);
      const cell = column === undefined ? null : row[column];

      if (field.required && isBlank(cell)) {
        errors.push({
          field: field.header,
          reason: "שדה חובה חסר",
          original: "",
        });
        canonical[field.header] = null;
        continue;
      }

      if (column === undefined) {
        canonical[field.header] = null;
        continue;
      }

      const result = normalizeField(input.domainId, field, cell);
      if (!result.ok) {
        errors.push({
          field: field.header,
          reason: result.reason,
          original: result.original,
        });
        canonical[field.header] = null;
        continue;
      }

      canonical[field.header] = result.value;
      if (result.original !== "") {
        values.push({
          field: field.header,
          original: result.original,
          normalized: result.display,
          changed: result.display !== result.original,
        });
      }
    }

    out.push({
      rowNumber: index + 1,
      status: errors.length > 0 ? "ERROR" : "READY",
      errors,
      values,
      canonical,
    });
  });

  return out;
}
