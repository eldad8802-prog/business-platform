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
    "יש להשלים את פרטי העסק (הגדרות › העסק שלי) לפני הפקת חשבונית מס או יצירת טיוטת חשבונית."
  );
}
