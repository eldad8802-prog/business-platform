/**
 * The subscription record as the entitlement layer sees it. Mirrors the PlatformSubscription row (stage B) without
 * depending on Prisma, so the resolver stays pure and testable.
 */
import type { SubscriptionPlan } from "./plan-catalog";

/** Who the account is. TESTER and INTERNAL keep exactly today's access and never enter a trial or FREE_LIMITED. */
export const SUBSCRIPTION_ACCOUNT_TYPES = ["CUSTOMER", "TESTER", "INTERNAL"] as const;
export type SubscriptionAccountType = (typeof SUBSCRIPTION_ACCOUNT_TYPES)[number];

/**
 * Lifecycle state (plan document section 5):
 *   EXEMPT       — TESTER / INTERNAL accounts: no lifecycle at all;
 *   TRIALING     — a new business in its trial (stage C; Premium depth, released capabilities only);
 *   ACTIVE       — a paying customer on `plan` (cancel = cancelAtPeriodEnd, still ACTIVE until the period ends);
 *   PAST_DUE     — a failed payment inside the grace period (stage D; full plan access meanwhile);
 *   FREE_LIMITED — trial ended without purchase, grace ran out, or the cancelled period ended.
 */
export const SUBSCRIPTION_STATUSES = ["EXEMPT", "TRIALING", "ACTIVE", "PAST_DUE", "FREE_LIMITED"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export type SubscriptionSnapshot = {
  accountType: SubscriptionAccountType;
  status: SubscriptionStatus;
  plan: SubscriptionPlan | null;
  catalogVersion: string;
};
