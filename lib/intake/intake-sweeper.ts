/**
 * Business Intake · the sweeper — finishes what the sources accepted.
 *
 * A source processes its own receipts right after answering its provider.
 * Anything that did not finish there — a failure on its backoff, a throttled
 * document, a worker that died mid-lease — is picked up here, for EVERY
 * registered source through the one provider-neutral processor.
 *
 * Tenants are found through each adapter's bootstrap reader (WhatsApp:
 * WhatsAppConnection, via its sole reader) and each is entered server-side in
 * its own `runTenantJob`: the caller never names a tenant, and one tenant's
 * failure never stops the next.
 *
 * The report carries COUNTS only — no business, event or message identifier —
 * so a leaked response reveals nothing.
 *
 * Scheduling lives outside this module: QStash (primary, if its schedule exists
 * in Upstash), the GitHub `intake sweep (scheduled)` workflow every ~10 minutes
 * and the daily Vercel cron (vercel.json) — all call /api/intake/sweep.
 */

import { runTenantJob } from "@/lib/tenant/job";
import { BusinessQuarantinedError } from "@/lib/tenant/business-lifecycle";
import { intakeHealthCounts, purgeExpiredFailedPayloads } from "@/lib/intake/intake-event.store";
import { drainIntake, emptyTally, type IntakeProcessResult } from "@/lib/intake/core/processor";
import type { IntakeRegistry } from "@/lib/intake/core/registry";
import { intakeRegistry } from "@/lib/intake/sources";
import { reconcileCommerce } from "@/lib/intake/commerce/reconcile";
import { syncRivhit } from "@/lib/revenue-sources/rivhit/sync";

export type IntakeSweepReport = {
  businesses: number;
  quarantinedSkipped: number;
  businessErrors: number;
  events: Record<IntakeProcessResult, number>;
  payloadsPurged: number;
  /** M7-B — orders recovered by polling stores, disabled store webhooks re-activated, store failures. */
  commerce: { receipts: number; webhooksReactivated: number; failures: number };
  /**
   * Leads L1 · G-07 — business-event health across the swept businesses, read after the run (counts only):
   * dead letters no sweep had reported yet, by ANY path (webhook-time drains included — reported once),
   * every replayable dead letter, receipts still unfinished a day after arrival, and how many businesses
   * have new dead letters or stale receipts.
   */
  backlog: { deadLettersNew: number; deadLettersOpen: number; pendingStale: number; businessesNeedingAttention: number };
  /** S1-A — Rivhit documents handed to intake, documents Rivhit returned unreadable, failed connections, Rivhit calls. */
  revenueSources: { receipts: number; unreadable: number; failures: number; calls: number };
};

/** Union of every registered source's tenants (deduped, stable order). */
async function tenantsOf(registry: IntakeRegistry): Promise<number[]> {
  const ids = new Set<number>();
  for (const adapter of registry.list()) {
    if (!adapter.listTenants) continue;
    for (const id of await adapter.listTenants()) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

export async function runIntakeSweep(
  options: { now?: Date; perBusinessLimit?: number; registry?: IntakeRegistry; reconcileCommerce?: boolean; syncRevenueSources?: boolean } = {}
): Promise<IntakeSweepReport> {
  const now = options.now ?? new Date();
  const registry = options.registry ?? intakeRegistry;
  const report: IntakeSweepReport = {
    businesses: 0,
    quarantinedSkipped: 0,
    businessErrors: 0,
    events: emptyTally(),
    payloadsPurged: 0,
    commerce: { receipts: 0, webhooksReactivated: 0, failures: 0 },
    revenueSources: { receipts: 0, unreadable: 0, failures: 0, calls: 0 },
    backlog: { deadLettersNew: 0, deadLettersOpen: 0, pendingStale: 0, businessesNeedingAttention: 0 },
  };

  for (const businessId of await tenantsOf(registry)) {
    report.businesses += 1;
    try {
      const tally = await runTenantJob({ businessId }, async () => {
        // M7-B — stores first: what a webhook missed becomes a receipt, then the drain below finishes it.
        if (options.reconcileCommerce !== false) {
          const c = await reconcileCommerce(businessId);
          report.commerce.receipts += c.receipts;
          report.commerce.webhooksReactivated += c.webhooksReactivated;
          report.commerce.failures += c.failures;
        }
        // S1-A — Rivhit has no document webhook: new documents are polled here (gated, bounded, paced).
        if (options.syncRevenueSources !== false) {
          // A Rivhit failure never stops this business's drain below.
          const r = await syncRivhit(businessId, { now }).catch(() => ({ receipts: 0, unreadable: 0, failures: 1, calls: 0 }));
          report.revenueSources.receipts += r.receipts;
          report.revenueSources.unreadable += r.unreadable;
          report.revenueSources.failures += r.failures;
          report.revenueSources.calls += r.calls;
        }
        const drained = await drainIntake(registry, businessId, {
          now,
          limit: options.perBusinessLimit ?? 50,
        });
        report.payloadsPurged += await purgeExpiredFailedPayloads(businessId, now);
        // Leads L1 · G-07 — the business-event health, AFTER this run's own work (counts only).
        const h = await intakeHealthCounts(businessId, now);
        report.backlog.deadLettersNew += h.deadLettersNew;
        report.backlog.deadLettersOpen += h.deadLettersOpen;
        report.backlog.pendingStale += h.pendingStale;
        if (h.deadLettersNew + h.pendingStale > 0) {
          report.backlog.businessesNeedingAttention += 1;
          // Server log only (never the response): which business, counts — no event id, no content.
          console.warn("[intake-sweep] business attention", { businessId, ...h });
        }
        return drained;
      });
      for (const key of Object.keys(tally) as IntakeProcessResult[]) {
        report.events[key] += tally[key];
      }
    } catch (error) {
      if (error instanceof BusinessQuarantinedError) {
        report.quarantinedSkipped += 1;
        continue;
      }
      report.businessErrors += 1;
      console.warn("[intake-sweep] business failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  return report;
}

export type SweepHealth = {
  ok: boolean;
  /** The RUN itself could not do its work (a business could not be swept). */
  job: string[];
  /** The run worked, but business events need someone: failed / dead-lettered receipts, store reconciliation. */
  events: string[];
};

/**
 * Leads L1 · G-07 — "the sweep ran" is not "nothing was lost". Either kind of problem makes the run unhealthy
 * (the scheduler goes red — the existing alert), and the two are named apart so the operator knows whether to
 * look at the job or at the events. Rivhit (S1-A) failures stay in the report, outside this verdict (their own track).
 */
export function sweepHealth(report: IntakeSweepReport): SweepHealth {
  const job = report.businessErrors > 0 ? ["business_errors"] : [];
  const events = [
    ...(report.events.failed > 0 ? ["failed_receipts"] : []),
    ...(report.backlog.deadLettersNew > 0 ? ["dead_letters_new"] : []),
    ...(report.commerce.failures > 0 ? ["commerce_reconcile_failures"] : []),
  ];
  return { ok: job.length === 0 && events.length === 0, job, events };
}
