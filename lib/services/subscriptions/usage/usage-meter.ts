/**
 * The central usage meter — the ONE entry point every feature calls to count a unit of usage (subscriptions stage C,
 * decisions 17–29). SERVER-ONLY. TENANT path.
 *
 *   consumeUsage(...)  counts one unit (an upload, a scanned page, a new document, bytes stored…) for the business,
 *                      through the database function usage_consume (migration 20261228090000): atomic under a counter
 *                      row lock, idempotent per unit key, period and quota resolved inside the database.
 *   settleUsage(...)   finishes a RESERVED unit after a provider call — COUNTED (charged), RELEASED (proved not charged:
 *                      the quota is given back) or UNKNOWN (kept counted) — or releases a stored file's bytes on delete.
 *   requireUsage(...)  consumeUsage + throws QuotaExhaustedError when the answer is "refused".
 *   checkUsageHeadroom(...)  read-only: would N more units fit (for a check BEFORE work whose unit id is known after).
 *
 * WHERE IT RUNS — always BEFORE the work it counts, and atomically:
 *   - outside a tenant transaction: its own short transaction;
 *   - INSIDE an open tenant transaction of the same business: the SAME transaction, behind a SAVEPOINT — the unit is
 *     counted (or refused) before the caller writes, a caller that rolls back rolls the count back with it, and no
 *     second connection is ever requested (a deployment with connection_limit 1 would wait on itself). An error of the
 *     meter rolls back to the savepoint only — the caller's transaction stays usable.
 *
 * Never a silent denial, never a lost unit: when the meter itself cannot answer (no table yet, a database error) the
 * call is ALLOWED and logged (usage_meter_failed). Only an explicit DENIED from the database, in ENFORCE, for a
 * CUSTOMER refuses.
 *
 * Alerts: when a counted unit takes a customer's usage across 80 / 90 / 100 % of its quota, the business is notified
 * ONCE per threshold and period (usage_mark_alert + the notification engine) — after the count, in a separate step that
 * can never undo it.
 */
import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { runWithTenantContext } from "@/lib/tenant/context";
import { currentTenantTransaction, withTenantTransaction, type TenantTx } from "@/lib/tenant/transaction";
import { notify } from "@/lib/notifications/engine/notify";

import { METRIC_DEFINITIONS, type UsageMetric } from "./usage-metrics";
import { effectiveUsageMode, parseUsageMode, usageModeCeiling, type UsageMode } from "./usage-mode";

export type UsageOutcome = "COUNTED" | "DUPLICATE" | "DENIED" | "SKIPPED" | "UNAVAILABLE";

export type UsageDecision = {
  allowed: boolean;
  outcome: UsageOutcome;
  metric: UsageMetric;
  mode: UsageMode;
  used: number | null;
  quota: number | null;
  periodKey: string | null;
  periodEnd: Date | null;
  accountType: string | null;
  verdict: string | null;
};

export type ConsumeInput = {
  businessId: number;
  metric: UsageMetric;
  /** Identity of the unit: the same key is counted once (a retry answers DUPLICATE). ≤ 200 characters. */
  unitKey: string;
  /** Units (pages, bytes…). Default 1. */
  amount?: number;
  /** Where the unit comes from, for the ledger (e.g. "documents.upload", "gmail.import"). */
  source: string;
  /** A call to an external provider follows: RESERVED until settleUsage(). */
  reserve?: boolean;
  /**
   * Count it, never refuse it — a unit whose refusal waits on an accounting decision (a receipt documenting a payment
   * received, decision 11 / owner 2026-11-24): measured against the same quota, visible as OVER_SHADOW, never blocked.
   */
  neverRefuse?: boolean;
};

export class QuotaExhaustedError extends Error {
  readonly code = "QUOTA_EXHAUSTED" as const;
  constructor(readonly decision: UsageDecision) {
    super(`quota exhausted: ${decision.metric}`);
    this.name = "QuotaExhaustedError";
  }
}

export const ALERT_THRESHOLDS = [80, 90, 100] as const;

/** Pure: the highest threshold the used amount reached (0 = none). */
export function thresholdReached(used: number, quota: number | null): 0 | 80 | 90 | 100 {
  if (quota === null || quota <= 0) return 0;
  const pct = (used / quota) * 100;
  if (pct >= 100) return 100;
  if (pct >= 90) return 90;
  if (pct >= 80) return 80;
  return 0;
}

type Row = {
  outcome: string;
  used: bigint | number | null;
  quota: bigint | number | null;
  period_key: string | null;
  period_end: Date | null;
  account_type: string | null;
  verdict: string | null;
};

const num = (v: bigint | number | null): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * The database step. Inside an open tenant transaction of the same business: that transaction, behind a savepoint.
 * Otherwise: a short tenant transaction of its own. Replaceable in tests.
 */
