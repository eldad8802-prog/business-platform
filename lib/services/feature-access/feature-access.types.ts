import type { PlatformFeatureKey } from "./platform-feature-catalog";
import type {
  FeatureAccessCategoryGroup,
  FeatureAccessDisplayState,
} from "./feature-access-display";

export type FeatureAccessReasonCode =
  | "EMERGENCY_DISABLED"
  | "BUSINESS_DISABLED"
  | "BUSINESS_ENABLED"
  | "GLOBAL_DEFAULT"
  | "CATALOG_DEFAULT";

export type FeatureAccessSource =
  | "emergency"
  | "business"
  | "global"
  | "catalog";

export type FeatureAccessResult = {
  featureKey: PlatformFeatureKey;
  allowed: boolean;
  reasonCode: FeatureAccessReasonCode;
  reasonLabel: string;
  source: FeatureAccessSource;
  globalEnabled: boolean;
  emergencyDisabled: boolean;
  businessOverride: "ENABLED" | "DISABLED" | null;
};

export type BusinessCapabilitiesResponse = {
  generatedAt: string;
  businessId: number;
  features: Record<
    PlatformFeatureKey,
    {
      allowed: boolean;
      reasonCode: FeatureAccessReasonCode;
      reasonLabel: string;
    }
  >;
  /**
   * Phase 2 activity packs: what the business chose (display only). Present ONLY while `activity_packs` is ON for
   * the business; `null` there means "on, but never chose". Absent while the feature is OFF — every surface then
   * draws exactly what it drew before.
   */
  activity?: { primary: string; additional: string[] } | null;
};

export type PlatformAdminBusinessFeatureItem = {
  featureKey: PlatformFeatureKey;
  displayName: string;
  category: string;
  categoryLabel: string;
  categoryGroup: FeatureAccessCategoryGroup;
  description: string;
  catalogDefaultEnabled: boolean;
  mutable: boolean;
  mutableLabel: string;
  globalEnabled: boolean;
  emergencyDisabled: boolean;
  businessOverride: "ENABLED" | "DISABLED" | null;
  overrideLabel: string;
  allowed: boolean;
  reasonCode: FeatureAccessReasonCode;
  reasonLabel: string;
  source: FeatureAccessSource;
  sourceLabel: string;
  displayState: FeatureAccessDisplayState;
  displayStateLabel: string;
  effectiveLabel: string;
};

export type BusinessFeatureOverrideState = "ENABLED" | "DISABLED" | "INHERIT";

export type UpdateBusinessFeatureAccessResponse = {
  changed: boolean;
  generatedAt: string;
  business: {
    id: number;
    name: string;
  };
  feature: PlatformAdminBusinessFeatureItem;
};

export type PlatformAdminBusinessFeaturesResponse = {
  generatedAt: string;
  /** Whether changes can be saved on this environment (FEATURE_ACCESS_MUTATIONS_ENABLED). */
  mutationsEnabled: boolean;
  business: {
    id: number;
    name: string;
  };
  summary: {
    total: number;
    enabledCount: number;
    disabledCount: number;
    overriddenCount: number;
  };
  groups: Array<{
    groupKey: FeatureAccessCategoryGroup;
    groupLabel: string;
    features: PlatformAdminBusinessFeatureItem[];
  }>;
  /** Flat list preserved for clients that prefer it */
  features: PlatformAdminBusinessFeatureItem[];
};
