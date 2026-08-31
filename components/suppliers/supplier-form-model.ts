/**
 * Supplier form — pure state model.
 *
 * Framework-free so the field rules can be unit-tested without a DOM, in the
 * same spirit as lib/inventory/supplier-purchase-history-view.ts.
 *
 * DESIGN RULE (fast creation + complete profile): only `name` is ever required.
 * Everything else is optional and lives behind a collapsed section, so opening a
 * supplier stays a ten-second job while the card can still hold everything the
 * owner needs to work with that supplier over time.
 */

import type { Supplier, UpdateSupplierInput } from "@/lib/api/suppliers";
import {
  isPlausibleEmail,
  isPlausiblePhone,
  isPlausibleSupplierTaxId,
  SUPPLIER_PAYMENT_TERMS_MAX_DAYS,
  type SupplierPaymentMethod,
  type SupplierTaxIdType,
} from "@/lib/services/inventory/supplier-profile";

export type SupplierFormState = {
  name: string;
  legalName: string;
  taxIdType: string;
  taxId: string;
  category: string;
  website: string;
  phone: string;
  email: string;
  contactName: string;
  contactRole: string;
  contactPhone: string;
  contactEmail: string;
  addressStreet: string;
  addressCity: string;
  addressPostalCode: string;
  paymentTermsDays: string;
  preferredPaymentMethod: string;
  defaultLeadTimeDays: string;
  notes: string;
  isActive: boolean;
};

export const EMPTY_SUPPLIER_FORM: SupplierFormState = {
  name: "",
  legalName: "",
  taxIdType: "",
  taxId: "",
  category: "",
  website: "",
  phone: "",
  email: "",
  contactName: "",
  contactRole: "",
  contactPhone: "",
  contactEmail: "",
  addressStreet: "",
  addressCity: "",
  addressPostalCode: "",
  paymentTermsDays: "",
  preferredPaymentMethod: "",
  defaultLeadTimeDays: "",
  notes: "",
  isActive: true,
};

export function supplierToFormState(supplier: Supplier): SupplierFormState {
  const s = (v: string | null | undefined) => v ?? "";
  const n = (v: number | null | undefined) => (v != null ? String(v) : "");

  return {
    name: supplier.name,
    legalName: s(supplier.legalName),
    taxIdType: s(supplier.taxIdType),
    taxId: s(supplier.taxId),
    category: s(supplier.category),
    website: s(supplier.website),
    phone: s(supplier.phone),
    email: s(supplier.email),
    contactName: s(supplier.contactName),
    contactRole: s(supplier.contactRole),
    contactPhone: s(supplier.contactPhone),
    contactEmail: s(supplier.contactEmail),
    addressStreet: s(supplier.addressStreet),
    addressCity: s(supplier.addressCity),
    addressPostalCode: s(supplier.addressPostalCode),
    paymentTermsDays: n(supplier.paymentTermsDays),
    preferredPaymentMethod: s(supplier.preferredPaymentMethod),
    defaultLeadTimeDays: n(supplier.defaultLeadTimeDays),
    notes: s(supplier.notes),
    isActive: supplier.isActive,
  };
}

/**
 * Client-side validation. Deliberately the SAME rules the service enforces, so
 * the owner is told about a bad value before a round trip — never instead of
 * one. The server stays the authority; this only saves a failed save.
 */
export function validateSupplierForm(
  form: SupplierFormState
): string | null {
  if (!form.name.trim()) return "יש להזין שם ספק";

  if (form.taxId.trim() && !isPlausibleSupplierTaxId(form.taxId)) {
    return "מספר העוסק / ח.פ. אינו תקין — נדרשות 8 או 9 ספרות";
  }
  if (form.email.trim() && !isPlausibleEmail(form.email)) {
    return "כתובת האימייל אינה תקינה";
  }
  if (form.contactEmail.trim() && !isPlausibleEmail(form.contactEmail)) {
    return "אימייל איש הקשר אינו תקין";
  }
  if (form.phone.trim() && !isPlausiblePhone(form.phone)) {
    return "מספר הטלפון אינו תקין";
  }
  if (form.contactPhone.trim() && !isPlausiblePhone(form.contactPhone)) {
    return "טלפון איש הקשר אינו תקין";
  }

  const terms = form.paymentTermsDays.trim();
  if (terms) {
    const parsed = Number(terms);
    if (
      !Number.isInteger(parsed) ||
      parsed < 0 ||
      parsed > SUPPLIER_PAYMENT_TERMS_MAX_DAYS
    ) {
      return `תנאי התשלום חייבים להיות מספר ימים שלם בין 0 ל-${SUPPLIER_PAYMENT_TERMS_MAX_DAYS}`;
    }
  }

  const lead = form.defaultLeadTimeDays.trim();
  if (lead) {
    const parsed = Number(lead);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return "זמן אספקה חייב להיות מספר שלם ואי-שלילי";
    }
  }

  return null;
}

function text(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function int(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * The full field set, always sent. Sending every field (rather than only the
 * changed ones) is what makes "clear a field" work at all: an omitted key means
 * "leave alone" on the server, so an omitted cleared field would silently keep
 * its old value and the owner would watch their edit reappear after a refresh.
 */
export function supplierFormToPayload(
  form: SupplierFormState
): UpdateSupplierInput & { name: string } {
  return {
    name: form.name.trim(),
    legalName: text(form.legalName),
    taxIdType: (text(form.taxIdType) as SupplierTaxIdType | null) ?? null,
    taxId: text(form.taxId),
    category: text(form.category),
    website: text(form.website),
    phone: text(form.phone),
    email: text(form.email),
    contactName: text(form.contactName),
    contactRole: text(form.contactRole),
    contactPhone: text(form.contactPhone),
    contactEmail: text(form.contactEmail),
    addressStreet: text(form.addressStreet),
    addressCity: text(form.addressCity),
    addressPostalCode: text(form.addressPostalCode),
    paymentTermsDays: int(form.paymentTermsDays),
    preferredPaymentMethod:
      (text(form.preferredPaymentMethod) as SupplierPaymentMethod | null) ??
      null,
    defaultLeadTimeDays: int(form.defaultLeadTimeDays),
    notes: text(form.notes),
    isActive: form.isActive,
  };
}

/**
 * How complete a supplier card is, as a fraction of the areas that actually
 * matter for working with a supplier over time. Used to nudge ("השלמת פרטי
 * ספק") without ever blocking, and to decide whether to show the nudge at all.
 */
export type SupplierCompleteness = {
  filled: number;
  total: number;
  missing: string[];
};

export function supplierCompleteness(
  supplier: Supplier
): SupplierCompleteness {
  const areas: Array<{ label: string; present: boolean }> = [
    {
      label: "מספר עוסק / ח.פ.",
      present: Boolean(supplier.taxId && supplier.taxIdType),
    },
    {
      label: "דרך יצירת קשר",
      present: Boolean(supplier.phone || supplier.email || supplier.contactPhone),
    },
    { label: "איש קשר", present: Boolean(supplier.contactName) },
    { label: "כתובת", present: Boolean(supplier.addressCity) },
    { label: "תנאי תשלום", present: supplier.paymentTermsDays != null },
    {
      label: "צורת תשלום",
      present: Boolean(supplier.preferredPaymentMethod),
    },
  ];

  return {
    filled: areas.filter((a) => a.present).length,
    total: areas.length,
    missing: areas.filter((a) => !a.present).map((a) => a.label),
  };
}
