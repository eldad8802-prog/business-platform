import { billingTenantTx } from "@/lib/services/billing/billing-tenant-tx";
import {
  settleVerifiedPayment,
  type SettleVerifiedPaymentResult,
} from "@/lib/services/billing/settlement/payment-accounting-settlement.service";
import { listRoutedBusinessIds } from "@/lib/services/payments/payment-store.prisma";
import { readBusinessLifecycle } from "@/lib/tenant/business-lifecycle";

/**
 * C3 — local recovery of verified payments whose accounting did not finish.
 *
 * The webhook settles inline. If that process died, or the attempt failed
 * transiently, the PaymentAccountingSettlement row is still PENDING — durable,
 * local, and enough on its own to finish the job. This sweep finds those rows
 * and hands each to the SAME canonical settleVerifiedPayment; there is no
 * second implementation, and no provider is asked to resend anything.
 *
 *   for each candidate tenant (routing hint, ACTIVE only):
 *     inside that tenant: due PENDING rows, FOR UPDATE SKIP LOCKED, bounded
 *     → settleVerifiedPayment(row)            one failure never stops the run
 *
 * SAFETY UNDER CONCURRENCY. The discovery query skips rows another
 * transaction holds (an inline webhook settlement in flight), and
 * settleVerifiedPayment re-locks and re-reads each row, so a scheduled run, a
 * second overlapping run, the webhook and a manual retry can all run at once:
 * the settlement row lock and UNIQUE receipt link make every path exactly-once.
 *
 * BOUNDED. At most `maxSettlements` attempts and `timeBudgetMs` per run; the
 * rest waits for the next run. Tenants are visited in a rotating order so a
 * large tenant cannot starve the others.
 */

export type SettlementRecoveryOptions = {
  now?: () => Date;
  maxSettlements?: number;
  maxPerBusiness?: number;
  timeBudgetMs?: number;
  /** Test seam: the candidate tenants. Production reads the routing hint. */
  listBusinessIds?: () => Promise<number[]>;
};

export type SettlementRecoveryReport = {
  businessesScanned: number;
  attempted: number;
  settled: number;
  alreadySettled: number;
  requiresAttention: number;
  retryScheduled: number;
  notEligible: number;
  failed: number;
  stoppedEarly: boolean;
};

const DEFAULTS = { maxSettlements: 25, maxPerBusiness: 10, timeBudgetMs: 40_000 };

/** Rotate so each run starts at a different tenant; deterministic per minute. */
export function rotate<T>(items: T[], seed: number): T[] {
  if (items.length === 0) return items;
  const k = ((seed % items.length) + items.length) % items.length;
  return [...items.slice(k), ...items.slice(0, k)];
}

async function dueSettlementIds(
  businessId: number,
  now: Date,
  limit: number
): Promise<number[]> {
  return billingTenantTx(businessId, async (tx) => {
    const rows = await tx.$queryRaw<{ paymentTransactionId: number }[]>`
      SELECT "paymentTransactionId"
      FROM "PaymentAccountingSettlement"
      WHERE "businessId" = ${businessId}
        AND "status" = 'PENDING'
        -- nextAttemptAt is a zone-less timestamp written in UTC; the parameter
        -- is converted to UTC explicitly so the comparison never depends on
        -- the session's time zone.
        AND ("nextAttemptAt" IS NULL
             OR "nextAttemptAt" <= (${now}::timestamptz AT TIME ZONE 'UTC'))
      ORDER BY "nextAttemptAt" ASC NULLS FIRST, "id" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;
    return rows.map((r) => r.paymentTransactionId);
  });
}

export async function runSettlementRecovery(
  options: SettlementRecoveryOptions = {}
): Promise<SettlementRecoveryReport> {
  const now = options.now ?? (() => new Date());
  const maxSettlements = options.maxSettlements ?? DEFAULTS.maxSettlements;
  const maxPerBusiness = options.maxPerBusiness ?? DEFAULTS.maxPerBusiness;
  const timeBudgetMs = options.timeBudgetMs ?? DEFAULTS.timeBudgetMs;
  const startedAt = Date.now();
  const report: SettlementRecoveryReport = {
    businessesScanned: 0,
    attempted: 0,
    settled: 0,
    alreadySettled: 0,
    requiresAttention: 0,
    retryScheduled: 0,
    notEligible: 0,
    failed: 0,
    stoppedEarly: false,
  };

  const candidates = await (options.listBusinessIds ?? listRoutedBusinessIds)();
  const ordered = rotate(candidates, Math.floor(now().getTime() / 60_000));

  for (const businessId of ordered) {
    if (report.attempted >= maxSettlements || Date.now() - startedAt > timeBudgetMs) {
      report.stoppedEarly = true;
      break;
    }
    // The same gate the webhook applies at the tenant boundary: never create
    // operational state for a business that is being erased.
    if ((await readBusinessLifecycle(businessId)) !== "ACTIVE") continue;
    report.businessesScanned++;

    let ids: number[];
    try {
      ids = await dueSettlementIds(
        businessId,
        now(),
        Math.min(maxPerBusiness, maxSettlements - report.attempted)
      );
    } catch {
      report.failed++;
      continue; // one tenant's failure never stops the run
    }

    for (const paymentTransactionId of ids) {
      if (report.attempted >= maxSettlements || Date.now() - startedAt > timeBudgetMs) {
        report.stoppedEarly = true;
        break;
      }
      report.attempted++;
      let result: SettleVerifiedPaymentResult;
      try {
        result = await settleVerifiedPayment({ businessId, paymentTransactionId }, { now });
      } catch {
        report.failed++;
        continue;
      }
      switch (result.outcome) {
        case "SETTLED":
          report.settled++;
          break;
        case "ALREADY_SETTLED":
          report.alreadySettled++;
          break;
        case "REQUIRES_ATTENTION":
          report.requiresAttention++;
          break;
        case "RETRY_SCHEDULED":
          report.retryScheduled++;
          break;
        case "NOT_ELIGIBLE":
          report.notEligible++;
          break;
      }
    }
  }
  // Budget spent: there may be more due work — the next run continues it.
  if (report.attempted >= maxSettlements) report.stoppedEarly = true;
  return report;
}
