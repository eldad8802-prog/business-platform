/**
 * Subscriptions & quotas — the platform-admin console's reads and writes (subscriptions stage C, decision 6.1).
 * SERVER-ONLY. ADMIN plane only (getPrismaAdmin → app_admin: NOLOGIN group, NOBYPASSRLS, read through the additive
 * p7adm_read policies of migration 20261228090000).
 *
 * WRITES go ONLY through the migration's definer functions, executable by app_admin alone; each checks inside the
 * database that the actor is a PLATFORM_ADMIN and writes its PlatformAuditEvent in the same statement:
 *   quota_policy_set · usage_metric_mode_set · quota_adjustment_add · quota_adjustment_revoke ·
 *   subscription_request_resolve
 * The routes add the platform-admin session, a FRESH second factor, a reason, and the kill switch
 * SUBSCRIPTION_ADMIN_CHANGES_ENABLED (off ⇒ 503: nothing can be written until the owner turns it on).
 * Plan / trial / tester changes of one business stay on the stage B control-plane path
 * (update-business-subscription.service.ts).
 */
import type { PrismaClient } from "@prisma/client";

import { getPrismaAdmin } from "@/lib/prisma-admin";
import { ConflictError, ValidationError } from "@/lib/errors";
import {
  METRIC_DEFINITIONS,
  OPENING_MATRIX,
  QUOTA_METRICS,
  SUBSCRIPTION_TIERS,
  isQuotaMetric,
  isSubscriptionTier,
  isUsageMetric,
  quotaCeiling,
  type QuotaMetric,
  type SubscriptionTier,
  type UsageMetric,
} from "@/lib/services/subscriptions/usage/usage-metrics";
import { parseUsageMode, usageModeCeiling, type UsageMode } from "@/lib/services/subscriptions/usage/usage-mode";
import { estimateUsageCostUsd, UNIT_COST_ESTIMATE_USD } from "@/lib/services/subscriptions/usage/usage-cost";
import { forgetFeatureGuardBusiness } from "@/lib/services/feature-access/feature-guard";

type Db = { $queryRaw: PrismaClient["$queryRaw"] };
let dbFactory: () => Db = () => getPrismaAdmin();
/** Tests / labs only: replace the admin client. */
export function __setSubscriptionsAdminDbForTests(next: (() => Db) | null): void {
  dbFactory = next ?? (() => getPrismaAdmin());
}

