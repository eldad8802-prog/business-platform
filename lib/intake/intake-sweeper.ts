/**
 * Business Intake · the sweeper — finishes what the webhook accepted.
 *
 * The webhook processes its own receipts right after answering the provider.
 * Anything that did not finish there — a failure on its backoff, a throttled
 * document, a worker that died mid-lease — is picked up here. Tenants are found
 * through WhatsAppConnection (the allowlisted bootstrap table, via its sole
 * reader) and each is entered server-side in its own `runTenantJob`: the caller
 * never names a tenant, and one tenant's failure never stops the next.
 *
 * The report carries COUNTS only — no business, event or message identifier —
 * so a leaked response reveals nothing.
 */

import { runTenantJob } from "@/lib/tenant/job";
import { BusinessQuarantinedError } from "@/lib/tenant/business-lifecycle";
import { listBusinessIdsWithWhatsAppConnection } from "@/lib/services/integrations/whatsapp/connection.service";
import { purgeExpiredFailedPayloads } from "@/lib/intake/intake-event.store";
import { drainWhatsAppIntake, type IntakeProcessResult } from "@/lib/intake/whatsapp/whatsapp-intake";

export type IntakeSweepReport = {
  businesses: number;
  quarantinedSkipped: number;
  businessErrors: number;
  events: Record<IntakeProcessResult, number>;
  payloadsPurged: number;
};

export async function runIntakeSweep(
  options: { now?: Date; perBusinessLimit?: number } = {}
): Promise<IntakeSweepReport> {
  const now = options.now ?? new Date();
  const report: IntakeSweepReport = {
    businesses: 0,
    quarantinedSkipped: 0,
    businessErrors: 0,
    events: { not_claimed: 0, processed: 0, ignored: 0, deferred: 0, failed: 0 },
    payloadsPurged: 0,
  };

  for (const businessId of await listBusinessIdsWithWhatsAppConnection()) {
    report.businesses += 1;
    try {
      const tally = await runTenantJob({ businessId }, async () => {
        const drained = await drainWhatsAppIntake(businessId, {
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
