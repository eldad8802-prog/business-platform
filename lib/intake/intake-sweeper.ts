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
import { claimHeldTierCrossing, intakeBacklog, intakeFlow, intakeHealthCounts, purgeExpiredFailedPayloads } from "@/lib/intake/intake-event.store";
import { HELD_GLOBAL_ALERT, HELD_TIERS, heldTier } from "@/lib/intake/intake-capacity";
import { drainIntake, emptyTally, type IntakeProcessResult } from "@/lib/intake/core/processor";
import type { IntakeRegistry } from "@/lib/intake/core/registry";
import { intakeRegistry } from "@/lib/intake/sources";
import { reconcileCommerce } from "@/lib/intake/commerce/reconcile";
import { syncRivhit } from "@/lib/revenue-sources/rivhit/sync";
import { isConnectionError, withConnectionRetry } from "@/lib/db/transient-retry";

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
  backlog: { deadLettersNew: number; deadLettersOpen: number; pendingStale: number; pendingStaleNew: number; held: number; businessesNeedingAttention: number };
  /** S1-A — Rivhit documents handed to intake, documents Rivhit returned unreadable, failed connections, Rivhit calls. */
  revenueSources: { receipts: number; unreadable: number; failures: number; calls: number };
  /**
   * L1.5-b · PR-2 — capacity across the swept businesses (counts only, monitoring only — never a refusal): open
   * backlog by class, how many businesses reached each held tier, the largest per-business held count, the oldest
   * held receipt, the flow of the last hour, and (only with INTAKE_CAPACITY_ALERTS_ENABLED) new tier crossings and
   * the platform-wide alert.
   */
  capacity: CapacityReport;
};

export type CapacityReport = {
  held: number;
  due: number;
  retrying: number;
  deadLetters: number;
  businessesAt500: number;
  businessesAt1000: number;
  businessesAt2000: number;
  maxHeldPerBusiness: number;
  oldestHeldHours: number;
  receivedLastHour: number;
  processedLastHour: number;
  recoveredLastHour: number;
  /** Businesses whose scan hit its cap (their counts are lower bounds) / whose capacity read failed (metrics only). */
  cappedBusinesses: number;
  unreadBusinesses: number;
  /** INTAKE_CAPACITY_ALERTS_ENABLED only: tier crossings first seen in this run (each reported once). */
  tierCrossingsNew: number;
  /** INTAKE_CAPACITY_ALERTS_ENABLED only: held ≥ HELD_GLOBAL_ALERT platform-wide, raised in the first run of the UTC day. */
  globalAlert: boolean;
};

export const emptyCapacity = (): CapacityReport => ({
  held: 0, due: 0, retrying: 0, deadLetters: 0, businessesAt500: 0, businessesAt1000: 0, businessesAt2000: 0, maxHeldPerBusiness: 0,
  oldestHeldHours: 0, receivedLastHour: 0, processedLastHour: 0, recoveredLastHour: 0, cappedBusinesses: 0, unreadBusinesses: 0,
  tierCrossingsNew: 0, globalAlert: false,
});

/** Capacity alerts (new red reasons) are OFF unless this is exactly "true"; the counts are always reported. */
export function capacityAlertsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.INTAKE_CAPACITY_ALERTS_ENABLED === "true";
}

