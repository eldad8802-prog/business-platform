/**
 * The owner's subscription view (subscriptions stage C; owner decision 2026-11-25 — DISPLAY ONLY).
 * SERVER-ONLY. TENANT path: one tenant transaction for the business in the session.
 *
 * The owner does NOT see counters, quotas, progress bars or percentages. The quota mechanism (metering, enforcement,
 * admin control) is unchanged and runs behind the scenes; this view only answers:
 *   - what the subscription is (plan / trial / limited) and when the trial ends — as plain facts;
 *   - what needs the owner's ATTENTION now (attention[]): the trial ends within TRIAL_ATTENTION_DAYS, the account is
 *     limited, or a quota that is ENFORCED is nearly used (90%) or used up. In shadow nothing is limited, so nothing
 *     is said — the owner is never told about a limit that does not apply;
 *   - the plan TERMS (each plan's limits), shown before choosing a plan — read from the live policy table, so an admin
 *     change of a quota is what the customer reads, without a deploy;
 *   - the open request, if any.
 * Testers / internal accounts / businesses without a record: visible=false (they have no subscription to manage).
 */
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

import { PREMIUM_COMMERCIALLY_OPEN, SUBSCRIPTION_PLANS, type SubscriptionPlan } from "./plan-catalog";
import { effectiveSubscriptionStatus } from "./subscription.types";
import { readSubscriptionRecord } from "./subscription-record";
import { subscriptionMode } from "./subscription-shadow";
import { METRIC_DEFINITIONS, QUOTA_METRICS, isQuotaMetric, type QuotaMetric } from "./usage/usage-metrics";
import { effectiveUsageMode, parseUsageMode, usageModeCeiling } from "./usage/usage-mode";

/** The trial-ending message appears this many days before the end (owner design, 2026-11-24). */
export const TRIAL_ATTENTION_DAYS = 7;
/** A quota "needs attention" from this share of use (the 90% alert threshold). */
export const QUOTA_ATTENTION_PCT = 90;

export type SubscriptionAttention =
  | { kind: "trial_ending"; daysLeft: number; endsAt: string }
  | { kind: "limited" }
  | { kind: "quota_near" | "quota_reached"; metric: QuotaMetric; label: string; renewsAt: string | null };

export type PlanTerm = { metric: QuotaMetric; label: string; quota: number; unit: string; cumulative: boolean };
export type PlanTerms = { plan: SubscriptionPlan; open: boolean; terms: PlanTerm[] };

export type SubscriptionView = {
  visible: boolean;
  status: string | null;
  plan: string | null;
  trialEndsAt: string | null;
  attention: SubscriptionAttention[];
  openRequest: { kind: string; requestedPlan: string | null; metric: string | null; createdAt: string } | null;
  plans: PlanTerms[];
  rightsFloor: string;
};

const RIGHTS_FLOOR = "צפייה, הורדה וייצוא של מסמכי המס והמידע שלך אינם מוגבלים אף פעם.";

type SnapshotRow = { metric: string; quota: bigint | null; used: bigint; period_end: Date | null };

/** Pure: the attention items, from facts only (exported for the tests). */
export function attentionFor(input: {
  status: string | null;
  trialEndsAt: Date | null;
  subscriptionEnforced: boolean;
  quotas: { metric: QuotaMetric; quota: number | null; used: number; enforced: boolean; renewsAt: Date | null }[];
  now: Date;
}): SubscriptionAttention[] {
  const out: SubscriptionAttention[] = [];
  if (input.status === "TRIALING" && input.trialEndsAt) {
    const daysLeft = Math.max(0, Math.ceil((input.trialEndsAt.getTime() - input.now.getTime()) / 86_400_000));
    if (daysLeft <= TRIAL_ATTENTION_DAYS) out.push({ kind: "trial_ending", daysLeft, endsAt: input.trialEndsAt.toISOString() });
  }
  if (input.status === "FREE_LIMITED" && input.subscriptionEnforced) out.push({ kind: "limited" });
  // In limited mode every quota is 0 by design: the limited message says it all, no per-quota noise.
  if (input.status !== "FREE_LIMITED") {
    for (const q of input.quotas) {
      if (!q.enforced || q.quota === null || q.quota <= 0) continue;
      const pct = (q.used / q.quota) * 100;
      if (pct < QUOTA_ATTENTION_PCT) continue;
      out.push({
        kind: pct >= 100 ? "quota_reached" : "quota_near",
        metric: q.metric,
        label: METRIC_DEFINITIONS[q.metric].label,
        renewsAt: METRIC_DEFINITIONS[q.metric].cumulative || !q.renewsAt ? null : q.renewsAt.toISOString(),
      });
    }
  }
  return out;
}

