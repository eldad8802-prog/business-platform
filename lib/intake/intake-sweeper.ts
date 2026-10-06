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
 * Scheduling is NOT enabled here: the route is invoked on demand
 * (workflow_dispatch) until the owner approves a schedule.
 */

import { runTenantJob } from "@/lib/tenant/job";
import { BusinessQuarantinedError } from "@/lib/tenant/business-lifecycle";
import { purgeExpiredFailedPayloads } from "@/lib/intake/intake-event.store";
import { drainIntake, emptyTally, type IntakeProcessResult } from "@/lib/intake/core/processor";
import type { IntakeRegistry } from "@/lib/intake/core/registry";
import { intakeRegistry } from "@/lib/intake/sources";
import { reconcileCommerce } from "@/lib/intake/commerce/reconcile";

export type IntakeSweepReport = {
  businesses: number;
  quarantinedSkipped: number;
  businessErrors: number;
  events: Record<IntakeProcessResult, number>;
  payloadsPurged: number;
  /** M7-B — orders recovered by polling stores, disabled store webhooks re-activated, store failures. */
  commerce: { receipts: number; webhooksReactivated: number; failures: number };
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
  options: { now?: Date; perBusinessLimit?: number; registry?: IntakeRegistry; reconcileCommerce?: boolean } = {}
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
        const drained = await drainIntake(registry, businessId, {
          now,
          limit: options.perBusinessLimit ?? 50,
        });
        report.payloadsPurged += await purgeExpiredFailedPayloads(businessId, now);
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
