/**
 * Service Desk 1.3a — who may reach the module, and how. SERVER-ONLY.
 *
 * Owner decision 1 (1.3a, the safe form of v4 מ1, 2026-11-09):
 *   FULL       the flag resolves allowed for the business (and no emergency switch).
 *   READ_ONLY  the business was switched off EXPLICITLY (BUSINESS_DISABLED), the module is launched (global ON), no
 *              emergency switch, AND the business has cases: it reads its own history; every write is refused.
 *   NONE       everything else — not launched (GLOBAL_DEFAULT), switched off globally after launch, emergency, or
 *              switched off for a business that never had a case: 404, as if the module did not exist.
 * A global block or the emergency switch therefore always wins over read-only. Fail closed: any error is NONE.
 * Nothing here can switch the module on; the admin owner gate (owner-gated-features.ts) is untouched.
 */
import type { FeatureAccessResult } from "@/lib/services/feature-access/feature-access.types";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { resolveFeatureAccess } from "@/lib/services/feature-access/resolve-feature-access";
import { runWithTenantContext } from "@/lib/tenant/context";
import { tenantTx } from "@/lib/tenant/tenant-tx";

export type ServiceDeskMode = "FULL" | "READ_ONLY" | "NONE";

export type ServiceDeskAccessFacts = Pick<FeatureAccessResult, "allowed" | "reasonCode" | "globalEnabled" | "emergencyDisabled">;

/** The whole decision, pure. `hasCases` is asked only when it can matter (see resolveServiceDeskMode). */
export function decideServiceDeskMode(access: ServiceDeskAccessFacts, hasCases: boolean): ServiceDeskMode {
  if (access.emergencyDisabled === true) return "NONE";
  if (access.allowed === true) return "FULL";
  if (access.reasonCode === "BUSINESS_DISABLED" && access.globalEnabled === true && hasCases === true) return "READ_ONLY";
  return "NONE";
}

/** True when the read-only branch is reachable at all — the only case in which the business's cases are counted. */
export function readOnlyCandidate(access: ServiceDeskAccessFacts): boolean {
  return access.allowed !== true && access.emergencyDisabled !== true && access.reasonCode === "BUSINESS_DISABLED" && access.globalEnabled === true;
}

export async function resolveServiceDeskMode(businessId: number): Promise<ServiceDeskMode> {
  try {
    const access = await runWithTenantContext({ businessId }, () => resolveFeatureAccess(businessId, PLATFORM_FEATURE_KEYS.SERVICE_DESK));
    let hasCases = false;
    if (readOnlyCandidate(access)) {
      const rows = await tenantTx(businessId, (tx) =>
        tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "ServiceCase" WHERE "businessId" = ${businessId}::int`);
      hasCases = Number(rows[0]?.n ?? 0) > 0;
    }
    return decideServiceDeskMode(access, hasCases);
  } catch {
    return "NONE";
  }
}
