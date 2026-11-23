import type { BusinessCapabilitiesResponse } from "./feature-access.types";
import { resolveBusinessCapabilities } from "./resolve-feature-access";
import type { PlatformFeatureKey } from "./platform-feature-catalog";
import { loadActivitySelection } from "@/lib/services/activity-packs/activity-profile.service";
import { PLAN_CATALOG_VERSION } from "@/lib/services/subscriptions/plan-catalog";
import { resolvePlanEntitlements } from "@/lib/services/subscriptions/resolve-entitlement";
import { loadSubscriptionSnapshot, subscriptionMode } from "@/lib/services/subscriptions/subscription-shadow";

export async function getBusinessCapabilities(
  businessId: number
): Promise<BusinessCapabilitiesResponse> {
  const resolved = await resolveBusinessCapabilities(businessId);

  const features = {} as BusinessCapabilitiesResponse["features"];
  for (const [key, result] of Object.entries(resolved) as [
    PlatformFeatureKey,
    (typeof resolved)[PlatformFeatureKey],
  ][]) {
    features[key] = {
      allowed: result.allowed,
      reasonCode: result.reasonCode,
      reasonLabel: result.reasonLabel,
    };
  }

  const response: BusinessCapabilitiesResponse = {
    generatedAt: new Date().toISOString(),
    businessId,
    features,
  };

  // Phase 2 activity packs: the choice rides on the capabilities answer (one read for the Home, the bar, the "+" sheet
  // and the tools), and ONLY while the feature is ON for this business — while it is OFF the table is never read and
  // the answer is exactly what it was before. A failed read degrades to "never chose" (the pre-packs Home), never to
  // an error: the capabilities answer must not fail because of a display preference.
  if (features.activity_packs?.allowed === true) {
    try {
      const s = await loadActivitySelection(businessId);
      response.activity = s ? { primary: s.primary, additional: [...s.additional] } : null;
    } catch {
      response.activity = null;
    }
  }

  // Subscriptions stage A/B, shadow only: the recorded subscription and the plan verdict ride along for the admin and
  // for the shadow evidence. Nothing in the interface acts on them yet, and `subscription.state` (which the Home
  // reads) is never written here. loadSubscriptionSnapshot never throws; no record = computed as a tester.
  if (subscriptionMode() !== "off") {
    const snapshot = await loadSubscriptionSnapshot(businessId);
    response.subscription = {
      record: snapshot !== null,
      accountType: snapshot?.accountType ?? "TESTER",
      status: snapshot?.status ?? "EXEMPT",
      plan: snapshot?.plan ?? null,
      catalogVersion: snapshot?.catalogVersion ?? PLAN_CATALOG_VERSION,
      enforced: false,
    };
    const plan = resolvePlanEntitlements(resolved, snapshot);
    const planAccess = {} as NonNullable<BusinessCapabilitiesResponse["planAccess"]>;
    for (const [key, e] of Object.entries(plan) as [PlatformFeatureKey, (typeof plan)[PlatformFeatureKey]][]) {
      planAccess[key] = { access: e.access, reasonCode: e.reasonCode, requiredPlan: e.requiredPlan };
    }
    response.planAccess = planAccess;
  }

  return response;
}
