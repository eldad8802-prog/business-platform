/**
 * May this business send WhatsApp messages to its customers? (G1 — appointments completion program.) SERVER-ONLY.
 *
 * Owner decision (SPEC "Entitlements"): customer WhatsApp is an ADVANCED capability, the same one as the public link —
 * it needs `appointments` AND `public_booking` available to the business (the existing feature-access resolver, the
 * same answer guardFeature / featureAllowedForBusiness read: flags, admin overrides, emergency switch). The plan
 * layer (resolvePlanEntitlement: plan ADVANCED, trial = full, testers = full) is computed and LOGGED in shadow
 * (`subscription_would_deny`), exactly like every other module in subscriptions stage A/B: it never changes the
 * answer — enforcing the plan is the owner's stage C decision (no enforce mode exists, by design).
 *
 * Kill switch: the notification engine's operator switch (`notifications_engine`, per business or by its emergency
 * switch) is ANDed in — OFF stops every customer send path (customerMessagesFlagsAllow).
 *
 * Fail closed: an error resolving the flags reads as "not allowed" (nothing owed, nothing sent).
 *
 * Two entry points:
 *   customerMessagesAllowedInTx(tx, businessId) — the producers, inside the appointment's own tenant transaction
 *     (the resolver reads through that same transaction: no second connection under the appointment lock);
 *   customerMessagesEntitlement(businessId) — the WhatsApp lane at send time (flags + the plan's shadow verdict).
 */
import type { Prisma } from "@prisma/client";

import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import {
  resolveBusinessCapabilities,
  resolveBusinessCapabilitiesWith,
  type FeatureAccessReader,
} from "@/lib/services/feature-access/resolve-feature-access";
import type { FeatureAccessResult } from "@/lib/services/feature-access/feature-access.types";
import { resolvePlanEntitlement, type PlanEntitlement } from "@/lib/services/subscriptions/resolve-entitlement";
import { loadSubscriptionSnapshot, subscriptionMode } from "@/lib/services/subscriptions/subscription-shadow";
import { runWithTenantContext } from "@/lib/tenant/context";

type Tx = Prisma.TransactionClient;
type Caps = Record<string, FeatureAccessResult | undefined>;

export type CustomerMessagesEntitlement = { allowed: boolean; plan: PlanEntitlement | null };

let gateOverride: ((businessId: number) => Promise<boolean>) | null = null;
/** Test seam: replace the flag answer (the DB batteries use the real resolver; pure tests use this). */
export function __setCustomerMessagesGateForTests(fn: ((businessId: number) => Promise<boolean>) | null): void {
  gateOverride = fn;
}

/**
 * Pure: the flag answer. `appointments` AND `public_booking` (the entitlement) AND `notifications_engine` — the
 * operator's existing kill switch: OFF for a business (or by its emergency switch) stops EVERY customer send path —
 * the producers owe nothing (and close what is owed), the lane suppresses 'not_entitled', the verification API
 * refuses — without having to turn public booking off.
 */
export function customerMessagesFlagsAllow(caps: Caps): boolean {
  return caps[PLATFORM_FEATURE_KEYS.APPOINTMENTS]?.allowed === true
    && caps[PLATFORM_FEATURE_KEYS.PUBLIC_BOOKING]?.allowed === true
    && caps[PLATFORM_FEATURE_KEYS.NOTIFICATIONS_ENGINE]?.allowed === true;
}
const flagsAllow = customerMessagesFlagsAllow;

export async function customerMessagesAllowedInTx(tx: Tx, businessId: number): Promise<boolean> {
  if (gateOverride) return gateOverride(businessId);
  try {
    return flagsAllow(await resolveBusinessCapabilitiesWith(tx as unknown as FeatureAccessReader, businessId));
  } catch {
    return false;
  }
}

export async function customerMessagesEntitlement(businessId: number): Promise<CustomerMessagesEntitlement> {
  if (gateOverride) return { allowed: await gateOverride(businessId), plan: null };
  let caps: Caps;
  try {
    caps = await runWithTenantContext({ businessId }, () => resolveBusinessCapabilities(businessId));
  } catch {
    return { allowed: false, plan: null };
  }
  const allowed = flagsAllow(caps);
  let plan: PlanEntitlement | null = null;
  if (allowed && subscriptionMode() !== "off") {
    try {
      const flag = caps[PLATFORM_FEATURE_KEYS.PUBLIC_BOOKING]!;
      plan = resolvePlanEntitlement(PLATFORM_FEATURE_KEYS.PUBLIC_BOOKING, { allowed: true, reasonCode: flag.reasonCode }, await loadSubscriptionSnapshot(businessId));
      if (plan.access !== "full") {
        console.warn(JSON.stringify({
          event: "subscription_would_deny", featureKey: PLATFORM_FEATURE_KEYS.PUBLIC_BOOKING, site: "customer_whatsapp",
          businessId, access: plan.access, planReason: plan.reasonCode, requiredPlan: plan.requiredPlan,
        }));
      }
    } catch {
      plan = null; // shadow only: never affects the answer
    }
  }
  return { allowed, plan };
}
