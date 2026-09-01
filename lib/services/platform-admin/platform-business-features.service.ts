/**
 * D2 / PRIVILEGED-WRITE-2 — platform-admin feature-access READ surface.
 *
 * Moved here from `lib/services/feature-access/` (which is tenant territory) so
 * it sits inside the CI-2/CI-4-guarded admin module.
 *
 * It reads ONE business at a time — the target the authorized platform admin
 * named in the URL — so it does not need a cross-tenant credential at all. It
 * runs through the same explicit-target substrate as the privileged writer,
 * minus the privileged role:
 *
 *   requirePlatformAdmin (route)
 *     → runTenantJob({ businessId: target })
 *       → withTenantTransaction   (GUC = target)
 *         → GUC-scoped read of exactly that business's overrides
 *
 * Why not the admin client: `getPrismaAdmin()` requires ADMIN_DATABASE_URL, which
 * exists in no environment except one Preview branch. Routing this read through it
 * would turn a working platform-admin screen into a loud 500 in local dev, normal
 * Preview and Production the moment this shipped. The explicit-target read is both
 * correct under FORCE RLS and free of any new environment dependency.
 *
 * It must NEVER use the context-less tenant singleton: `BusinessFeatureAccess` is
 * FORCE-RLS'd and a context-less read returns zero overrides, which would render
 * every business as "no override" — the fail-silent admin display this wave exists
 * to eliminate. The context here is always explicit and always the named target.
 */
import { runTenantJob } from "@/lib/tenant/job";
import { withTenantTransaction } from "@/lib/tenant/transaction";
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
  // The target is server-resolved from the URL by an already-authorized platform
  // admin. runTenantJob validates it and refuses a silent switch; the transaction
  // then sets the GUC so the read is scoped to exactly that business.
  const { business, resolved } = await runTenantJob({ businessId }, () =>
    withTenantTransaction(async (tx) => {
      const found = await tx.business.findFirst({
        where: {
          id: businessId,
          name: { not: PLATFORM_SYSTEM_BUSINESS_NAME },
        },
        select: { id: true, name: true },
      });

      if (!found) {
        throw new NotFoundError("Business not found");
      }

      return {
        business: found,
        resolved: await resolveBusinessCapabilitiesWith(
          tx as unknown as FeatureAccessReader,
          businessId
        ),
      };
    })
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
