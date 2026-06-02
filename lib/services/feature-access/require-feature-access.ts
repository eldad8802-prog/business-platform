import { AppError } from "@/lib/errors";
import { resolveFeatureAccess } from "./resolve-feature-access";
import type { PlatformFeatureKey } from "./platform-feature-catalog";

/**
 * Prepared for Phase 2+ enforcement — not wired to routes in Phase 0–1.
 */
export class FeatureAccessDeniedError extends AppError {
  featureKey: string;
  reasonCode: string;

  constructor(featureKey: string, reasonCode: string, message?: string) {
    super(message ?? `Feature access denied: ${featureKey}`, 403);
    this.name = "FeatureAccessDeniedError";
    this.featureKey = featureKey;
    this.reasonCode = reasonCode;
  }
}

export async function requireFeatureAccess(
  businessId: number,
  featureKey: PlatformFeatureKey
): Promise<void> {
  const result = await resolveFeatureAccess(businessId, featureKey);
  if (!result.allowed) {
    throw new FeatureAccessDeniedError(
      featureKey,
      result.reasonCode,
      result.reasonLabel
    );
  }
}
