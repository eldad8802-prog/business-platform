import type { BusinessCapabilitiesResponse } from "./feature-access.types";
import { resolveBusinessCapabilities } from "./resolve-feature-access";
import type { PlatformFeatureKey } from "./platform-feature-catalog";
import { loadActivitySelection } from "@/lib/services/activity-packs/activity-profile.service";

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

  return response;
}