const n = (v: bigint | number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

function reasonOf(raw: unknown): string {
  if (typeof raw !== "string") throw new ValidationError("Reason is required");
  const r = raw.trim();
  if (r.length < 10 || r.length > 500) throw new ValidationError("Reason must be 10–500 characters");
  return r;
}

/* ------------------------------ the matrix ------------------------------ */

export type QuotaMatrixView = {
  ceiling: UsageMode;
  metrics: {
    metric: QuotaMetric;
    label: string;
    unit: string;
    cumulative: boolean;
    mode: UsageMode;
    effectiveMode: UsageMode;
    quotas: Record<SubscriptionTier, { quota: number; opening: number; version: number; updatedAt: string }>;
    unitCostUsd: number;
    unitCostVerified: boolean;
  }[];
};

export async function loadQuotaMatrix(): Promise<QuotaMatrixView> {
  const db = dbFactory();
  const policies = await db.$queryRaw<{ metric: string; tier: string; quota: bigint; version: number; updatedAt: Date }[]>`
    SELECT "metric", "tier", "quota", "version", "updatedAt" FROM "PlatformQuotaPolicy"`;
  const modes = await db.$queryRaw<{ metric: string; mode: string }[]>`SELECT "metric", "mode" FROM "PlatformUsageMetricMode"`;
  const ceiling = usageModeCeiling();
  const rank: Record<UsageMode, number> = { OFF: 0, SHADOW: 1, ENFORCE: 2 };
  return {
    ceiling,
    metrics: QUOTA_METRICS.map((metric) => {
      const mode = parseUsageMode(modes.find((m) => m.metric === metric)?.mode) ?? "SHADOW";
      const quotas = {} as QuotaMatrixView["metrics"][number]["quotas"];
      for (const tier of SUBSCRIPTION_TIERS) {
        const p = policies.find((x) => x.metric === metric && x.tier === tier);
        quotas[tier] = { quota: n(p?.quota) ?? 0, opening: OPENING_MATRIX[metric][tier], version: p?.version ?? 0, updatedAt: p?.updatedAt?.toISOString() ?? "" };
      }
      const def = METRIC_DEFINITIONS[metric];
      return {
        metric,
        label: def.label,
        unit: def.unit,
        cumulative: def.cumulative,
        mode,
        effectiveMode: rank[mode] <= rank[ceiling] ? mode : ceiling,
        quotas,
        unitCostUsd: UNIT_COST_ESTIMATE_USD[metric].perUnit,
        unitCostVerified: UNIT_COST_ESTIMATE_USD[metric].verified,
      };
    }),
  };
}

/** How many customer businesses on this tier are already above a proposed quota in their current period. */
export async function previewQuotaChange(metricRaw: unknown, tierRaw: unknown, quotaRaw: unknown): Promise<{ metric: QuotaMetric; tier: SubscriptionTier; quota: number; currentQuota: number | null; businessesAbove: number; businessesInTier: number }> {
  const { metric, tier, quota } = validatePolicy(metricRaw, tierRaw, quotaRaw);
  const db = dbFactory();
  const rows = await db.$queryRaw<{ business_id: number; quota: bigint | null; used: bigint; tier: string | null }[]>`
    SELECT s."businessId" AS business_id, c.o_quota AS quota, c.o_tier AS tier,
           COALESCE((SELECT k."used" FROM "BusinessUsageCounter" k
                      WHERE k."businessId" = s."businessId" AND k."metric" = ${metric} AND k."periodKey" = c.o_period_key), 0) AS used
      FROM "PlatformSubscription" s
      CROSS JOIN LATERAL public.usage_quota_context(s."businessId", ${metric}::text) c
     WHERE s."accountType" = 'CUSTOMER'`;
  const inTier = rows.filter((r) => r.tier === tier);
  const current = await db.$queryRaw<{ quota: bigint }[]>`SELECT "quota" FROM "PlatformQuotaPolicy" WHERE "metric" = ${metric} AND "tier" = ${tier}`;
  return {
    metric,
    tier,
    quota,
    currentQuota: n(current[0]?.quota),
    businessesAbove: inTier.filter((r) => Number(r.used) > quota).length,
    businessesInTier: inTier.length,
  };
}

function validatePolicy(metricRaw: unknown, tierRaw: unknown, quotaRaw: unknown): { metric: QuotaMetric; tier: SubscriptionTier; quota: number } {
  if (!isQuotaMetric(metricRaw)) throw new ValidationError("Unknown quota metric");
  if (!isSubscriptionTier(tierRaw)) throw new ValidationError("Unknown tier");
  if (typeof quotaRaw !== "number" || !Number.isInteger(quotaRaw) || quotaRaw < 0) throw new ValidationError("Quota must be a whole number ≥ 0");
  if (quotaRaw > quotaCeiling(metricRaw)) throw new ValidationError("Quota above the safety ceiling");
  return { metric: metricRaw, tier: tierRaw, quota: quotaRaw };
}

export async function setQuotaPolicy(actorUserId: number, body: Record<string, unknown>): Promise<{ eventId: string }> {
  const { metric, tier, quota } = validatePolicy(body.metric, body.tier, body.quota);
  const reason = reasonOf(body.reason);
  const rows = await dbFactory().$queryRaw<{ id: bigint }[]>`
    SELECT public.quota_policy_set(${actorUserId}::integer, ${metric}::text, ${tier}::text, ${quota}::bigint, ${reason}::text) AS id`;
  return { eventId: String(rows[0]?.id) };
}

export async function setUsageMode(actorUserId: number, body: Record<string, unknown>): Promise<{ changed: boolean }> {
  if (!isQuotaMetric(body.metric)) throw new ValidationError("Unknown quota metric");
  const mode = parseUsageMode(body.mode);
  if (!mode) throw new ValidationError("Mode must be OFF, SHADOW or ENFORCE");
  const reason = reasonOf(body.reason);
  const rows = await dbFactory().$queryRaw<{ changed: boolean }[]>`
    SELECT public.usage_metric_mode_set(${actorUserId}::integer, ${body.metric}::text, ${mode}::text, ${reason}::text) AS changed`;
  if (!rows[0]?.changed) throw new ConflictError("NO_CHANGE");
  return { changed: true };
}

/* --------------------------- one business --------------------------- */

export type BusinessUsageAdminView = {
  businessId: number;
  subscription: { accountType: string | null; status: string | null; plan: string | null; trialEndsAt: string | null } | null;
  metrics: { metric: UsageMetric; label: string; kind: "quota" | "measured"; tier: string | null; periodKey: string; periodEnd: string | null; quota: number | null; used: number; percent: number | null }[];
  adjustments: { id: string; metric: string; kind: string; amount: number; startsAt: string; endsAt: string | null; reason: string; revokedAt: string | null }[];
  history: { periodKey: string; metric: string; used: number }[];
  recentUnits: { metric: string; unitKey: string; amount: number; state: string; verdict: string; source: string; createdAt: string }[];
  estimatedCostUsdThisPeriod: number;
};

export async function loadBusinessUsageAdmin(businessIdRaw: unknown): Promise<BusinessUsageAdminView> {
  const businessId = Number(businessIdRaw);
  if (!Number.isInteger(businessId) || businessId <= 0) throw new ValidationError("Invalid business id");
  const db = dbFactory();
  const sub = await db.$queryRaw<{ accountType: string; status: string; plan: string | null; trialEndsAt: Date | null }[]>`
    SELECT "accountType", "status", "plan", "trialEndsAt" FROM "PlatformSubscription" WHERE "businessId" = ${businessId}`;
  const metrics: BusinessUsageAdminView["metrics"] = [];
  const costInput: Partial<Record<UsageMetric, number>> = {};
  for (const metric of Object.keys(METRIC_DEFINITIONS) as UsageMetric[]) {
    const ctx = await db.$queryRaw<{ o_tier: string | null; o_period_key: string; o_period_end: Date | null; o_quota: bigint | null }[]>`
      SELECT * FROM public.usage_quota_context(${businessId}::integer, ${metric}::text)`;
    const c = ctx[0];
    if (!c) continue;
    const used = await db.$queryRaw<{ used: bigint }[]>`
      SELECT "used" FROM "BusinessUsageCounter" WHERE "businessId" = ${businessId} AND "metric" = ${metric} AND "periodKey" = ${c.o_period_key}`;
    const u = n(used[0]?.used) ?? 0;
    const quota = n(c.o_quota);
    costInput[metric] = u;
    metrics.push({
      metric,
      label: METRIC_DEFINITIONS[metric].label,
      kind: METRIC_DEFINITIONS[metric].kind,
      tier: c.o_tier,
      periodKey: c.o_period_key,
      periodEnd: c.o_period_end ? c.o_period_end.toISOString() : null,
      quota,
      used: u,
      percent: quota && quota > 0 ? Math.round((u / quota) * 100) : null,
    });
  }
  const adjustments = await db.$queryRaw<{ id: bigint; metric: string; kind: string; amount: bigint; startsAt: Date; endsAt: Date | null; reason: string; revokedAt: Date | null }[]>`
    SELECT "id", "metric", "kind", "amount", "startsAt", "endsAt", "reason", "revokedAt" FROM "BusinessQuotaAdjustment"
     WHERE "businessId" = ${businessId} ORDER BY "createdAt" DESC LIMIT 50`;
  const history = await db.$queryRaw<{ periodKey: string; metric: string; used: bigint }[]>`
    SELECT "periodKey", "metric", "used" FROM "BusinessUsageCounter" WHERE "businessId" = ${businessId} ORDER BY "updatedAt" DESC LIMIT 120`;
  const units = await db.$queryRaw<{ metric: string; unitKey: string; amount: bigint; state: string; verdict: string; source: string; createdAt: Date }[]>`
    SELECT "metric", "unitKey", "amount", "state", "verdict", "source", "createdAt" FROM "BusinessUsageEvent"
     WHERE "businessId" = ${businessId} ORDER BY "createdAt" DESC LIMIT 100`;
  const s = sub[0];
  return {
    businessId,
    subscription: s ? { accountType: s.accountType, status: s.status, plan: s.plan, trialEndsAt: s.trialEndsAt?.toISOString() ?? null } : null,
    metrics,
    adjustments: adjustments.map((a) => ({
      id: a.id.toString(),
      metric: a.metric,
      kind: a.kind,
      amount: Number(a.amount),
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt?.toISOString() ?? null,
      reason: a.reason,
      revokedAt: a.revokedAt?.toISOString() ?? null,
    })),
    history: history.map((h) => ({ periodKey: h.periodKey, metric: h.metric, used: Number(h.used) })),
    // Identifiers and amounts only — never document content.
    recentUnits: units.map((x) => ({ metric: x.metric, unitKey: x.unitKey, amount: Number(x.amount), state: x.state, verdict: x.verdict, source: x.source, createdAt: x.createdAt.toISOString() })),
    estimatedCostUsdThisPeriod: estimateUsageCostUsd(costInput),
  };
}

export async function addQuotaAdjustment(actorUserId: number, businessIdRaw: unknown, body: Record<string, unknown>): Promise<{ adjustmentId: string }> {
  const businessId = Number(businessIdRaw);
  if (!Number.isInteger(businessId) || businessId <= 0) throw new ValidationError("Invalid business id");
  if (!isQuotaMetric(body.metric)) throw new ValidationError("Unknown quota metric");
  if (body.kind !== "ADD" && body.kind !== "OVERRIDE") throw new ValidationError("Kind must be ADD or OVERRIDE");
  if (typeof body.amount !== "number" || !Number.isInteger(body.amount) || body.amount < 0 || body.amount > quotaCeiling(body.metric)) {
    throw new ValidationError("Amount must be a whole number within the safety ceiling");
  }
  let endsAt: Date | null = null;
  if (body.endsAt !== undefined && body.endsAt !== null) {
    endsAt = new Date(String(body.endsAt));
    if (Number.isNaN(endsAt.getTime()) || endsAt.getTime() <= Date.now()) throw new ValidationError("endsAt must be a future date");
  }
  const reason = reasonOf(body.reason);
  const rows = await dbFactory().$queryRaw<{ id: bigint }[]>`
    SELECT public.quota_adjustment_add(${actorUserId}::integer, ${businessId}::integer, ${body.metric}::text, ${body.kind}::text,
                                       ${body.amount}::bigint, ${endsAt}::timestamp, ${reason}::text) AS id`;
  forgetFeatureGuardBusiness(businessId);
  return { adjustmentId: String(rows[0]?.id) };
}

export async function revokeQuotaAdjustment(actorUserId: number, idRaw: unknown, body: Record<string, unknown>): Promise<{ revoked: true }> {
  if (typeof idRaw !== "string" || !/^\d{1,18}$/.test(idRaw)) throw new ValidationError("Invalid adjustment id");
  const reason = reasonOf(body.reason);
  const rows = await dbFactory().$queryRaw<{ ok: boolean }[]>`
    SELECT public.quota_adjustment_revoke(${actorUserId}::integer, ${idRaw}::bigint, ${reason}::text) AS ok`;
  if (!rows[0]?.ok) throw new ConflictError("NOT_ACTIVE");
  return { revoked: true };
}

/* ------------------------------ requests ------------------------------ */

export async function listSubscriptionRequests(status: "OPEN" | "HANDLED" | "DISMISSED" = "OPEN") {
  const rows = await dbFactory().$queryRaw<{ id: bigint; businessId: number; businessName: string | null; kind: string; requestedPlan: string | null; metric: string | null; note: string | null; createdAt: Date; handledAt: Date | null }[]>`
    SELECT r."id", r."businessId", b."name" AS "businessName", r."kind", r."requestedPlan", r."metric", r."note", r."createdAt", r."handledAt"
      FROM "PlatformSubscriptionRequest" r LEFT JOIN "Business" b ON b."id" = r."businessId"
     WHERE r."status" = ${status} ORDER BY r."createdAt" DESC LIMIT 200`;
  return rows.map((r) => ({ ...r, id: r.id.toString(), createdAt: r.createdAt.toISOString(), handledAt: r.handledAt?.toISOString() ?? null }));
}

export async function resolveSubscriptionRequest(actorUserId: number, idRaw: unknown, body: Record<string, unknown>): Promise<{ resolved: true }> {
  if (typeof idRaw !== "string" || !/^\d{1,18}$/.test(idRaw)) throw new ValidationError("Invalid request id");
  if (body.status !== "HANDLED" && body.status !== "DISMISSED") throw new ValidationError("Status must be HANDLED or DISMISSED");
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : null;
  const rows = await dbFactory().$queryRaw<{ ok: boolean }[]>`
    SELECT public.subscription_request_resolve(${actorUserId}::integer, ${idRaw}::bigint, ${body.status}::text, ${note}::text) AS ok`;
  if (!rows[0]?.ok) throw new ConflictError("NOT_OPEN");
  return { resolved: true };
}

/* ------------------------------ overview ------------------------------ */

export type SubscriptionsOverviewRow = {
  businessId: number;
  name: string | null;
  accountType: string | null;
  status: string | null;
  plan: string | null;
  trialEndsAt: string | null;
  openRequests: number;
  overShadowUnits: number;
  maxPercent: number | null;
  estimatedCostUsdThisMonth: number;
};

/** Every business with its subscription state, open requests and unusual usage (≥ 80 % of a quota, or OVER_SHADOW). */
export async function loadSubscriptionsOverview(): Promise<{ rows: SubscriptionsOverviewRow[]; unusual: SubscriptionsOverviewRow[] }> {
  const db = dbFactory();
  const base = await db.$queryRaw<{ businessId: number; name: string | null; accountType: string | null; status: string | null; plan: string | null; trialEndsAt: Date | null; openRequests: bigint; overShadow: bigint }[]>`
    SELECT b."id" AS "businessId", b."name", s."accountType", s."status", s."plan", s."trialEndsAt",
           (SELECT count(*) FROM "PlatformSubscriptionRequest" r WHERE r."businessId" = b."id" AND r."status" = 'OPEN') AS "openRequests",
           (SELECT count(*) FROM "BusinessUsageEvent" e WHERE e."businessId" = b."id" AND e."verdict" = 'OVER_SHADOW'
               AND e."createdAt" > (now() AT TIME ZONE 'UTC') - interval '31 days') AS "overShadow"
      FROM "Business" b LEFT JOIN "PlatformSubscription" s ON s."businessId" = b."id"
     WHERE b."name" <> '__PLATFORM_SYSTEM__'
     ORDER BY b."id"`;
  const usage = await db.$queryRaw<{ businessId: number; metric: string; used: bigint; quota: bigint | null }[]>`
    SELECT k."businessId", k."metric", k."used", c.o_quota AS quota
      FROM "BusinessUsageCounter" k
      CROSS JOIN LATERAL public.usage_quota_context(k."businessId", k."metric") c
     WHERE k."periodKey" = c.o_period_key`;
  const rows: SubscriptionsOverviewRow[] = base.map((b) => {
    const mine = usage.filter((u) => u.businessId === b.businessId);
    const percents = mine.filter((u) => u.quota !== null && Number(u.quota) > 0).map((u) => Math.round((Number(u.used) / Number(u.quota)) * 100));
    const cost: Partial<Record<UsageMetric, number>> = {};
    for (const u of mine) if (isUsageMetric(u.metric)) cost[u.metric] = Number(u.used);
    return {
      businessId: b.businessId,
      name: b.name,
      accountType: b.accountType,
      status: b.status,
      plan: b.plan,
      trialEndsAt: b.trialEndsAt?.toISOString() ?? null,
      openRequests: Number(b.openRequests),
      overShadowUnits: Number(b.overShadow),
      maxPercent: percents.length ? Math.max(...percents) : null,
      estimatedCostUsdThisMonth: estimateUsageCostUsd(cost),
    };
  });
  const unusual = rows
    .filter((r) => r.overShadowUnits > 0 || (r.maxPercent ?? 0) >= 80)
    .sort((a, b) => (b.maxPercent ?? 0) - (a.maxPercent ?? 0) || b.overShadowUnits - a.overShadowUnits);
  return { rows, unusual };
}