export async function loadSubscriptionView(businessId: number, now: Date = new Date()): Promise<SubscriptionView> {
  const record = await readSubscriptionRecord(businessId).catch(() => null);
  const visible = record !== null && record.accountType === "CUSTOMER";
  const { snapshots, modes, policy, request } = await runWithTenantContext({ businessId }, () =>
    withTenantTransaction(async (tx) => {
      const snapshots = visible
        ? await tx.$queryRaw<SnapshotRow[]>`
            SELECT m.metric, s.quota, s.used, s.period_end FROM unnest(${[...QUOTA_METRICS]}::text[]) AS m(metric)
             CROSS JOIN LATERAL public.usage_quota_snapshot(m.metric) s`
        : [];
      const modes = await tx.$queryRaw<{ metric: string; mode: string }[]>`SELECT "metric", "mode" FROM "PlatformUsageMetricMode"`;
      const policy = await tx.$queryRaw<{ metric: string; tier: string; quota: bigint }[]>`
        SELECT "metric", "tier", "quota" FROM "PlatformQuotaPolicy" WHERE "tier" IN ('BASIC', 'ADVANCED', 'PREMIUM')`;
      const requests = visible
        ? await tx.$queryRaw<{ kind: string; requestedPlan: string | null; metric: string | null; createdAt: Date }[]>`
            SELECT "kind", "requestedPlan", "metric", "createdAt" FROM "PlatformSubscriptionRequest"
             WHERE "businessId" = ${businessId} AND "status" = 'OPEN' ORDER BY "createdAt" DESC LIMIT 1`
        : [];
      return { snapshots, modes, policy, request: requests[0] ?? null };
    }),
  );

  const ceiling = usageModeCeiling();
  const enforcedMetric = (metric: QuotaMetric) =>
    effectiveUsageMode(metric, parseUsageMode(modes.find((m) => m.metric === metric)?.mode), ceiling) === "ENFORCE";
  const status = record ? effectiveSubscriptionStatus(record, now) : null;
  const trialEndsAt = record?.trialEndsAt ?? null;

  const plans: PlanTerms[] = SUBSCRIPTION_PLANS.map((plan) => ({
    plan,
    open: plan !== "PREMIUM" || PREMIUM_COMMERCIALLY_OPEN,
    terms: QUOTA_METRICS.flatMap((metric) => {
      const row = policy.find((p) => p.metric === metric && p.tier === plan);
      const quota = row ? Number(row.quota) : 0;
      if (quota <= 0) return []; // "not included" is not a term to list (video, AI below Premium)
      const def = METRIC_DEFINITIONS[metric];
      return [{ metric, label: def.label, quota, unit: def.unit, cumulative: def.cumulative }];
    }),
  }));

  return {
    visible,
    status: visible ? status : null,
    plan: visible ? (record?.plan ?? null) : null,
    trialEndsAt: visible && trialEndsAt ? trialEndsAt.toISOString() : null,
    attention: visible
      ? attentionFor({
          status,
          trialEndsAt,
          subscriptionEnforced: subscriptionMode() === "enforce",
          quotas: snapshots
            .filter((r) => isQuotaMetric(r.metric))
            .map((r) => ({
              metric: r.metric as QuotaMetric,
              quota: r.quota === null ? null : Number(r.quota),
              used: Number(r.used),
              enforced: enforcedMetric(r.metric as QuotaMetric),
              renewsAt: r.period_end,
            })),
          now,
        })
      : [],
    openRequest: request
      ? { kind: request.kind, requestedPlan: request.requestedPlan, metric: request.metric, createdAt: request.createdAt.toISOString() }
      : null,
    plans,
    rightsFloor: RIGHTS_FLOOR,
  };
}
