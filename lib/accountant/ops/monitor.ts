/**
 * The accountant package monitor (G5 milestone 1, M2) — one run:
 *
 *   1. records itself in the run log (MONITOR);
 *   2. for every business with the accountant feature, inside that business's tenant job (FORCE RLS, its own rows
 *      only): reads the operational facts — periods, building packages, sends, spam complaints — computes the
 *      findings (lib/accountant/ops/findings.ts) and reconciles that business's alerts, claiming what is due;
 *   3. the platform: the sweep's run log → SWEEP_MISSED / SWEEP_FAILED, and MONITOR_INCOMPLETE when step 2 could
 *      not look everywhere; reconciled the same way;
 *   4. ONE digest email for everything claimed (lib/accountant/ops/alert-email.ts). If it cannot be sent — no
 *      address configured, the provider failed — every claim is given back, so the next run tries again, and the
 *      run reports the failure (the endpoint answers 500, so the independent GitHub watchdog turns red);
 *   5. finishes its run-log row with counts only.
 *
 * It reads nothing it does not need, writes only the three monitoring tables, and never touches a period, a
 * package, a send or the trail: the sweep and the owner's approval behave exactly as before.
 *
 * Concurrency: two monitors (Vercel Cron and the GitHub watchdog) may overlap. Alerts are one-open-row-per-finding
 * (unique index) and claims are conditional updates under row locks, so an alert is opened once and each notice is
 * claimed by one of them; the provider idempotency key covers a retried digest.
 */

import { BusinessQuarantinedError } from "@/lib/tenant/business-lifecycle";
import { runTenantJob } from "@/lib/tenant/job";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import type { EmailProvider } from "@/lib/email/transactional/provider";
import { previousPeriodKey } from "../period";
import { prisma } from "@/lib/prisma";
import { accountantWorkflowEnabled } from "../http";
import type { DeliveryStatus } from "../workflow-status";
import { reconcileAlerts, releaseClaims, type Claim } from "./alert-store";
import { readAlertChannel, sendDigest, type AlertChannel } from "./alert-email";
import {
  businessFindings,
  COMPLAINT_WINDOW_MS,
  DELIVERY_LOOKBACK_MS,
  platformFindings,
  type BusinessFacts,
  type Finding,
} from "./findings";
import { reconcilePlatformAlerts, releasePlatformClaims } from "./platform-store";
import { finishRun, readRunFacts, startRun, type RunSource } from "./runs";

export const MONITOR_TIME_BUDGET_MS = 40_000;

export type MonitorDeps = {
  now: () => Date;
  listBusinessIds: () => Promise<number[]>;
  isEnabled: (businessId: number) => Promise<boolean>;
  sweepEnabled: () => boolean;
  webhookConfigured: () => boolean;
  channel: () => AlertChannel;
  provider?: EmailProvider;
};

export const defaultMonitorDeps: MonitorDeps = {
  now: () => new Date(),
  // Ids and lifecycle only — the same sanctioned pre-context read of the tenant root as the sweep (B4: SELECT USING
  // true). Not imported from ../sweep, which would pull the package builder (and its PDF renderer) into this route.
  listBusinessIds: async () =>
    (
      await prisma.business.findMany({
        where: { deletionRequestedAt: null, deletedAt: null },
        select: { id: true },
        orderBy: { id: "asc" },
      })
    ).map((b) => b.id),
  isEnabled: accountantWorkflowEnabled,
  sweepEnabled: () => process.env.ACCOUNTANT_SWEEP_ENABLED?.trim() === "true",
  webhookConfigured: () => !!process.env.RESEND_WEBHOOK_SECRET?.trim(),
  channel: () => readAlertChannel(),
};

export type MonitorNotification = "none" | "sent" | "failed" | "not_configured";

export type MonitorResult = {
  ok: boolean;
  notification: MonitorNotification;
  counts: {
    businesses: number;
    eligible: number;
    evaluated: number;
    businessesFailed: number;
    skippedQuarantined: number;
    budgetExhausted: boolean;
    findings: number;
    opened: number;
    resolved: number;
    openAlerts: number;
    claimed: number;
    released: number;
    latestPeriods: Record<string, number>;
    deliveries: Record<string, number>;
    findingsByCode: Record<string, number>;
  };
};

async function readBusinessFacts(businessId: number, now: Date, deps: MonitorDeps): Promise<BusinessFacts> {
  const latestKey = previousPeriodKey(now);
  return tenantTx(businessId, async (tx) => {
    const deliveries = await tx.accountantDelivery.findMany({
      where: {
        businessId,
        OR: [{ status: { in: ["APPROVED", "SENDING"] } }, { approvedAt: { gte: new Date(now.getTime() - DELIVERY_LOOKBACK_MS) } }],
      },
      select: {
        id: true,
        periodId: true,
        status: true,
        failureCode: true,
        approvedAt: true,
        nextAttemptAt: true,
        leaseUntil: true,
        acceptedAt: true,
        updatedAt: true,
      },
    });
    const buildingPackages = await tx.accountantPackage.findMany({
      where: { businessId, status: "BUILDING" },
      select: { periodId: true, createdAt: true },
    });
    const periodIds = [...new Set([...deliveries.map((d) => d.periodId), ...buildingPackages.map((b) => b.periodId)])];
    const periods = await tx.accountantPeriod.findMany({
      where: { businessId, OR: [{ periodKey: latestKey }, { id: { in: periodIds } }, { status: "PREPARATION_FAILED" }] },
      select: { id: true, periodKey: true, status: true, evaluatedAt: true },
    });
    const complaints = await tx.accountantWorkflowEvent.findMany({
      where: { businessId, eventType: "DELIVERY_COMPLAINED", occurredAt: { gte: new Date(now.getTime() - COMPLAINT_WINDOW_MS) } },
      select: { deliveryId: true },
    });
    return {
      now,
      sweepEnabled: deps.sweepEnabled(),
      webhookConfigured: deps.webhookConfigured(),
      latestKey,
      periods,
      buildingPackages,
      deliveries: deliveries.map((d) => ({ ...d, status: d.status as DeliveryStatus })),
      complainedDeliveryIds: complaints.flatMap((c) => (c.deliveryId === null ? [] : [c.deliveryId])),
    };
  });
}