/** The first scheduled run (10-minute slot) of the UTC day: a standing platform-wide alert is raised once a day (pure). */
export function firstRunOfUtcDay(now: Date, slotMs = 10 * 60 * 1000): boolean {
  return now.getTime() % (24 * 60 * 60 * 1000) < slotMs;
}

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
    backlog: { deadLettersNew: 0, deadLettersOpen: 0, pendingStale: 0, pendingStaleNew: 0, held: 0, businessesNeedingAttention: 0 },
    capacity: emptyCapacity(),
  };
  const alerts = capacityAlertsEnabled();

  // Listing tenants only reads; a dropped pooled connection here is retried once (lib/db/transient-retry.ts).
  const businessIds = await withConnectionRetry(() => tenantsOf(registry), { label: "intake-sweep.tenants" });
  for (const businessId of businessIds) {
    report.businesses += 1;
    // Set once this business reached the health read, which marks new dead letters as reported: a drop at or after it
    // is NOT retried, so a dead letter can never be marked reported by an attempt whose result was lost.
    let healthStarted = false;
    try {
      const tally = await sweepBusiness(businessId, () => !healthStarted, (attempt) => runTenantJob({ businessId }, async () => {
        // M7-B — stores first: what a webhook missed becomes a receipt, then the drain below finishes it.
        // Not on a connection retry: the provider was already called once in this run; the next sweep polls again.
        if (options.reconcileCommerce !== false && attempt === 1) {
          const c = await reconcileCommerce(businessId);
          report.commerce.receipts += c.receipts;
          report.commerce.webhooksReactivated += c.webhooksReactivated;
          report.commerce.failures += c.failures;
        }
        // S1-A — Rivhit has no document webhook: new documents are polled here (gated, bounded, paced).
        if (options.syncRevenueSources !== false && attempt === 1) {
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
        healthStarted = true;
        const h = await intakeHealthCounts(businessId, now);
        report.backlog.deadLettersNew += h.deadLettersNew;
        report.backlog.deadLettersOpen += h.deadLettersOpen;
        report.backlog.pendingStale += h.pendingStale;
        report.backlog.pendingStaleNew += h.pendingStaleNew;
        // L1.5-a — held receipts are a visible count, not a failure (a hold is a decision; it turns red only once
        // it is a day old, through pendingStaleNew).
        report.backlog.held += h.held;
        if (h.deadLettersNew + h.pendingStale > 0) {
          report.backlog.businessesNeedingAttention += 1;
          // Server log only (never the response): which business, counts — no event id, no content.
          console.warn("[intake-sweep] business attention", { businessId, ...h });
        }
        // L1.5-b · PR-2 — capacity (metrics only): one bounded read per business per run; a failure here is counted,
        // never a business error, and never changes what was processed above.
        await readCapacity(report.capacity, businessId, now, alerts).catch(() => {
          report.capacity.unreadBusinesses += 1;
        });
        return drained;
      }));
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
  report.capacity.globalAlert = alerts && report.capacity.held >= HELD_GLOBAL_ALERT && firstRunOfUtcDay(now);
  return report;
}

async function readCapacity(c: CapacityReport, businessId: number, now: Date, alerts: boolean): Promise<void> {
  const b = await intakeBacklog(businessId, now);
  const f = await intakeFlow(businessId, now);
  c.held += b.totals.held;
  c.due += b.totals.due;
  c.retrying += b.totals.retrying;
  c.deadLetters += b.totals.deadLetters;
  c.receivedLastHour += f.receivedLastHour;
  c.processedLastHour += f.processedLastHour;
  c.recoveredLastHour += f.recoveredLastHour;
  if (b.capped || f.capped) c.cappedBusinesses += 1;
  c.maxHeldPerBusiness = Math.max(c.maxHeldPerBusiness, b.totals.held);
  const ageHours = b.oldestHeldAt ? Math.floor((now.getTime() - b.oldestHeldAt.getTime()) / 3_600_000) : 0;
  c.oldestHeldHours = Math.max(c.oldestHeldHours, ageHours);
  const tier = heldTier(b.totals.held);
  if (tier >= 500) c.businessesAt500 += 1;
  if (tier >= 1000) c.businessesAt1000 += 1;
  if (tier >= 2000) c.businessesAt2000 += 1;
  if (tier > 0) {
    // Server log only (never the response): which business, counts — no event id, no content.
    console.warn("[intake-sweep] held capacity", { businessId, held: b.totals.held, tier, oldestHeldHours: ageHours, capped: b.capped });
    if (alerts) for (const t of HELD_TIERS) if (t <= tier && (await claimHeldTierCrossing(businessId, t, now))) c.tierCrossingsNew += 1;
  }
}

/**
 * One business, retried once when (and only when) the database connection dropped. Safe to repeat:
 *   - the retry runs with the same `now`, so a receipt the first attempt claimed is still under its lease
 *     (nextAttemptAt = now + lease) and is neither listed nor claimable again — no receipt is processed twice;
 *   - receipts the first attempt finished are no longer due; routing is idempotent per receipt ("first record wins");
 *   - the retention purge is idempotent; a drop at or after the health read (which marks new dead letters as reported)
 *     is not retried (`canRetry`), so the run stays red and no dead letter is lost;
 *   - store reconciliation and Rivhit polling (external calls) are skipped on the retry (attempt > 1).
 * Any other error, or a second drop, is thrown unchanged and counted as a business error, as before.
 */
export async function sweepBusiness<T>(
  businessId: number,
  canRetry: () => boolean,
  job: (attempt: number) => Promise<T>,
  retry: { sleep?: (ms: number) => Promise<void>; log?: (line: string, meta: Record<string, unknown>) => void } = {},
): Promise<T> {
  return withConnectionRetry(job, {
    label: "intake-sweep.business",
    canRetry,
    ...retry,
    log: retry.log ?? ((line, meta) => console.warn(line, { ...meta, businessId })),
  });
}

/** Re-exported for the sweep tests: the classifier the per-business retry uses. */
export { isConnectionError };

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
    // L1.5-a — a receipt that became stale since the last sweep: reported once, like a new dead letter.
    ...(report.backlog.pendingStaleNew > 0 ? ["pending_stale_new"] : []),
    ...(report.commerce.failures > 0 ? ["commerce_reconcile_failures"] : []),
    // L1.5-b · PR-2 — capacity (only ever non-zero with INTAKE_CAPACITY_ALERTS_ENABLED): a tier crossed, once; the
    // platform-wide backlog, once a day while it stands.
    ...(report.capacity.tierCrossingsNew > 0 ? ["held_capacity_tier"] : []),
    ...(report.capacity.globalAlert ? ["held_capacity_global"] : []),
  ];
  return { ok: job.length === 0 && events.length === 0, job, events };
}
