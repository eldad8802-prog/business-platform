/**
 * Supplier business profile — the field vocabulary of a supplier card.
 *
 * Pure. No Prisma, no I/O. Everything here is shared by the service (which
 * writes) and the UI (which labels), so the two can never drift apart.
 *
 * DELIBERATE REUSE, NOT DUPLICATION:
 *  - Tax identity reuses `CUSTOMER_TAX_ID_TYPE_*` from lib/billing/customer-tax-identity.
 *    The legal entity types of an Israeli counterparty (עוסק מורשה / עוסק פטור /
 *    'חברה בע"מ' / ת.ז.) do not change depending on whether that counterparty is
 *    buying from us or selling to us, so a supplier-only copy of that list would
 *    be two sources of truth for one fact.
 *  - Payment terms are stored as DAYS and read through
 *    `resolvePaymentTermsDays()` — the same canonical representation the
 *    receivables/collection side already uses. "שוטף+30" is a presentation of
 *    the number 30, not a string in a column.
 *  - Payment method reuses the existing `PaymentMethod` enum.
 *
 * NOT HERE, ON PURPOSE: bank account details. There is no field-level encryption
 * or sensitive-data handling in this codebase today, and a supplier's bank
 * account is exactly the kind of data that must not be stored in the clear just
 * because a form has room for it. Preferred payment method and payment terms
 * carry the useful part of that intent without holding the sensitive part.
 */

import {
  CUSTOMER_TAX_ID_TYPE_LABELS,
  CUSTOMER_TAX_ID_TYPE_VALUES,
  type CustomerTaxIdType,
} from "@/lib/billing/customer-tax-identity";

export type SupplierTaxIdType = CustomerTaxIdType;

export const SUPPLIER_TAX_ID_TYPE_VALUES = CUSTOMER_TAX_ID_TYPE_VALUES;
export const SUPPLIER_TAX_ID_TYPE_LABELS = CUSTOMER_TAX_ID_TYPE_LABELS;

/**
 * The label for the identifier field, per entity type.
 *
 * The owner should never be shown both "ח.פ." and "מספר עוסק" — there is one
 * identifier, and its NAME depends on what kind of entity this is.
 */
export const SUPPLIER_TAX_ID_LABELS: Record<SupplierTaxIdType, string> = {
  AUTHORIZED_DEALER: "מספר עוסק",
  EXEMPT_DEALER: "מספר עוסק",
  LTD_COMPANY: 'ח.פ.',
  PRIVATE_ID: "תעודת זהות",
  OTHER: "מזהה עסקי",
};

/** Fallback label before an entity type has been chosen. */
export const SUPPLIER_TAX_ID_GENERIC_LABEL = "מספר עוסק / ח.פ.";

export function supplierTaxIdLabel(
  type: SupplierTaxIdType | null | undefined
): string {
  if (!type) return SUPPLIER_TAX_ID_GENERIC_LABEL;
  return SUPPLIER_TAX_ID_LABELS[type] ?? SUPPLIER_TAX_ID_GENERIC_LABEL;
}

export const SUPPLIER_PAYMENT_METHOD_VALUES = [
  "BANK_TRANSFER",
  "CREDIT_CARD",
  "CHECK",
  "CASH",
  "BIT",
  "PAYBOX",
  "OTHER",
] as const;

export type SupplierPaymentMethod =
  (typeof SUPPLIER_PAYMENT_METHOD_VALUES)[number];

export const SUPPLIER_PAYMENT_METHOD_LABELS: Record<
  SupplierPaymentMethod,
  string
> = {
  BANK_TRANSFER: "העברה בנקאית",
  CREDIT_CARD: "כרטיס אשראי",
  CHECK: "צ׳ק",
  CASH: "מזומן",
  BIT: "ביט",
  PAYBOX: "פייבוקס",
  OTHER: "אחר",
};

export function parseSupplierPaymentMethod(
  raw: unknown
): SupplierPaymentMethod | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  return SUPPLIER_PAYMENT_METHOD_VALUES.includes(t as SupplierPaymentMethod)
    ? (t as SupplierPaymentMethod)
    : null;
}

export function parseSupplierTaxIdType(
  raw: unknown
): SupplierTaxIdType | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  return SUPPLIER_TAX_ID_TYPE_VALUES.includes(t as SupplierTaxIdType)
    ? (t as SupplierTaxIdType)
    : null;
}

/**
 * The common Israeli commercial terms, offered as presets.
 *
 * The stored value is always a plain number of days, so a business with unusual
 * terms is not forced into one of these — the presets are a shortcut, not the
 * vocabulary.
 */
export const SUPPLIER_PAYMENT_TERMS_PRESETS: Array<{
  days: number;
  label: string;
}> = [
  { days: 0, label: "תשלום מיידי" },
  { days: 30, label: "שוטף + 30" },
  { days: 60, label: "שוטף + 60" },
  { days: 90, label: "שוטף + 90" },
];

/**
 * How a stored terms value reads back to the owner. Never invents a default:
 * an unset value stays unset here (unlike the receivables resolver, which must
 * always produce a number to sort a collection list by).
 */
export function formatSupplierPaymentTerms(
  days: number | null | undefined
): string | null {
  if (days == null || !Number.isInteger(days) || days < 0) return null;
  if (days === 0) return "תשלום מיידי";
  const preset = SUPPLIER_PAYMENT_TERMS_PRESETS.find((p) => p.days === days);
  if (preset) return preset.label;
  return `שוטף + ${days}`;
}

/**
 * Israeli business identifiers are 9 digits, but 8-digit legacy עוסק numbers and
 * zero-padding are both real in the wild. We normalize to digits and accept a
 * plausible LENGTH ONLY — deliberately NOT a check-digit test.
 *
 * Rejecting a legal identifier is far worse than accepting an illegal one here:
 * this field is a label on a supplier card, not an authority submission. The
 * strict validation that the Tax Authority path needs already lives on the
 * billing side and is not weakened by this.
 */
export const SUPPLIER_TAX_ID_MIN_DIGITS = 8;
export const SUPPLIER_TAX_ID_MAX_DIGITS = 9;

export function normalizeSupplierTaxId(raw: string): string {
  return raw.replace(/[\s-]/g, "");
}

export function isPlausibleSupplierTaxId(raw: string): boolean {
  const normalized = normalizeSupplierTaxId(raw);
  if (!/^\d+$/.test(normalized)) return false;
  return (
    normalized.length >= SUPPLIER_TAX_ID_MIN_DIGITS &&
    normalized.length <= SUPPLIER_TAX_ID_MAX_DIGITS
  );
}

/** Minimal shape check — an obviously malformed address is worse than none. */
export function isPlausibleEmail(raw: string): boolean {
  const t = raw.trim();
  if (!t || /\s/.test(t)) return false;
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(t);
}

/** Digits (plus an optional leading +) only; length checked loosely, IL-aware. */
export function isPlausiblePhone(raw: string): boolean {
  const digits = raw.replace(/[\s\-().]/g, "");
  if (!/^\+?\d+$/.test(digits)) return false;
  const bare = digits.replace(/^\+/, "");
  return bare.length >= 7 && bare.length <= 15;
}

export const SUPPLIER_PAYMENT_TERMS_MAX_DAYS = 365;