type Runner = <T>(businessId: number, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
const defaultRunner: Runner = async (businessId, fn) => {
  const open = currentTenantTransaction();
  if (open && open.businessId === businessId) {
    const sp = `usage_${randomUUID().replace(/-/g, "")}`;
    await open.tx.$executeRawUnsafe(`SAVEPOINT ${sp}`);
    try {
      const out = await fn(open.tx);
      await open.tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${sp}`);
      return out;
    } catch (error) {
      await open.tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => undefined);
      throw error;
    }
  }
  return runWithTenantContext({ businessId }, () => withTenantTransaction(fn));
};
let runner: Runner = defaultRunner;
export function __setUsageRunnerForTests(next: Runner | null): void {
  runner = next ?? defaultRunner;
}

function log(event: string, fields: Record<string, unknown>): void {
  console.warn(JSON.stringify({ event, ...fields }));
}

async function readMetricMode(tx: TenantTx, metric: UsageMetric): Promise<UsageMode | null> {
  const rows = await tx.$queryRaw<{ mode: string }[]>`SELECT "mode" FROM "PlatformUsageMetricMode" WHERE "metric" = ${metric}`;
  return parseUsageMode(rows[0]?.mode);
}

function decision(metric: UsageMetric, mode: UsageMode, outcome: UsageOutcome, row?: Row): UsageDecision {
  return {
    allowed: outcome !== "DENIED",
    outcome,
    metric,
    mode,
    used: row ? num(row.used) : null,
    quota: row ? num(row.quota) : null,
    periodKey: row?.period_key ?? null,
    periodEnd: row?.period_end ?? null,
    accountType: row?.account_type ?? null,
    verdict: row?.verdict ?? null,
  };
}

async function maybeAlert(tx: TenantTx, businessId: number, metric: UsageMetric, d: UsageDecision): Promise<void> {
  const pct = thresholdReached(d.used ?? 0, d.quota);
  if (pct === 0 || d.accountType !== "CUSTOMER" || !d.periodKey) return;
  const marked = await tx.$queryRaw<{ raised: boolean }[]>`
    SELECT public.usage_mark_alert(${metric}::text, ${d.periodKey}::text, ${pct}::integer) AS raised`;
  if (!marked[0]?.raised) return;
  const label = METRIC_DEFINITIONS[metric].label;
  await notify(tx, {
    businessId,
    category: "subscription.usage",
    entity: { type: "usage_metric", id: pct },
    dedupeKey: `usage:${metric}:${d.periodKey}:${pct}`,
    title: pct >= 100 ? `הגעת למכסה: ${label}` : `ניצלת ${pct}% מהמכסה: ${label}`,
    summary: null,
    href: "/settings",
    now: new Date(),
  });
}

export async function consumeUsage(input: ConsumeInput): Promise<UsageDecision> {
  const ceiling = usageModeCeiling();
  if (ceiling === "OFF") return decision(input.metric, "OFF", "SKIPPED");
  const amount = input.amount ?? 1;
  if (!Number.isFinite(amount) || amount <= 0) return decision(input.metric, ceiling, "SKIPPED");
  let d: UsageDecision;
  try {
    d = await runner(input.businessId, async (tx) => {
      const mode = effectiveUsageMode(input.metric, await readMetricMode(tx, input.metric), ceiling);
      if (mode === "OFF") return decision(input.metric, mode, "SKIPPED");
      const enforce = mode === "ENFORCE" && input.neverRefuse !== true;
      const rows = await tx.$queryRaw<Row[]>`
        SELECT * FROM public.usage_consume(${input.metric}::text, ${input.unitKey.slice(0, 200)}::text, ${Math.ceil(amount)}::bigint,
                                           ${input.source}::text, ${input.reserve === true}::boolean, ${enforce}::boolean)`;
      const row = rows[0];
      if (!row) return decision(input.metric, mode, "UNAVAILABLE");
      const outcome = (["COUNTED", "DUPLICATE", "DENIED"] as const).find((o) => o === row.outcome) ?? "UNAVAILABLE";
      if (row.verdict === "OVER_SHADOW" && outcome === "COUNTED") {
        log("usage_would_deny", { businessId: input.businessId, metric: input.metric, used: num(row.used), quota: num(row.quota), source: input.source, neverRefuse: input.neverRefuse === true });
      }
      if (outcome === "DENIED") {
        log("usage_denied", { businessId: input.businessId, metric: input.metric, used: num(row.used), quota: num(row.quota), source: input.source });
      }
      return decision(input.metric, mode, outcome, row);
    });
  } catch (error) {
    log("usage_meter_failed", {
      businessId: input.businessId,
      metric: input.metric,
      source: input.source,
      error: error instanceof Prisma.PrismaClientKnownRequestError ? error.code : error instanceof Error ? error.name : "unknown",
    });
    return decision(input.metric, ceiling, "UNAVAILABLE");
  }
  // The alert never runs inside the caller's transaction and never takes the counted unit with it.
  if (d.outcome === "COUNTED" && d.accountType === "CUSTOMER" && thresholdReached(d.used ?? 0, d.quota) > 0) {
    const raise = () =>
      runWithTenantContext({ businessId: input.businessId }, () => withTenantTransaction((tx) => maybeAlert(tx, input.businessId, input.metric, d)));
    if (currentTenantTransaction()) {
      // The caller still holds its transaction (and maybe the only connection): raise it once that work is done.
      setTimeout(() => void raise().catch((e) => log("usage_alert_failed", { businessId: input.businessId, metric: input.metric, error: e instanceof Error ? e.name : "unknown" })), 0);
    } else {
      await raise().catch((e) => log("usage_alert_failed", { businessId: input.businessId, metric: input.metric, error: e instanceof Error ? e.name : "unknown" }));
    }
  }
  return d;
}

/** consumeUsage, then throw when refused. Use where the caller must stop BEFORE doing the work. */
export async function requireUsage(input: ConsumeInput): Promise<UsageDecision> {
  const d = await consumeUsage(input);
  if (!d.allowed) throw new QuotaExhaustedError(d);
  return d;
}

export type SettleState = "COUNTED" | "RELEASED" | "UNKNOWN";

/** Never throws. Returns the new state, NOOP, or null when the meter could not answer (logged). */
export async function settleUsage(input: { businessId: number; metric: UsageMetric; unitKey: string; state: SettleState }): Promise<string | null> {
  if (usageModeCeiling() === "OFF") return null;
  try {
    return await runner(input.businessId, async (tx) => {
      const rows = await tx.$queryRaw<{ state: string }[]>`
        SELECT public.usage_settle(${input.metric}::text, ${input.unitKey.slice(0, 200)}::text, ${input.state}::text) AS state`;
      return rows[0]?.state ?? null;
    });
  } catch (error) {
    log("usage_settle_failed", { businessId: input.businessId, metric: input.metric, error: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}

/**
 * Read-only: would `amount` more units fit? Refuses (allowed false) only in ENFORCE, only for a customer, only when the
 * quota would be exceeded. For work whose unit id exists only AFTER it is created (a new billing draft): the caller
 * checks first and counts right after. Never writes; fail-open like the meter.
 */
export async function checkUsageHeadroom(input: { businessId: number; metric: UsageMetric; amount: number }): Promise<UsageDecision> {
  const ceiling = usageModeCeiling();
  if (ceiling === "OFF") return decision(input.metric, "OFF", "SKIPPED");
  try {
    return await runner(input.businessId, async (tx) => {
      const mode = effectiveUsageMode(input.metric, await readMetricMode(tx, input.metric), ceiling);
      if (mode !== "ENFORCE") return decision(input.metric, mode, "SKIPPED");
      const rows = await tx.$queryRaw<{ tier: string | null; period_key: string; period_end: Date | null; quota: bigint | null; used: bigint }[]>`
        SELECT * FROM public.usage_quota_snapshot(${input.metric}::text)`;
      const r = rows[0];
      if (!r || r.tier === null || r.quota === null) return decision(input.metric, mode, "SKIPPED");
      const row: Row = { outcome: "", used: r.used, quota: r.quota, period_key: r.period_key, period_end: r.period_end, account_type: "CUSTOMER", verdict: null };
      return decision(input.metric, mode, Number(r.used) + input.amount > Number(r.quota) ? "DENIED" : "SKIPPED", row);
    });
  } catch (error) {
    log("usage_headroom_failed", { businessId: input.businessId, metric: input.metric, error: error instanceof Error ? error.name : "unknown" });
    return decision(input.metric, ceiling, "UNAVAILABLE");
  }
}

/** The JSON a refused request answers with (403, code QUOTA_EXHAUSTED) — the same shape everywhere. */
export function quotaExhaustedBody(d: UsageDecision): Record<string, unknown> {
  const label = METRIC_DEFINITIONS[d.metric].label;
  return {
    error: "QUOTA_EXHAUSTED",
    code: "QUOTA_EXHAUSTED",
    metric: d.metric,
    label,
    used: d.used,
    quota: d.quota,
    renewsAt: d.periodEnd ? d.periodEnd.toISOString() : null,
    message: d.periodEnd
      ? `הגעת למכסת "${label}" במסלול שלך. המכסה מתחדשת ב-${d.periodEnd.toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem" })}.`
      : `הגעת למכסת "${label}" במסלול שלך.`,
  };
}
