/**
 * The monthly accountant sweep — the scheduled entry point (D1: the 1st of every month, Israel time,
 * and every run after it until the owner is done).
 *
 * WHAT ONE RUN DOES, PER ELIGIBLE BUSINESS (each inside its own tenant job, fully isolated)
 *   1. The most recently closed month: create and prepare it the first time it is seen (D7: activation
 *      starts with this month only — older months are never created by the schedule), re-prepare it
 *      when a change marked it dirty, when the last attempt failed, or once a day while the owner still
 *      has to act.
 *   2. Older months that a late change marked dirty (an approval or an issue dated in that month).
 *   3. The notification centre, reminders included (lib/accountant/notify.ts).
 *   4. Sends whose next attempt is due (lib/accountant/delivery.service.ts).
 *
 * SAFETY
 *   - The business list is ids + lifecycle only (Business has no RLS for reads by design); every read
 *     or write of business data happens in `runTenantJob`, under FORCE RLS, as the non-bypass runtime.
 *   - A business without the feature is skipped before anything of it is read.
 *   - Duplicate or overlapping runs are harmless: period leases, the one-build-per-period index,
 *     fingerprints and the notification writer's dedupe make every step idempotent.
 *   - A time budget keeps one run inside the function limit; the order is shuffled so no business is
 *     starved when the budget runs out, and the next run continues.
 *   - One business failing never stops the others; the run reports counts, never business data.
 */

import { prisma } from "@/lib/prisma";
import { runTenantJob } from "@/lib/tenant/job";
import { BusinessQuarantinedError } from "@/lib/tenant/business-lifecycle";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { accountantWorkflowEnabled } from "./http";
import { syncPeriodNotice } from "./notify";
import { previousPeriodKey } from "./period";
import { preparePeriod, type PrepareOutcome } from "./prepare.service";
import { processDueDeliveries } from "./delivery.service";
import { OWNER_ACTION_STATUSES, type PeriodStatus } from "./workflow-status";

export const SWEEP_TIME_BUDGET_MS = 40_000;
/** Builds read many files; a run starts at most this many. */
export const SWEEP_MAX_PREPARES = 6;
/** Older dirty months handled per business per run. */
export const SWEEP_MAX_OLDER_PER_BUSINESS = 3;
/** A month the owner still has to act on is re-evaluated at most once a day without a change. */
export const REEVALUATE_AFTER_MS = 20 * 60 * 60 * 1000;
/** A failed preparation is retried after this long. */
export const RETRY_FAILED_AFTER_MS = 60 * 60 * 1000;

export type SweepSummary = {
  businesses: number;
  eligible: number;
  skippedQuarantined: number;
  prepared: number;
  built: number;
  buildFailed: number;
  busy: number;
  notified: number;
  reminded: number;
  deliveriesProcessed: number;
  businessErrors: number;
  budgetExhausted: boolean;
};

export type SweepDeps = {
  now: () => Date;
  listBusinessIds: () => Promise<number[]>;
  isEnabled: (businessId: number) => Promise<boolean>;
  prepare: typeof preparePeriod;
  syncNotice: typeof syncPeriodNotice;
  processDeliveries: typeof processDueDeliveries;
  shuffle: <T>(items: T[]) => T[];
};

function fisherYates<T>(items: T[]): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const defaultSweepDeps: SweepDeps = {
  now: () => new Date(),
  // Ids and lifecycle only — the sanctioned pre-context read of the tenant root (B4: SELECT USING true).
  listBusinessIds: async () =>
    (
      await prisma.business.findMany({
        where: { deletionRequestedAt: null, deletedAt: null },
        select: { id: true },
        orderBy: { id: "asc" },
      })
    ).map((b) => b.id),
  isEnabled: accountantWorkflowEnabled,
  prepare: preparePeriod,
  syncNotice: syncPeriodNotice,
  processDeliveries: processDueDeliveries,
  shuffle: fisherYates,
};

