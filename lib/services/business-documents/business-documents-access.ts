/**
 * Business documents (ר1–ר3) — is the feature open for this business? SERVER-ONLY.
 * Fail-closed: any error reads as OFF. The flag is business_documents (off by default).
 */
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { resolveFeatureAccess } from "@/lib/services/feature-access/resolve-feature-access";
import { runWithTenantContext } from "@/lib/tenant/context";

export async function businessDocumentsEnabled(businessId: number): Promise<boolean> {
  try {
    const r = await runWithTenantContext({ businessId }, () => resolveFeatureAccess(businessId, PLATFORM_FEATURE_KEYS.BUSINESS_DOCUMENTS));
    return r.allowed === true;
  } catch {
    return false;
  }
}
