import { prisma } from "@/lib/prisma";
import { NotFoundError } from "@/lib/errors";
import { PLATFORM_SYSTEM_BUSINESS_NAME } from "@/lib/services/platform-admin/constants";
import {
  PLATFORM_FEATURE_CATALOG,
  type PlatformFeatureKey,
} from "./platform-feature-catalog";
import {
  categoryLabelHe,
  categoryToGroup,
  computeFeatureAccessDisplayState,
  featureAccessDisplayStateLabel,
  featureAccessOverrideLabel,
  featureAccessSourceLabel,
  featureCategoryGroupLabel,
  FEATURE_CATEGORY_GROUP_ORDER,
  type FeatureAccessCategoryGroup,
} from "./feature-access-display";
import { resolveBusinessCapabilities } from "./resolve-feature-access";
import type {
  PlatformAdminBusinessFeatureItem,
  PlatformAdminBusinessFeaturesResponse,
} from "./feature-access.types";

export function buildPlatformAdminBusinessFeatureItem(
  entry: (typeof PLATFORM_FEATURE_CATALOG)[number],
  access: Awaited<ReturnType<typeof resolveBusinessCapabilities>>[PlatformFeatureKey]
): PlatformAdminBusinessFeatureItem {
  const displayState = computeFeatureAccessDisplayState({
    allowed: access.allowed,
    emergencyDisabled: access.emergencyDisabled,
    businessOverride: access.businessOverride,
    mutable: entry.mutable,
  });

  const effectiveLabel = access.allowed ? "פתוח" : "סגור";

  return {
    featureKey: entry.key,
    displayName: entry.displayName,
    category: entry.category,
    categoryLabel: categoryLabelHe(entry.category),
    categoryGroup: categoryToGroup(entry.category),
    description: entry.description,
    catalogDefaultEnabled: entry.defaultEnabled,
    mutable: entry.mutable,
    mutableLabel: entry.mutable
      ? "ניתן לשינוי"
      : "פיצ׳ר בסיסי שלא ניתן לשינוי",
    globalEnabled: access.globalEnabled,
    emergencyDisabled: access.emergencyDisabled,
    businessOverride: access.businessOverride,
    overrideLabel: featureAccessOverrideLabel(access.businessOverride),
    allowed: access.allowed,
    reasonCode: access.reasonCode,
    reasonLabel: access.reasonLabel,
    source: access.source,
    sourceLabel: featureAccessSourceLabel(access.source),
    displayState,
    displayStateLabel: featureAccessDisplayStateLabel(displayState),
    effectiveLabel,
  };
}

function buildGroups(
  features: PlatformAdminBusinessFeatureItem[]
): PlatformAdminBusinessFeaturesResponse["groups"] {
  const byGroup = new Map<
    FeatureAccessCategoryGroup,
    PlatformAdminBusinessFeatureItem[]
  >();

  for (const groupKey of FEATURE_CATEGORY_GROUP_ORDER) {
    byGroup.set(groupKey, []);
  }

  for (const feature of features) {
    const list = byGroup.get(feature.categoryGroup) ?? [];
    list.push(feature);
    byGroup.set(feature.categoryGroup, list);
  }

  return FEATURE_CATEGORY_GROUP_ORDER.map((groupKey) => ({
    groupKey,
    groupLabel: featureCategoryGroupLabel(groupKey),
    features: (byGroup.get(groupKey) ?? []).sort((a, b) =>
      a.displayName.localeCompare(b.displayName, "he")
    ),
  })).filter((g) => g.features.length > 0);
}

export async function getPlatformAdminBusinessFeatures(
  businessId: number
): Promise<PlatformAdminBusinessFeaturesResponse> {
  const business = await prisma.business.findFirst({
    where: {
      id: businessId,
      name: { not: PLATFORM_SYSTEM_BUSINESS_NAME },
    },
    select: { id: true, name: true },
  });

  if (!business) {
    throw new NotFoundError("Business not found");
  }

  const resolved = await resolveBusinessCapabilities(businessId);

  const features = PLATFORM_FEATURE_CATALOG.map((entry) =>
    buildPlatformAdminBusinessFeatureItem(
      entry,
      resolved[entry.key as PlatformFeatureKey]
    )
  );

  const enabledCount = features.filter((f) => f.allowed).length;
  const disabledCount = features.length - enabledCount;
  const overriddenCount = features.filter((f) => f.businessOverride !== null).length;

  return {
    generatedAt: new Date().toISOString(),
    business: {
      id: business.id,
      name: business.name,
    },
    summary: {
      total: features.length,
      enabledCount,
      disabledCount,
      overriddenCount,
    },
    groups: buildGroups(features),
    features,
  };
}
