/**
 * Subscription layer — mode and record source. SERVER-ONLY.
 *
 * MODE — env SUBSCRIPTION_ENFORCEMENT:
 *   off     — the plan layer is not computed and not logged.
 *   shadow  — DEFAULT, and the ONLY other mode that exists: every value except "off" (including "enforce") is shadow.
 *             The guard computes the plan verdict and logs `subscription_would_deny` when the plan alone would
 *             refuse what the flags allow. It never refuses anything. Enforcing the plan is stage C, behind a
 *             separate owner approval, and needs new code — no environment value can switch it on.
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

export type SubscriptionMode = "off" | "shadow";

export function subscriptionMode(env: Record<string, string | undefined> = process.env): SubscriptionMode {
  return (env[SUBSCRIPTION_ENFORCEMENT_ENV] ?? "").trim().toLowerCase() === "off" ? "off" : "shadow";
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
