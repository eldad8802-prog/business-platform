/**
 * The notification engine's gates. SERVER-ONLY.
 *
 *   engine     — the platform feature `notifications_engine` (catalog default OFF). Unless it is ON for the business
 *                the worker sends nothing, the digest writes nothing and the device routes register nothing.
 *   cutover    — the business's engine ACTIVATION moment (owner decision 2026-11-13, "clean start"): no push for an
 *                event created before it. See cutoverFrom() in worker-decision.ts for the rule.
 *   categories — each catalog category's own platform feature (inventory, billing, …): not available ⇒ inactive.
 *
 * Fail closed: an error resolving the business's capabilities (or its cutover) reads as everything OFF.
 */
import { runWithTenantContext } from "@/lib/tenant/context";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { resolveBusinessCapabilities } from "@/lib/services/feature-access/resolve-feature-access";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";

import type { CategoryDefinition } from "../catalog";
import { cutoverFrom } from "./worker-decision";

export type BusinessGates = {
  engineOn: boolean;
  /**
   * The engine's activation moment for this business (engine ON only): an owed push created before it is closed
   * FAILED 'pre_cutover', never sent. null = no timestamp to derive it from (TTL expiry still applies).
   */
  cutoverAt: Date | null;
  /** Is this category's feature available to the business? (null category = unknown → in-app only anyway.) */
  categoryAvailable: (cat: CategoryDefinition) => boolean;
};

const ALL_OFF: BusinessGates = { engineOn: false, cutoverAt: null, categoryAvailable: () => false };

/**
 * The business's engine activation moment: cutoverFrom (worker-decision.ts — the rule and why) over its override and
 * the global policy, read inside the business's own tenant transaction (RLS: its own override only).
 */
export async function engineCutover(businessId: number): Promise<Date | null> {
  const key = PLATFORM_FEATURE_KEYS.NOTIFICATIONS_ENGINE;
  const { override, policy } = await tenantTx(businessId, async (tx) => ({
    override: await tx.businessFeatureAccess.findUnique({
      where: { businessId_featureKey: { businessId, featureKey: key } },
      select: { updatedAt: true },
    }),
    policy: await tx.platformFeaturePolicy.findUnique({ where: { featureKey: key }, select: { updatedAt: true } }),
  }));
  return cutoverFrom({ override, policy });
}

export async function businessGates(businessId: number): Promise<BusinessGates> {
  try {
    const caps = await runWithTenantContext({ businessId }, () => resolveBusinessCapabilities(businessId));
    const engineOn = caps[PLATFORM_FEATURE_KEYS.NOTIFICATIONS_ENGINE]?.allowed === true;
    return {
      engineOn,
      cutoverAt: engineOn ? await engineCutover(businessId) : null,
      categoryAvailable: (cat) => cat.featureKey === null || caps[cat.featureKey]?.allowed === true,
    };
  } catch {
    return ALL_OFF;
  }
}

export async function notificationsEngineEnabled(businessId: number): Promise<boolean> {
  return (await businessGates(businessId)).engineOn;
}
