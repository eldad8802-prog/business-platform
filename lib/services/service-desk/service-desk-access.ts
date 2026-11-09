/**
 * Service Desk — is the module open for this business? SERVER-ONLY.
 * Fail-closed: any error reads as OFF. The flag is service_desk, seeded OFF (migration 20261120090000); nothing calls
 * this yet — the screens and commands are 1.3a+.
 */
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { resolveFeatureAccess } from "@/lib/services/feature-access/resolve-feature-access";
import { runWithTenantContext } from "@/lib/tenant/context";

export async function serviceDeskEnabled(businessId: number): Promise<boolean> {
  try {
    const r = await runWithTenantContext({ businessId }, () => resolveFeatureAccess(businessId, PLATFORM_FEATURE_KEYS.SERVICE_DESK));
    return r.allowed === true;
  } catch {
    return false;
  }
}
