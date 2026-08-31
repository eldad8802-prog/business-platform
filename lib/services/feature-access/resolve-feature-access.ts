import { BusinessFeatureAccessState } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { withTenantTransaction } from "@/lib/tenant/transaction";
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

/**
 * The minimal client shape the resolver needs. Both `PrismaClient` and
 * `Prisma.TransactionClient` satisfy it structurally, so the same reader serves
 * the tenant transaction path and (via the platform-admin layer) the admin read
 * client — without forming a union that would collapse the delegates' precise
 * `select` payload types.
 */
export type FeatureAccessReader = Pick<
  PrismaClient,
  "platformFeaturePolicy" | "businessFeatureAccess"
>;

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

/**
 * Read policies + overrides for one business through an EXPLICITLY supplied
 * client, and resolve every catalog key.
 *
 * D2/PW-2: this is the single place that reads `BusinessFeatureAccess` for
 * resolution. The caller chooses the client, and therefore the trust boundary:
 *   - tenant path -> a tenant transaction whose GUC is the caller's own
 *                    business (`resolveBusinessCapabilities` below);
 *   - admin path  -> the SELECT-only admin client, which reads across tenants
 *                    through the additive `p7adm_read` policy.
 * There is deliberately no third option: nothing may read this table on the
 * context-less tenant singleton, because under FORCE RLS that returns zero
 * overrides and a DISABLED entitlement would silently resolve to *allowed*.
 */
export async function resolveBusinessCapabilitiesWith(
  db: FeatureAccessReader,
  businessId: number
): Promise<Record<PlatformFeatureKey, FeatureAccessResult>> {
  const keys = listPlatformFeatureKeys();

  const policies = await db.platformFeaturePolicy.findMany({
    where: { featureKey: { in: keys } },
    select: { featureKey: true, globalEnabled: true, emergencyDisabled: true },
  });
  const overrides = await db.businessFeatureAccess.findMany({
    where: { businessId, featureKey: { in: keys } },
    select: { featureKey: true, state: true },
  });

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

/**
 * TENANT path — resolve every catalog key for the business in the ESTABLISHED
 * tenant context.
 *
 * Fail-closed: `withTenantTransaction` throws when no tenant context is in
 * scope, so a context-less call can never degrade into a global read. The
 * `businessId` argument must already come from the trusted server-side session;
 * it is not an authority of its own — the tenant GUC set by the transaction is
 * what the database enforces.
 */
export async function resolveBusinessCapabilities(
  businessId: number
): Promise<Record<PlatformFeatureKey, FeatureAccessResult>> {
  return withTenantTransaction((tx) =>
    resolveBusinessCapabilitiesWith(tx as unknown as FeatureAccessReader, businessId)
  );
}

/** TENANT path — resolve one feature. Fail-closed for the same reason. */
export async function resolveFeatureAccess(
  businessId: number,
  featureKey: string
): Promise<FeatureAccessResult> {
  if (!isPlatformFeatureKey(featureKey)) {
    throw new ValidationError(`Unknown feature key: ${featureKey}`);
  }

  const all = await resolveBusinessCapabilities(businessId);
  return all[featureKey];
}
