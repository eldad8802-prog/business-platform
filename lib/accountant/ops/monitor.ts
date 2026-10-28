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
  SWEEP_RUN_STALE_MS,
  platformFindings,
  subjectsOf,
  type BusinessFacts,
  type Finding,
} from "./findings";
import { openPlatformAlerts, reconcilePlatformAlerts, releasePlatformClaims } from "./platform-store";
import { finishRun, readAbandonedMonitorRuns, readRunFacts, startRun, type RunSource } from "./runs";

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
    recovered: number;
    abandonedRuns: number;
    latestPeriods: Record<string, number>;
    deliveries: Record<string, number>;
    findingsByCode: Record<string, number>;
  };
};

async function readBusinessFacts(businessId: number, now: Date, deps: MonitorDeps): Promise<BusinessFacts> {
  const latestKey = previousPeriodKey(now);
  const deliverySelect = {
    id: true,
    periodId: true,
    status: true,
    failureCode: true,
    approvedAt: true,
    nextAttemptAt: true,
    leaseUntil: true,
    acceptedAt: true,
    updatedAt: true,
  } as const;
  return tenantTx(businessId, async (tx) => {
    // Open alerts first: every send and month they name is read whatever its age (an alert never closes by ageing).
    const openAlerts = await tx.accountantBusinessAlert.findMany({
      where: { businessId, resolvedAt: null },
      select: { code: true, subjectKey: true, detail: true },
    });
    const named = subjectsOf(openAlerts);
    const recent = await tx.accountantDelivery.findMany({
      where: {
        businessId,
        OR: [
          { status: { in: ["APPROVED", "SENDING"] } },
          { approvedAt: { gte: new Date(now.getTime() - DELIVERY_LOOKBACK_MS) } },
          { id: { in: named.deliveryIds } },
        ],
      },
      select: deliverySelect,
    });
    // Every send of those months: a later send is what handles a failure or a complaint of an earlier one.
    const sendMonths = [...new Set(recent.map((d) => d.periodId))];
    const siblings = sendMonths.length
      ? await tx.accountantDelivery.findMany({
          where: { businessId, periodId: { in: sendMonths }, id: { notIn: recent.map((d) => d.id) } },
          select: deliverySelect,
        })
      : [];
    const deliveries = [...recent, ...siblings];
    const buildingPackages = await tx.accountantPackage.findMany({
      where: { businessId, status: "BUILDING" },
      select: { periodId: true, createdAt: true },
    });
    const periodIds = [...new Set([...deliveries.map((d) => d.periodId), ...buildingPackages.map((b) => b.periodId)])];
    const periods = await tx.accountantPeriod.findMany({
      where: {
        businessId,
        OR: [{ periodKey: { in: [latestKey, ...named.periodKeys] } }, { id: { in: periodIds } }, { status: "PREPARATION_FAILED" }],
      },
      select: { id: true, periodKey: true, status: true, evaluatedAt: true },
    });
    // A failing month is re-evaluated (evaluatedAt moves) by every hourly retry: it has been failing since the FIRST
    // failed build after its last good one.
    const failedIds = periods.filter((p) => p.status === "PREPARATION_FAILED").map((p) => p.id);
    const builds = failedIds.length
      ? await tx.accountantPackage.findMany({
          where: { businessId, periodId: { in: failedIds } },
          select: { periodId: true, status: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        })
      : [];
    const failingSince = (periodId: number, fallback: Date | null): Date | null => {
      let since: Date | null = null;
      for (const b of builds) {
        if (b.periodId !== periodId) continue;
        if (b.status === "FAILED") since = since ?? b.createdAt;
        else if (b.status === "READY" || b.status === "SUPERSEDED") since = null;
      }
      return since ?? fallback;
    };
    const complaints = await tx.accountantWorkflowEvent.findMany({
      where: {
        businessId,
        eventType: "DELIVERY_COMPLAINED",
        OR: [{ occurredAt: { gte: new Date(now.getTime() - COMPLAINT_WINDOW_MS) } }, { deliveryId: { in: named.deliveryIds } }],
      },
      select: { deliveryId: true, occurredAt: true },
    });
    const complaintAlerted = await tx.accountantBusinessAlert.findMany({
      where: { businessId, code: "DELIVERY_COMPLAINED" },
      select: { subjectKey: true },
    });
    const recipient = await tx.accountantWorkflowEvent.findFirst({
      where: { businessId, eventType: { in: ["RECIPIENT_SET", "RECIPIENT_CHANGED"] } },
      orderBy: { occurredAt: "desc" },
      select: { occurredAt: true },
    });
    return {
      now,
      sweepEnabled: deps.sweepEnabled(),
      webhookConfigured: deps.webhookConfigured(),
      latestKey,
      periods: periods.map((p) => ({ ...p, failingSince: p.status === "PREPARATION_FAILED" ? failingSince(p.id, p.evaluatedAt) : null })),
      buildingPackages,
      deliveries: deliveries.map((d) => ({ ...d, status: d.status as DeliveryStatus })),
      complaints: complaints.flatMap((c) => (c.deliveryId === null ? [] : [{ deliveryId: c.deliveryId, occurredAt: c.occurredAt }])),
      complaintAlerted: subjectsOf(complaintAlerted).deliveryIds,
      recipientChangedAt: recipient?.occurredAt ?? null,
      openAlerts: openAlerts.map((a) => ({ ...a, detail: (a.detail ?? {}) as Record<string, unknown> })),
    };
  });
}

const bump = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1;
};

export async function runAccountantMonitor(source: RunSource, deps: MonitorDeps = defaultMonitorDeps): Promise<MonitorResult> {
  const startedAt = deps.now();
  const runId = await startRun("MONITOR", source, startedAt);
  // Runs that died after claiming (killed at the function limit): their claims are recovered in every scope below.
  const abandoned = await readAbandonedMonitorRuns(startedAt, SWEEP_RUN_STALE_MS, runId);
  const claimOpts = { claimAt: startedAt, abandonedClaimAts: abandoned.map((r) => r.startedAt) };
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
    recovered: 0,
    abandonedRuns: 0,
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
          const r = await tenantTx(businessId, (tx) => reconcileAlerts(tx, { kind: "business", businessId }, findings, now, claimOpts));
          counts.opened += r.opened;
          counts.recovered += r.recovered;
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
      lastMonitorRunBySource: runs.lastMonitorRunBySource,
      openAlerts: await openPlatformAlerts(),
      businessesFailed: counts.businessesFailed,
      budgetExhausted: counts.budgetExhausted,
    });
    tally(findings);
    const r = await reconcilePlatformAlerts(findings, now, claimOpts);
    counts.opened += r.opened;
    counts.recovered += r.recovered;
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
    // A dead run is closed only once every scope it may have claimed in was looked at (its claims are back).
    if (abandoned.length && counts.businessesFailed === 0 && !counts.budgetExhausted) {
      for (const dead of abandoned) await finishRun(dead.id, "FAILED", {}, "abandoned", deps.now());
      counts.abandonedRuns = abandoned.length;
    }
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
