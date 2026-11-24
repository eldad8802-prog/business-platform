/**
 * Subscription layer — mode and record source. SERVER-ONLY.
 *
 * MODE — env SUBSCRIPTION_ENFORCEMENT:
 *   off      — the plan layer is not computed and not logged.
 *   shadow   — DEFAULT (unset or any unknown value). The gates compute the plan verdict and log
 *              `subscription_would_deny` when the plan alone would refuse what the flags allow. Nothing is refused.
 *   enforce  — stage C: the plan gate (plan-gate.ts) and the feature guard refuse a CUSTOMER whose plan does not include
 *              the action (PLAN_REQUIRED / SUBSCRIPTION_INACTIVE). Testers, internal accounts and businesses without a
 *              record are never refused. Setting it is a separate owner decision (decision 25), not part of any deploy.
 *
 * SOURCE — where the subscription record comes from: the business's PlatformSubscription row (stage B,
 * subscription-record.ts). No row = "no record", which the resolver computes as a tester (today's access). A source
 * that fails — including "the table is not there yet" if this code ever runs before migration
 * 20261224090000_platform_subscriptions — degrades to "no record" and is logged: in shadow a read failure must never
 * become a denial.
 */
import { readSubscriptionRecord } from "./subscription-record";
import type { SubscriptionSnapshot } from "./subscription.types";

export const SUBSCRIPTION_ENFORCEMENT_ENV = "SUBSCRIPTION_ENFORCEMENT";

export type SubscriptionMode = "off" | "shadow" | "enforce";

/** Unset, empty or unknown ⇒ shadow. Only the exact words "off" / "enforce" change it (stage C added "enforce"). */
export function subscriptionMode(env: Record<string, string | undefined> = process.env): SubscriptionMode {
  const raw = (env[SUBSCRIPTION_ENFORCEMENT_ENV] ?? "").trim().toLowerCase();
  if (raw === "off") return "off";
  if (raw === "enforce") return "enforce";
  return "shadow";
}

export type SubscriptionSource = (businessId: number) => Promise<SubscriptionSnapshot | null>;

/** Stage B: the PlatformSubscription row, read in a tenant transaction for the business itself. */
const defaultSource: SubscriptionSource = readSubscriptionRecord;

let source: SubscriptionSource = defaultSource;

/** Tests only: replace the record source. Pass null to restore the default. */
export function __setSubscriptionSourceForTests(next: SubscriptionSource | null): void {
  source = next ?? defaultSource;
}

/** Never throws: a failed read is logged and answers "no record" (today's access). */
export async function loadSubscriptionSnapshot(businessId: number): Promise<SubscriptionSnapshot | null> {
  try {
    return await source(businessId);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "subscription_read_failed",
        businessId,
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
    return null;
  }
}
