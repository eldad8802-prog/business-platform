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
import { he } from "@/lib/i18n/messages/he";
import { createTranslator, type MessageKey, type Translator } from "@/lib/i18n/translate";
import {
  isPlausibleEmail,
  isPlausiblePhone,
  isPlausibleSupplierTaxId,
  SUPPLIER_PAYMENT_TERMS_MAX_DAYS,
  type SupplierPaymentMethod,
  type SupplierTaxIdType,
} from "@/lib/services/inventory/supplier-profile";

/** Hebrew translator — the default when a caller passes none (same output as before i18n). */
const heT: Translator = createTranslator(he);

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
 *
 * `t` selects the interface language of the message; omitted → Hebrew.
 */
export function validateSupplierForm(
  form: SupplierFormState,
  t: Translator = heT
): string | null {
  if (!form.name.trim()) return t("customers.suppliers.validation.nameRequired");

  if (form.taxId.trim() && !isPlausibleSupplierTaxId(form.taxId)) {
    return t("customers.suppliers.validation.taxIdInvalid");
  }
  if (form.email.trim() && !isPlausibleEmail(form.email)) {
    return t("customers.suppliers.validation.emailInvalid");
  }
  if (form.contactEmail.trim() && !isPlausibleEmail(form.contactEmail)) {
    return t("customers.suppliers.validation.contactEmailInvalid");
  }
  if (form.phone.trim() && !isPlausiblePhone(form.phone)) {
    return t("customers.suppliers.validation.phoneInvalid");
  }
  if (form.contactPhone.trim() && !isPlausiblePhone(form.contactPhone)) {
    return t("customers.suppliers.validation.contactPhoneInvalid");
  }

  const terms = form.paymentTermsDays.trim();
  if (terms) {
    const parsed = Number(terms);
    if (
      !Number.isInteger(parsed) ||
      parsed < 0 ||
      parsed > SUPPLIER_PAYMENT_TERMS_MAX_DAYS
    ) {
      return t("customers.suppliers.validation.paymentTermsRange", {
        max: SUPPLIER_PAYMENT_TERMS_MAX_DAYS,
      });
    }
  }

  const lead = form.defaultLeadTimeDays.trim();
  if (lead) {
    const parsed = Number(lead);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return t("customers.suppliers.validation.leadTimeInvalid");
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
  supplier: Supplier,
  t: Translator = heT
): SupplierCompleteness {
  const areas: Array<{ label: MessageKey; present: boolean }> = [
    {
      label: "customers.suppliers.completeness.taxId",
      present: Boolean(supplier.taxId && supplier.taxIdType),
    },
    {
      label: "customers.suppliers.completeness.contactMethod",
      present: Boolean(supplier.phone || supplier.email || supplier.contactPhone),
    },
    { label: "customers.suppliers.completeness.contact", present: Boolean(supplier.contactName) },
    { label: "customers.suppliers.completeness.address", present: Boolean(supplier.addressCity) },
    {
      label: "customers.suppliers.completeness.paymentTerms",
      present: supplier.paymentTermsDays != null,
    },
    {
      label: "customers.suppliers.completeness.paymentMethod",
      present: Boolean(supplier.preferredPaymentMethod),
    },
  ];

  return {
    filled: areas.filter((a) => a.present).length,
    total: areas.length,
    missing: areas.filter((a) => !a.present).map((a) => t(a.label)),
  };
}

/*
 * Translated twins of the supplier-profile vocabulary (lib/services/inventory/
 * supplier-profile.ts). The service module keeps its Hebrew constants for the
 * server / export paths; the supplier UI reads its labels through these so the
 * same enum values render in the interface language. Hebrew output is identical.
 */

const TAX_ID_TYPE_KEY: Record<SupplierTaxIdType, MessageKey> = {
  AUTHORIZED_DEALER: "customers.suppliers.profile.taxIdType.AUTHORIZED_DEALER",
  EXEMPT_DEALER: "customers.suppliers.profile.taxIdType.EXEMPT_DEALER",
  LTD_COMPANY: "customers.suppliers.profile.taxIdType.LTD_COMPANY",
  PRIVATE_ID: "customers.suppliers.profile.taxIdType.PRIVATE_ID",
  OTHER: "customers.suppliers.profile.taxIdType.OTHER",
};

const TAX_ID_LABEL_KEY: Record<SupplierTaxIdType, MessageKey> = {
  AUTHORIZED_DEALER: "customers.suppliers.profile.taxIdLabel.AUTHORIZED_DEALER",
  EXEMPT_DEALER: "customers.suppliers.profile.taxIdLabel.EXEMPT_DEALER",
  LTD_COMPANY: "customers.suppliers.profile.taxIdLabel.LTD_COMPANY",
  PRIVATE_ID: "customers.suppliers.profile.taxIdLabel.PRIVATE_ID",
  OTHER: "customers.suppliers.profile.taxIdLabel.OTHER",
};

const PAYMENT_METHOD_KEY: Record<SupplierPaymentMethod, MessageKey> = {
  BANK_TRANSFER: "customers.suppliers.profile.paymentMethod.BANK_TRANSFER",
  CREDIT_CARD: "customers.suppliers.profile.paymentMethod.CREDIT_CARD",
  CHECK: "customers.suppliers.profile.paymentMethod.CHECK",
  CASH: "customers.suppliers.profile.paymentMethod.CASH",
  BIT: "customers.suppliers.profile.paymentMethod.BIT",
  PAYBOX: "customers.suppliers.profile.paymentMethod.PAYBOX",
  OTHER: "customers.suppliers.profile.paymentMethod.OTHER",
};

/** Entity-type label (mirrors SUPPLIER_TAX_ID_TYPE_LABELS); unknown values fall back to the raw value. */
export function supplierTaxIdTypeLabelT(t: Translator, type: SupplierTaxIdType): string {
  const key = TAX_ID_TYPE_KEY[type];
  return key ? t(key) : type;
}

/** The identifier field's label for an entity type (mirrors supplierTaxIdLabel). */
export function supplierTaxIdLabelT(
  t: Translator,
  type: SupplierTaxIdType | null | undefined
): string {
  const key = type ? TAX_ID_LABEL_KEY[type] : undefined;
  return t(key ?? "customers.suppliers.profile.taxIdLabel.generic");
}

/** Payment-method label (mirrors SUPPLIER_PAYMENT_METHOD_LABELS); unknown values fall back to the raw value. */
export function supplierPaymentMethodLabelT(t: Translator, method: SupplierPaymentMethod): string {
  const key = PAYMENT_METHOD_KEY[method];
  return key ? t(key) : method;
}

/**
 * Stored terms → display text; mirrors `formatSupplierPaymentTerms`, whose
 * presets are exactly the immediate label and "net + N". Unset/invalid → null.
 */
export function formatSupplierPaymentTermsT(
  t: Translator,
  days: number | null | undefined
): string | null {
  if (days == null || !Number.isInteger(days) || days < 0) return null;
  if (days === 0) return t("customers.suppliers.profile.paymentTermsImmediate");
  return t("customers.suppliers.profile.paymentTermsNet", { days });
}
