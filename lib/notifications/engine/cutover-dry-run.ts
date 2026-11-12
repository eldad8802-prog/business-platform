/**
 * Clean-start dry run — READ-ONLY (owner decision 2026-11-13). SERVER-ONLY.
 *
 * Before anyone enables `notifications_engine` for a business, this reports — per live business, counts only — what
 * the push worker WOULD do with the owed pushes (PENDING PUSH rows with no device) already in the queue:
 *
 *   engine ON  → the activation moment is the business's cutover (worker-decision.ts cutoverFrom): rows created
 *                before it would be closed 'pre_cutover'; of the rest, rows past their TTL 'expired'; the remainder
 *                proceed (decided and possibly sent).
 *   engine OFF → the activation moment would be NOW: every owed row already there was created before it, so all of
 *                them would be closed 'pre_cutover' — none sent. (That is the clean start.)
 *
 * Nothing is claimed, leased or written: plain reads inside each business's tenant transaction, the business list
 * from notification_live_businesses() (identifiers only, walkLiveBusinesses). Reached through the CRON_SECRET worker
 * route (GET /api/notifications/worker?dryRun=cutover).
 */
import { tenantTx } from "@/lib/tenant/tenant-tx";

import { classifyNotification } from "../catalog";
import { walkLiveBusinesses } from "./digest";
import { businessGates, type BusinessGates } from "./engine-gate";
import { classifyOwedForActivation, type ActivationCounts } from "./worker-decision";

const MAX_ROWS_PER_BUSINESS = 5000;

export type BusinessDryRun = ActivationCounts & {
  businessId: number;
  engineOn: boolean;
  /** The moment the counts assume: the business's cutover when ON (null if none derivable: TTL only), else now. */
  activationAt: string | null;
  /** More than 5000 owed rows: the counts cover the oldest 5000. */
  truncated: boolean;
};

export type CutoverDryRunReport = {
  generatedAt: string;
  businesses: number;
  totals: ActivationCounts;
  /** Businesses with at least one owed push, or the engine ON. */
  rows: BusinessDryRun[];
  errors: number;
};

export async function cutoverDryRun(
  now: Date = new Date(),
  opts: { businessIds?: number[]; gates?: (businessId: number) => Promise<BusinessGates> } = {},
): Promise<CutoverDryRunReport> {
  const gatesOf = opts.gates ?? businessGates;
  const report: CutoverDryRunReport = {
    generatedAt: now.toISOString(), businesses: 0, totals: { owed: 0, wouldExpirePreCutover: 0, wouldExpireTtl: 0, wouldProceed: 0 }, rows: [], errors: 0,
  };
  const visit = async (businessId: number) => {
    report.businesses += 1;
    try {
      const gates = await gatesOf(businessId);
      const owed = await tenantTx(businessId, (tx) =>
        tx.notificationDelivery.findMany({
          where: { businessId, status: "PENDING", channel: "PUSH", subscriptionId: null },
          select: { createdAt: true, expiresAt: true, notification: { select: { domain: true, semanticCategory: true, severity: true, entityType: true } } },
          orderBy: { id: "asc" },
          take: MAX_ROWS_PER_BUSINESS + 1,
        }),
      );
      const truncated = owed.length > MAX_ROWS_PER_BUSINESS;
      const rows = (truncated ? owed.slice(0, MAX_ROWS_PER_BUSINESS) : owed)
        .map((r) => ({ createdAt: r.createdAt, expiresAt: r.expiresAt, category: classifyNotification(r.notification) }));
      const activation = gates.engineOn ? gates.cutoverAt : now;
      const counts = classifyOwedForActivation(rows, activation, now);
      if (counts.owed === 0 && !gates.engineOn) return;
      report.rows.push({ businessId, engineOn: gates.engineOn, activationAt: activation ? activation.toISOString() : null, truncated, ...counts });
      for (const k of ["owed", "wouldExpirePreCutover", "wouldExpireTtl", "wouldProceed"] as const) report.totals[k] += counts[k];
    } catch {
      report.errors += 1;
    }
  };
  if (opts.businessIds) {
    for (const b of opts.businessIds) await visit(b);
  } else {
    await walkLiveBusinesses(visit);
  }
  return report;
}
