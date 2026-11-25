/**
 * Plan entitlement — the subscription layer on top of feature access. PURE, no database, no I/O.
 *
 * The plan document (section 4) fixes the order; the first step that answers decides:
 *   1. emergency switch, unreleased capability (global OFF without an admin ENABLE), admin DISABLED  → none.
 *      These three ARE the existing feature-access answer (resolve-feature-access.ts): when it says "not allowed",
 *      the plan layer adds nothing and never opens what a flag closed.
 *   2. (rights floor — reading and exporting existing data, tax documents — is action-level: stage C.)
 *   3. FREE_LIMITED                                                                                  → the catalog's
 *      freeLimited answer for the module (full / limited / none).
 *   4. admin ENABLED for the business (pilot, gift, compensation)                                    → full.
 *   5. TESTER / INTERNAL account, or no subscription record at all                                   → full
 *      ("all existing businesses are testers", decision 5, 2026-11-20).
 *   6. TRIALING → Premium depth; ACTIVE / PAST_DUE → the plan; the plan includes the module's minPlan → full,
 *      otherwise none with PLAN_REQUIRED and the plan that would include it.
 *
 * The flag answer (`allowed`) is NEVER changed here. This module only adds a second, separate verdict that the guard
 * logs in shadow mode. Enforcing it is a later, owner-approved step (stage C).
 */
import type { FeatureAccessResult } from "@/lib/services/feature-access/feature-access.types";
import type { PlatformFeatureKey } from "@/lib/services/feature-access/platform-feature-catalog";

import { planCatalogRow, planIncludes, type SubscriptionPlan } from "./plan-catalog";
import { effectiveSubscriptionStatus, type SubscriptionSnapshot } from "./subscription.types";

export type PlanAccess = "full" | "limited" | "none";

export type PlanReasonCode =
  | "FLAG_DENIED"
  | "FREE_LIMITED"
  | "ADMIN_ENABLED"
  | "ACCOUNT_TESTER"
  | "ACCOUNT_INTERNAL"
  | "TESTER_DEFAULT"
  | "TRIAL"
  | "PLAN_INCLUDES"
  | "PLAN_REQUIRED"
  | "PLAN_MISSING";

export type PlanEntitlement = {
  featureKey: PlatformFeatureKey;
  access: PlanAccess;
  reasonCode: PlanReasonCode;
  /** The lowest plan that includes the module — set when access is "none" for lack of plan. */
  requiredPlan: SubscriptionPlan | null;
};

type FlagAnswer = Pick<FeatureAccessResult, "allowed" | "reasonCode">;

export function resolvePlanEntitlement(
  featureKey: PlatformFeatureKey,
  flag: FlagAnswer,
  subscription: SubscriptionSnapshot | null,
): PlanEntitlement {
  const row = planCatalogRow(featureKey);
  const out = (access: PlanAccess, reasonCode: PlanReasonCode, requiredPlan: SubscriptionPlan | null = null): PlanEntitlement => ({
    featureKey,
    access,
    reasonCode,
    requiredPlan,
  });

  // 1. The existing feature-access answer comes first and is final when it refuses.
  if (!flag.allowed) return out("none", "FLAG_DENIED");

  // 5 (no record). A business without a subscription record keeps today's access — it is computed as a tester.
  if (!subscription) return out("full", "TESTER_DEFAULT");

  // 5. Tester and internal accounts never enter a lifecycle: today's access, whatever the other columns say.
  if (subscription.accountType === "TESTER") return out("full", "ACCOUNT_TESTER");
  if (subscription.accountType === "INTERNAL") return out("full", "ACCOUNT_INTERNAL");

  // 3. FREE_LIMITED — only what the matrix allows for the module. A trial whose end passed already counts (stage C).
  const status = effectiveSubscriptionStatus(subscription);
  if (status === "FREE_LIMITED") return out(row.freeLimited, "FREE_LIMITED");

  // 4. An admin ENABLED override is a deliberate grant (pilot, gift) and opens the module at full depth.
  if (flag.reasonCode === "BUSINESS_ENABLED") return out("full", "ADMIN_ENABLED");

  // 6. Trial: Premium depth. The flags already closed every capability that is not released.
  if (status === "TRIALING") return out("full", "TRIAL");

  // ACTIVE / PAST_DUE (inside grace) — and EXEMPT on a CUSTOMER, which the database forbids: treat by plan.
  const plan = subscription.plan;
  if (!plan) return out("none", "PLAN_MISSING", row.minPlan);
  if (planIncludes(plan, row.minPlan)) return out("full", "PLAN_INCLUDES");
  return out("none", "PLAN_REQUIRED", row.minPlan);
}

export function resolvePlanEntitlements(
  flags: Record<PlatformFeatureKey, FlagAnswer>,
  subscription: SubscriptionSnapshot | null,
): Record<PlatformFeatureKey, PlanEntitlement> {
  const out = {} as Record<PlatformFeatureKey, PlanEntitlement>;
  for (const key of Object.keys(flags) as PlatformFeatureKey[]) {
    out[key] = resolvePlanEntitlement(key, flags[key], subscription);
  }
  return out;
}
