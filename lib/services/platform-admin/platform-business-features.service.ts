/**
 * D2 / PRIVILEGED-WRITE-2 — platform-admin feature-access READ surface.
 *
 * Moved here from `lib/services/feature-access/` (which is tenant territory) so
 * it sits inside the CI-2/CI-4-guarded admin module. It reads across tenants
 * through the SELECT-only admin client and the additive `p7adm_read` policy.
 *
 * It must NEVER use the tenant singleton: `BusinessFeatureAccess` is FORCE-RLS'd
 * and a context-less tenant read returns zero overrides, which would render
 * every business as "no override" — a fail-silent admin display.
 */
import { getPrismaAdmin } from "@/lib/prisma-admin";
import { NotFoundError } from "@/lib/errors";
import { PLATFORM_SYSTEM_BUSINESS_NAME } from "@/lib/services/platform-admin/constants";
import {
  PLATFORM_FEATURE_CATALOG,
  type PlatformFeatureKey,
} from "@/lib/services/feature-access/platform-feature-catalog";
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
} from "@/lib/services/feature-access/feature-access-display";
import {
  resolveBusinessCapabilitiesWith,
  type FeatureAccessReader,
} from "@/lib/services/feature-access/resolve-feature-access";
import type { FeatureAccessResult } from "@/lib/services/feature-access/feature-access.types";
import type {
  PlatformAdminBusinessFeatureItem,
  PlatformAdminBusinessFeaturesResponse,
} from "@/lib/services/feature-access/feature-access.types";

export function buildPlatformAdminBusinessFeatureItem(
  entry: (typeof PLATFORM_FEATURE_CATALOG)[number],
  access: FeatureAccessResult
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
  const db = getPrismaAdmin();

  const business = await db.business.findFirst({
    where: {
      id: businessId,
      name: { not: PLATFORM_SYSTEM_BUSINESS_NAME },
    },
    select: { id: true, name: true },
  });

  if (!business) {
    throw new NotFoundError("Business not found");
  }

  const resolved = await resolveBusinessCapabilitiesWith(
    db as unknown as FeatureAccessReader,
    businessId
  );

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
