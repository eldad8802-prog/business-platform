import type { BusinessCapabilitiesResponse } from "./feature-access.types";
import { resolveBusinessCapabilities } from "./resolve-feature-access";
import type { PlatformFeatureKey } from "./platform-feature-catalog";

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

  return {
    generatedAt: new Date().toISOString(),
    businessId,
    features,
  };
}
