/**
 * Reading the business's invoice identity — the tenant-scoped, READ-ONLY path.
 *
 * WHY THIS IS A SERVICE AND NOT THREE LINES IN THE ROUTE
 *
 * `GET /api/billing/invoice-profile` used to call `businessProfile.upsert()`:
 * a GET that WRITES, on the bare Prisma client. That was invisible while
 * Production connected as an owner role, and became a 500 for EVERY business
 * the moment the runtime became `app_runtime_prod` (NOBYPASSRLS) — for two
 * independent reasons, either one sufficient:
 *
 *   1. no `app.current_business_id` was set, so under `BusinessProfile`'s
 *      FORCE RLS the SELECT half of the upsert matched zero rows for every
 *      tenant and the upsert always took the INSERT branch; and
 *   2. the runtime holds `GRANT SELECT` on "BusinessProfile" and nothing else
 *      (scripts/security/d2-p7-wave1-grants.sql), so that INSERT is refused
 *      with 42501 before RLS is consulted at all.
 *
 * Reading is a read. A business that has never opened the billing-identity form
 * has no row, and that is a legitimate empty state — not something to
 * materialise a row for, and certainly not on a GET. So the lookup is a plain
 * `findUnique` under the tenant transaction Billing already uses elsewhere
 * (`billingTenantTx`, as in app/api/billing/documents/route.ts), and the absent
 * row is answered with a well-formed empty profile.
 *
 * The caller therefore always receives an OBJECT, never `null`. Every consumer
 * already writes `data?.profile ?? {}`, but a stable shape means the empty case
 * and the configured case differ only in their values — which is what lets the
 * UI render "מלאו את פרטי העסק" as a real empty state instead of an error.
 *
 * Proof: lib/services/billing/billing-invoice-profile.rls-contract.test.ts runs
 * this function as a NOBYPASSRLS, SELECT-only role against the shipped policy.
 */
import { billingTenantTx } from "@/lib/services/billing/billing-tenant-tx";
import { isBillingIdentityComplete } from "@/lib/billing/business-identity";
import {
  DEFAULT_BILLING_PDF_TEMPLATE_STYLE,
  parseBillingPdfTemplateStyle,
  type BillingPdfTemplateStyle,
} from "@/lib/billing/billing-pdf-template-style";

/**
 * Exactly the columns the invoice-identity surfaces consume. Named once so the
 * read cannot silently widen when a column is added to the model.
 */
export const BILLING_INVOICE_PROFILE_SELECT = {
  billingLegalName: true,
  billingBusinessKind: true,
  billingTaxId: true,
  billingVatNumber: true,
  billingPhone: true,
  billingEmail: true,
  billingAddress: true,
  billingPaymentNote: true,
  billingFooterNote: true,
  billingLogoDataUrl: true,
  billingSignatureDataUrl: true,
  billingPdfTemplateStyle: true,
} as const;

export type BillingInvoiceProfile = {
  billingLegalName: string | null;
  billingBusinessKind: string | null;
  billingTaxId: string | null;
  billingVatNumber: string | null;
  billingPhone: string | null;
  billingEmail: string | null;
  billingAddress: string | null;
  billingPaymentNote: string | null;
  billingFooterNote: string | null;
  billingLogoDataUrl: string | null;
  billingSignatureDataUrl: string | null;
  /** Always resolved — never the raw column, never null. */
  billingPdfTemplateStyle: BillingPdfTemplateStyle;
};

/**
 * What a business that has never filled the form looks like. Every field null
 * except the template style, which has a product default rather than an absence.
 */
const EMPTY_PROFILE: BillingInvoiceProfile = {
  billingLegalName: null,
  billingBusinessKind: null,
  billingTaxId: null,
  billingVatNumber: null,
  billingPhone: null,
  billingEmail: null,
  billingAddress: null,
  billingPaymentNote: null,
  billingFooterNote: null,
  billingLogoDataUrl: null,
  billingSignatureDataUrl: null,
  billingPdfTemplateStyle: DEFAULT_BILLING_PDF_TEMPLATE_STYLE,
};

export type BillingInvoiceProfileResult = {
  profile: BillingInvoiceProfile;
  identityComplete: boolean;
};

/**
 * Read the invoice identity for `businessId`. Performs no write of any kind.
 *
 * `businessId` MUST be server-derived (the session's tenant). `billingTenantTx`
 * refuses anything that is not a positive integer, so a missing tenant fails
 * loud rather than reading across the tenant boundary.
 */
export async function loadBillingInvoiceProfile(
  businessId: number
): Promise<BillingInvoiceProfileResult> {
  const row = await billingTenantTx(businessId, (tx) =>
    tx.businessProfile.findUnique({
      where: { businessId },
      select: BILLING_INVOICE_PROFILE_SELECT,
    })
  );

  return {
    profile: {
      ...EMPTY_PROFILE,
      ...(row ?? {}),
      // Resolved from whatever is stored — a NULL, an empty string or an
      // unknown value all become the product default rather than reaching the UI.
      billingPdfTemplateStyle: parseBillingPdfTemplateStyle(
        row?.billingPdfTemplateStyle
      ),
    },
    // Asked of what is actually stored. `null` (no row) is not complete.
    identityComplete: isBillingIdentityComplete(row),
  };
}
