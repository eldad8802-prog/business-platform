import { ValidationError } from "@/lib/errors";

export const BILLING_BUSINESS_KIND_VALUES = [
  "EXEMPT_DEALER",
  "AUTHORIZED_DEALER",
  "LTD_COMPANY",
] as const;

export type BillingBusinessKind =
  (typeof BILLING_BUSINESS_KIND_VALUES)[number];

export const BILLING_BUSINESS_KIND_LABELS: Record<BillingBusinessKind, string> =
  {
    EXEMPT_DEALER: "עוסק פטור",
    AUTHORIZED_DEALER: "עוסק מורשה",
    LTD_COMPANY: 'חברה בע"מ',
  };

export type BillingIdentityProfileSlice = {
  billingLegalName: string | null;
  billingBusinessKind: string | null;
  billingTaxId: string | null;
  billingAddress: string | null;
  billingPhone: string | null;
  billingEmail: string | null;
};

export function parseBillingBusinessKind(
  raw: string | null | undefined
): BillingBusinessKind | null {
  if (raw == null || typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  return BILLING_BUSINESS_KIND_VALUES.includes(t as BillingBusinessKind)
    ? (t as BillingBusinessKind)
    : null;
}

export function isBillingIdentityComplete(
  p: Partial<BillingIdentityProfileSlice> | null | undefined
): boolean {
  if (!p) return false;
  const name = (p.billingLegalName ?? "").trim();
  const kind = parseBillingBusinessKind(p.billingBusinessKind);
  const tax = (p.billingTaxId ?? "").trim();
  const addr = (p.billingAddress ?? "").trim();
  const phone = (p.billingPhone ?? "").trim();
  const email = (p.billingEmail ?? "").trim();
  return !!(
    name &&
    kind &&
    tax &&
    addr &&
    phone &&
    email
  );
}

export function assertBillingIdentityReadyForTaxInvoice(
  p: Partial<BillingIdentityProfileSlice> | null | undefined
): void {
  if (isBillingIdentityComplete(p)) return;
  throw new ValidationError(
    "יש להשלים את פרטי העסק (הגדרות › פרטי העסק) לפני הפקת חשבונית מס או יצירת טיוטת חשבונית."
  );
}

/**
 * Document types an EXEMPT_DEALER (עוסק פטור) may not issue: an exempt dealer
 * charges no VAT and issues no tax invoice. Receipts — and credit notes, which
 * can only correct an already-issued tax invoice — stay available. Quotes are
 * never issued through issuance at all.
 */
export const EXEMPT_DEALER_FORBIDDEN_DOCUMENT_TYPES = [
  "TAX_INVOICE",
  "TAX_INVOICE_RECEIPT",
] as const;

export const EXEMPT_DEALER_TAX_INVOICE_MESSAGE =
  "עוסק פטור אינו יכול להפיק חשבונית מס או חשבונית מס/קבלה. ניתן להפיק קבלה.";

/**
 * Server-side issuance rule: refuses a tax invoice (or tax invoice/receipt) for
 * a business whose billing classification is EXEMPT_DEALER. Pure — the caller
 * runs it before any number is allocated or anything is written.
 */
export function assertDocumentTypeAllowedForBusinessKind(
  businessKind: string | null | undefined,
  documentType: string
): void {
  if (parseBillingBusinessKind(businessKind) !== "EXEMPT_DEALER") return;
  if ((EXEMPT_DEALER_FORBIDDEN_DOCUMENT_TYPES as readonly string[]).includes(documentType)) {
    throw new ValidationError(EXEMPT_DEALER_TAX_INVOICE_MESSAGE);
  }
}
