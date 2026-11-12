/**
 * The notification engine's gates. SERVER-ONLY.
 *
 *   engine     — the platform feature `notifications_engine` (catalog default OFF). Unless it is ON for the business
 *                the worker sends nothing, the digest writes nothing and the device routes register nothing.
 *   categories — each catalog category's own platform feature (inventory, billing, …): not available ⇒ inactive.
 *
 * Fail closed: an error resolving the business's capabilities reads as everything OFF.
 */
import { runWithTenantContext } from "@/lib/tenant/context";
import { resolveBusinessCapabilities } from "@/lib/services/feature-access/resolve-feature-access";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";

import type { CategoryDefinition } from "../catalog";

export type BusinessGates = {
  engineOn: boolean;
  /** Is this category's feature available to the business? (null category = unknown → in-app only anyway.) */
  categoryAvailable: (cat: CategoryDefinition) => boolean;
};

const ALL_OFF: BusinessGates = { engineOn: false, categoryAvailable: () => false };

export async function businessGates(businessId: number): Promise<BusinessGates> {
  try {
    const caps = await runWithTenantContext({ businessId }, () => resolveBusinessCapabilities(businessId));
    return {
      engineOn: caps[PLATFORM_FEATURE_KEYS.NOTIFICATIONS_ENGINE]?.allowed === true,
      categoryAvailable: (cat) => cat.featureKey === null || caps[cat.featureKey]?.allowed === true,
    };
  } catch {
    return ALL_OFF;
  }
}

export async function notificationsEngineEnabled(businessId: number): Promise<boolean> {
  return (await businessGates(businessId)).engineOn;
}
