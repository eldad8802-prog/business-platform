/**
 * The business's own identity for the issuer reading — SERVER-ONLY.
 *
 * Behind the `document_supplier_linking` flag: OFF, or any failure to tell, returns null and the extraction
 * runs exactly as before (no exclusion, no issuer reading written). Fail-closed on purpose: a document must
 * never fail to process because this lookup did.
 */
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { resolveFeatureAccess } from "@/lib/services/feature-access/resolve-feature-access";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { buildOwnBusinessIdentity, type OwnBusinessIdentity } from "./issuer-reading";

/** True when the business has document supplier linking. Fail-closed: any error reads as OFF. */
export async function documentSupplierLinkingEnabled(businessId: number): Promise<boolean> {
  try {
    const r = await runWithTenantContext({ businessId }, () =>
      resolveFeatureAccess(businessId, PLATFORM_FEATURE_KEYS.DOCUMENT_SUPPLIER_LINKING)
    );
    return r.allowed === true;
  } catch {
    return false;
  }
}

/** The business's own name(s) and tax id(s), or null when the flag is OFF or the lookup failed. */
export async function loadOwnBusinessIdentity(businessId: number): Promise<OwnBusinessIdentity | null> {
  if (!(await documentSupplierLinkingEnabled(businessId))) return null;
  try {
    const row = await runWithTenantContext({ businessId }, () =>
      withTenantTransaction(async (tx) => {
        const business = await tx.business.findFirst({ where: { id: businessId }, select: { name: true } });
        const profile = await tx.businessProfile.findFirst({
          where: { businessId },
          select: { billingLegalName: true, billingTaxId: true, billingVatNumber: true },
        });
        return { business, profile };
      })
    );
    const own = buildOwnBusinessIdentity({
      businessName: row.business?.name ?? null,
      legalName: row.profile?.billingLegalName ?? null,
      taxId: row.profile?.billingTaxId ?? null,
    });
    const vat = buildOwnBusinessIdentity({ taxId: row.profile?.billingVatNumber ?? null });
    return { taxIds: [...new Set([...own.taxIds, ...vat.taxIds])], nameKeys: own.nameKeys };
  } catch {
    console.error("[issuer-context] own identity lookup failed; extraction runs without it");
    return null;
  }
}