const bump = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1;
};

export async function runAccountantMonitor(source: RunSource, deps: MonitorDeps = defaultMonitorDeps): Promise<MonitorResult> {
  const startedAt = deps.now();
  const runId = await startRun("MONITOR", source, startedAt);
  const counts: MonitorResult["counts"] = {
    businesses: 0,
    eligible: 0,
    evaluated: 0,
    businessesFailed: 0,
    skippedQuarantined: 0,
    budgetExhausted: false,
    findings: 0,
    opened: 0,
    resolved: 0,
    openAlerts: 0,
    claimed: 0,
    released: 0,
    latestPeriods: {},
    deliveries: {},
    findingsByCode: {},
  };
  const claimsByBusiness = new Map<number, Claim[]>();
  const platformClaims: Claim[] = [];
  const tally = (findings: Finding[]) => {
    counts.findings += findings.length;
    for (const f of findings) bump(counts.findingsByCode, f.code);
  };

  try {
    const ids = await deps.listBusinessIds();
    counts.businesses = ids.length;
    const overBudget = () => deps.now().getTime() - startedAt.getTime() > MONITOR_TIME_BUDGET_MS;
    for (const businessId of ids) {
      if (overBudget()) {
        counts.budgetExhausted = true;
        break;
      }
      try {
        if (!(await deps.isEnabled(businessId))) continue;
        counts.eligible += 1;
        await runTenantJob({ businessId }, async () => {
          const now = deps.now();
          const facts = await readBusinessFacts(businessId, now, deps);
          const latest = facts.periods.find((p) => p.periodKey === facts.latestKey);
          bump(counts.latestPeriods, latest ? latest.status : "MISSING");
          for (const d of facts.deliveries) bump(counts.deliveries, d.status);
          const findings = businessFindings(facts);
          tally(findings);
          const r = await tenantTx(businessId, (tx) => reconcileAlerts(tx, { kind: "business", businessId }, findings, now));
          counts.opened += r.opened;
          counts.resolved += r.resolved;
          counts.openAlerts += r.open;
          if (r.claims.length) claimsByBusiness.set(businessId, r.claims);
          counts.evaluated += 1;
        });
      } catch (e) {
        if (e instanceof BusinessQuarantinedError) {
          counts.skippedQuarantined += 1;
          continue;
        }
        counts.businessesFailed += 1;
        console.error("[accountant-monitor] business failed", { businessId, error: e instanceof Error ? e.name : "unknown" });
      }
    }

    const now = deps.now();
    const runs = await readRunFacts();
    const findings = platformFindings({
      now,
      sweepEnabled: deps.sweepEnabled(),
      sweepRuns: runs.sweepRuns,
      firstMonitorRunAt: runs.firstMonitorRunAt,
      businessesFailed: counts.businessesFailed,
      budgetExhausted: counts.budgetExhausted,
    });
    tally(findings);
    const r = await reconcilePlatformAlerts(findings, now);
    counts.opened += r.opened;
    counts.resolved += r.resolved;
    counts.openAlerts += r.open;
    platformClaims.push(...r.claims);

    const all = [...platformClaims, ...[...claimsByBusiness.values()].flat()];
    counts.claimed = all.length;
    let notification: MonitorNotification = "none";
    if (all.length > 0) {
      const channel = deps.channel();
      if (!channel.ok) notification = "not_configured";
      else {
        const sent = await sendDigest(all, channel, { provider: deps.provider });
        notification = sent.status === "sent" ? "sent" : sent.status === "none" ? "none" : "failed";
      }
      if (notification === "failed" || notification === "not_configured") {
        counts.released += await releaseAll(platformClaims, claimsByBusiness);
        console.error("[accountant-monitor] alert not sent — claims released", { notification, claims: all.length });
      }
    }
    const ok = notification !== "failed" && notification !== "not_configured";
    await finishRun(runId, ok ? "OK" : "FAILED", counts, ok ? null : `notify_${notification}`, deps.now());
    return { ok, notification, counts };
  } catch (e) {
    // Claims of a run that crashed after claiming are given back too: nothing was sent.
    counts.released += await releaseAll(platformClaims, claimsByBusiness).catch(() => 0);
    await finishRun(runId, "FAILED", counts, "monitor_failed", deps.now()).catch(() => undefined);
    throw e;
  }
}

async function releaseAll(platformClaims: Claim[], claimsByBusiness: Map<number, Claim[]>): Promise<number> {
  let n = 0;
  if (platformClaims.length) n += await releasePlatformClaims(platformClaims);
  for (const [businessId, claims] of claimsByBusiness) {
    try {
      n += await runTenantJob({ businessId }, () => tenantTx(businessId, (tx) => releaseClaims(tx, claims)));
    } catch (e) {
      console.error("[accountant-monitor] release failed", { businessId, error: e instanceof Error ? e.name : "unknown" });
    }
  }
  return n;
}
