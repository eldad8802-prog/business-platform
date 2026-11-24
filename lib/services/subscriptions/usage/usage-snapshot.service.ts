/**
 * "My usage" — the business's own subscription and quota picture (subscriptions stage C, decisions 6.2 / 14).
 * SERVER-ONLY. TENANT path: one tenant transaction for the business in the session, through the runtime's read
 * function usage_quota_snapshot (the database computes tier, period and quota exactly as usage_consume does) and its own
 * rows only (FORCE RLS). The owner screens that show it wait for the design approval; this is the data they will read.
 */
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

import { effectiveSubscriptionStatus } from "../subscription.types";
import { readSubscriptionRecord } from "../subscription-record";
import { METRIC_DEFINITIONS, QUOTA_METRICS, type QuotaMetric } from "./usage-metrics";
import { usageModeCeiling } from "./usage-mode";

export type MetricUsageView = {
  metric: QuotaMetric;
  label: string;
  unit: string;
  cumulative: boolean;
  /** null = not limited for this account (tester / internal / no record). */
  quota: number | null;
  used: number;
  remaining: number | null;
  percent: number | null;
  renewsAt: string | null;
  reached: boolean;
};

export type UsageView = {
  subscription: {
    record: boolean;
    accountType: string | null;
    status: string | null;
    plan: string | null;
    trialEndsAt: string | null;
    trialDaysLeft: number | null;
  };
  enforced: boolean;
  metrics: MetricUsageView[];
  openRequests: { id: string; kind: string; requestedPlan: string | null; metric: string | null; createdAt: string }[];
  /** Never limited, whatever the quotas say (the rights floor) — shown as a fixed line. */
  rightsFloor: string;
};

type SnapshotRow = { tier: string | null; period_key: string; period_start: Date | null; period_end: Date | null; quota: bigint | null; used: bigint };

export async function loadUsageView(businessId: number, now: Date = new Date()): Promise<UsageView> {
  const record = await readSubscriptionRecord(businessId).catch(() => null);
  const { metrics, requests } = await runWithTenantContext({ businessId }, () =>
    withTenantTransaction(async (tx) => {
      // One statement for every quota metric (the database computes tier, period and quota per metric).
      const snapshots = await tx.$queryRaw<(SnapshotRow & { metric: string })[]>`
        SELECT m.metric, s.* FROM unnest(${[...QUOTA_METRICS]}::text[]) AS m(metric)
         CROSS JOIN LATERAL public.usage_quota_snapshot(m.metric) s`;
      const metrics: MetricUsageView[] = QUOTA_METRICS.map((metric: QuotaMetric) => {
        const r = snapshots.find((x) => x.metric === metric);
        const quota = r?.quota === null || r?.quota === undefined ? null : Number(r.quota);
        const used = r ? Number(r.used) : 0;
        const def = METRIC_DEFINITIONS[metric];
        return {
          metric,
          label: def.label,
          unit: def.unit,
          cumulative: def.cumulative,
          quota,
          used,
          remaining: quota === null ? null : Math.max(0, quota - used),
          percent: quota === null || quota === 0 ? null : Math.min(100, Math.round((used / quota) * 100)),
          renewsAt: def.cumulative || !r?.period_end ? null : r.period_end.toISOString(),
          reached: quota !== null && used >= quota,
        };
      });
      const requests = await tx.$queryRaw<{ id: bigint; kind: string; requestedPlan: string | null; metric: string | null; createdAt: Date }[]>`
        SELECT "id", "kind", "requestedPlan", "metric", "createdAt" FROM "PlatformSubscriptionRequest"
         WHERE "businessId" = ${businessId} AND "status" = 'OPEN' ORDER BY "createdAt" DESC LIMIT 20`;
      return { metrics, requests };
    }),
  );
  const status = record ? effectiveSubscriptionStatus(record, now) : null;
  const trialEndsAt = record?.trialEndsAt ?? null;
  return {
    subscription: {
      record: record !== null,
      accountType: record?.accountType ?? null,
      status,
      plan: record?.plan ?? null,
      trialEndsAt: trialEndsAt ? trialEndsAt.toISOString() : null,
      trialDaysLeft:
        status === "TRIALING" && trialEndsAt ? Math.max(0, Math.ceil((trialEndsAt.getTime() - now.getTime()) / 86_400_000)) : null,
    },
    enforced: usageModeCeiling() === "ENFORCE",
    metrics,
    openRequests: requests.map((r) => ({
      id: r.id.toString(),
      kind: r.kind,
      requestedPlan: r.requestedPlan,
      metric: r.metric,
      createdAt: r.createdAt.toISOString(),
    })),
    rightsFloor: "צפייה, הורדה וייצוא של מסמכי המס והמידע שלך אינם מוגבלים אף פעם.",
  };
}