/** Whether the most recent closed month needs (re)preparation in this run. Pure. */
export function latestPeriodNeedsPrepare(
  period: { status: string; dirtyAt: Date | null; evaluatedAt: Date | null; leaseUntil: Date | null } | null,
  now: Date
): boolean {
  if (!period) return true;
  if (period.leaseUntil && period.leaseUntil.getTime() > now.getTime()) return false;
  if (period.dirtyAt) return true;
  const status = period.status as PeriodStatus;
  const since = period.evaluatedAt ? now.getTime() - period.evaluatedAt.getTime() : Infinity;
  if (status === "PREPARING") return true;
  if (status === "PREPARATION_FAILED") return since >= RETRY_FAILED_AFTER_MS;
  if (OWNER_ACTION_STATUSES.has(status)) return since >= REEVALUATE_AFTER_MS;
  return false;
}

export async function runAccountantSweep(deps: SweepDeps = defaultSweepDeps): Promise<SweepSummary> {
  const startedAt = deps.now();
  const summary: SweepSummary = {
    businesses: 0,
    eligible: 0,
    skippedQuarantined: 0,
    prepared: 0,
    built: 0,
    buildFailed: 0,
    busy: 0,
    notified: 0,
    reminded: 0,
    deliveriesProcessed: 0,
    businessErrors: 0,
    budgetExhausted: false,
  };
  const ids = deps.shuffle(await deps.listBusinessIds());
  summary.businesses = ids.length;

  const overBudget = () => deps.now().getTime() - startedAt.getTime() > SWEEP_TIME_BUDGET_MS;
  const tally = (r: PrepareOutcome) => {
    if (r.outcome === "busy") summary.busy += 1;
    if (r.outcome === "built") summary.built += 1;
    if (r.outcome === "build_failed") summary.buildFailed += 1;
    if (r.outcome === "built" || r.outcome === "build_failed" || r.outcome === "evaluated") summary.prepared += 1;
  };

  for (const businessId of ids) {
    if (overBudget()) {
      summary.budgetExhausted = true;
      break;
    }
    try {
      if (!(await deps.isEnabled(businessId))) continue;
      summary.eligible += 1;
      await runTenantJob({ businessId }, async () => {
        const now = deps.now();
        const latestKey = previousPeriodKey(now);
        const latest = await tenantTx(businessId, (tx) =>
          tx.accountantPeriod.findUnique({ where: { businessId_periodKey: { businessId, periodKey: latestKey } } })
        );
        if (summary.prepared < SWEEP_MAX_PREPARES && latestPeriodNeedsPrepare(latest, now)) {
          tally(
            await deps.prepare({ businessId, periodKey: latestKey, trigger: latest ? "CHANGE" : "SCHEDULE", actor: { type: "SYSTEM" } })
          );
        }

        const older = await tenantTx(businessId, (tx) =>
          tx.accountantPeriod.findMany({
            where: { businessId, periodKey: { not: latestKey }, dirtyAt: { not: null } },
            orderBy: { periodKey: "desc" },
            take: SWEEP_MAX_OLDER_PER_BUSINESS,
            select: { periodKey: true },
          })
        );
        for (const p of older) {
          if (summary.prepared >= SWEEP_MAX_PREPARES || overBudget()) break;
          tally(await deps.prepare({ businessId, periodKey: p.periodKey, trigger: "CHANGE", actor: { type: "SYSTEM" } }));
        }

        // Notices for every month whose state may have moved (the latest, and any touched above).
        const touchedKeys = [latestKey, ...older.map((p) => p.periodKey)];
        const periods = await tenantTx(businessId, (tx) =>
          tx.accountantPeriod.findMany({ where: { businessId, periodKey: { in: touchedKeys } } })
        );
        for (const p of periods) {
          const n = await deps.syncNotice(p, deps.now());
          if (n.surfaced && !n.reminded) summary.notified += 1;
          if (n.reminded) summary.reminded += 1;
        }

        summary.deliveriesProcessed += await deps.processDeliveries(businessId, deps.now());
      });
    } catch (e) {
      if (e instanceof BusinessQuarantinedError) {
        summary.skippedQuarantined += 1;
        continue;
      }
      summary.businessErrors += 1;
      console.error("[accountant-sweep] business failed", { businessId, error: e instanceof Error ? e.name : "unknown" });
    }
  }
  return summary;
}
