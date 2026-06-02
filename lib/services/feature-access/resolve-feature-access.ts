import { BusinessFeatureAccessState } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ValidationError } from "@/lib/errors";
import { featureAccessReasonLabel } from "./feature-access-labels";
import type { FeatureAccessResult } from "./feature-access.types";
import {
  getPlatformFeatureCatalogEntry,
  isPlatformFeatureKey,
  listPlatformFeatureKeys,
  type PlatformFeatureKey,
} from "./platform-feature-catalog";

type PolicyRow = {
  globalEnabled: boolean;
  emergencyDisabled: boolean;
};

type OverrideRow = {
  state: BusinessFeatureAccessState;
};

export function resolveFeatureAccessFromInputs(input: {
  featureKey: PlatformFeatureKey;
  catalogDefaultEnabled: boolean;
  policy: PolicyRow | null;
  override: OverrideRow | null;
}): FeatureAccessResult {
  const catalogEntry = getPlatformFeatureCatalogEntry(input.featureKey);
  const globalEnabled = input.policy?.globalEnabled ?? catalogEntry.defaultEnabled;
  const emergencyDisabled = input.policy?.emergencyDisabled ?? false;

  let businessOverride: "ENABLED" | "DISABLED" | null = null;
  if (input.override?.state === BusinessFeatureAccessState.ENABLED) {
    businessOverride = "ENABLED";
  } else if (input.override?.state === BusinessFeatureAccessState.DISABLED) {
    businessOverride = "DISABLED";
  }

  if (emergencyDisabled) {
    return buildResult({
      featureKey: input.featureKey,
      allowed: false,
      reasonCode: "EMERGENCY_DISABLED",
      source: "emergency",
      globalEnabled,
      emergencyDisabled,
      businessOverride,
    });
  }

  if (businessOverride === "DISABLED") {
    return buildResult({
      featureKey: input.featureKey,
      allowed: false,
      reasonCode: "BUSINESS_DISABLED",
      source: "business",
      globalEnabled,
      emergencyDisabled,
      businessOverride,
    });
  }

  if (businessOverride === "ENABLED") {
    return buildResult({
      featureKey: input.featureKey,
      allowed: true,
      reasonCode: "BUSINESS_ENABLED",
      source: "business",
      globalEnabled,
      emergencyDisabled,
      businessOverride,
    });
  }

  if (!globalEnabled) {
    return buildResult({
      featureKey: input.featureKey,
      allowed: false,
      reasonCode: "GLOBAL_DEFAULT",
      source: "global",
      globalEnabled,
      emergencyDisabled,
      businessOverride,
    });
  }

  const allowed = catalogEntry.defaultEnabled;
  return buildResult({
    featureKey: input.featureKey,
    allowed,
    reasonCode: "CATALOG_DEFAULT",
    source: "catalog",
    globalEnabled,
    emergencyDisabled,
    businessOverride,
  });
}

function buildResult(input: {
  featureKey: PlatformFeatureKey;
  allowed: boolean;
  reasonCode: FeatureAccessResult["reasonCode"];
  source: FeatureAccessResult["source"];
  globalEnabled: boolean;
  emergencyDisabled: boolean;
  businessOverride: "ENABLED" | "DISABLED" | null;
}): FeatureAccessResult {
  return {
    featureKey: input.featureKey,
    allowed: input.allowed,
    reasonCode: input.reasonCode,
    reasonLabel: featureAccessReasonLabel(input.reasonCode),
    source: input.source,
    globalEnabled: input.globalEnabled,
    emergencyDisabled: input.emergencyDisabled,
    businessOverride: input.businessOverride,
  };
}

export async function resolveFeatureAccess(
  businessId: number,
  featureKey: string
): Promise<FeatureAccessResult> {
  if (!isPlatformFeatureKey(featureKey)) {
    throw new ValidationError(`Unknown feature key: ${featureKey}`);
  }

  const [policy, override] = await Promise.all([
    prisma.platformFeaturePolicy.findUnique({
      where: { featureKey },
      select: { globalEnabled: true, emergencyDisabled: true },
    }),
    prisma.businessFeatureAccess.findUnique({
      where: {
        businessId_featureKey: { businessId, featureKey },
      },
      select: { state: true },
    }),
  ]);

  return resolveFeatureAccessFromInputs({
    featureKey,
    catalogDefaultEnabled: getPlatformFeatureCatalogEntry(featureKey).defaultEnabled,
    policy,
    override,
  });
}

export async function resolveBusinessCapabilities(
  businessId: number
): Promise<Record<PlatformFeatureKey, FeatureAccessResult>> {
  const keys = listPlatformFeatureKeys();

  const [policies, overrides] = await Promise.all([
    prisma.platformFeaturePolicy.findMany({
      where: { featureKey: { in: keys } },
      select: { featureKey: true, globalEnabled: true, emergencyDisabled: true },
    }),
    prisma.businessFeatureAccess.findMany({
      where: { businessId, featureKey: { in: keys } },
      select: { featureKey: true, state: true },
    }),
  ]);

  const policyByKey = new Map(policies.map((p) => [p.featureKey, p]));
  const overrideByKey = new Map(overrides.map((o) => [o.featureKey, o]));

  const result = {} as Record<PlatformFeatureKey, FeatureAccessResult>;

  for (const key of keys) {
    const entry = getPlatformFeatureCatalogEntry(key);
    result[key] = resolveFeatureAccessFromInputs({
      featureKey: key,
      catalogDefaultEnabled: entry.defaultEnabled,
      policy: policyByKey.get(key) ?? null,
      override: overrideByKey.get(key) ?? null,
    });
  }

  return result;
}
