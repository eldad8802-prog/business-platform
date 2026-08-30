import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { getTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

// D2/P7-W4D: reads of FORCE-RLS'd tables run on a short tenant transaction
// when a tenant context is established; outside a context they read directly
// (unit tests). Under context there is NO fallback to the global client.
async function dbStep<T>(fn: (db: typeof prisma) => Promise<T>): Promise<T> {
  if (getTenantContext() !== undefined) {
    return withTenantTransaction((tx) => fn(tx as unknown as typeof prisma));
  }
  return fn(prisma);
}
import { formatYearMonthJerusalem } from "@/lib/utils/jerusalem-month-range";

/**
 * Canonical definition of "a document still awaiting human review".
 *
 * This is the single source of truth for the pending-review filter, shared by
 * every surface that counts the backlog — the Documents inbox
 * (app/api/documents/inbox) and the Attention paperwork insight
 * (lib/business-status/paperwork-insight). Both must agree on "total pending",
 * so both derive the WHERE from here rather than inlining `status:"needs_review"`.
 */
export const PENDING_REVIEW_STATUS = "needs_review" as const;

export function pendingReviewWhere(businessId: number): {
  businessId: number;
  status: typeof PENDING_REVIEW_STATUS;
} {
  return { businessId, status: PENDING_REVIEW_STATUS };
}

/**
 * Total needs_review documents for a business, across ALL time — the backlog
 * concept (distinct from a single month's verification queue).
 */
export function countPendingReviewAllTime(businessId: number): Promise<number> {
  return dbStep((db) => db.document.count({ where: pendingReviewWhere(businessId) }));
}

/**
 * Pure: distinct Jerusalem year-months (YYYY-MM) present in the given creation
 * timestamps, newest first. Kept separate from the DB read so month bucketing
 * (incl. Jerusalem day/DST boundaries) is unit-testable.
 */
export function distinctMonthsDescending(createdAts: Date[]): string[] {
  const set = new Set<string>();
  for (const d of createdAts) {
    set.add(formatYearMonthJerusalem(d));
  }
  return Array.from(set).sort().reverse();
}

/**
 * Distinct Jerusalem year-months that contain at least one needs_review
 * document, newest first. Used for backlog navigation (month selector + the
 * insight CTA target). Selects only createdAt; the (businessId,status,createdAt)
 * index covers this read.
 */
export async function listPendingReviewMonths(
  businessId: number
): Promise<string[]> {
  const rows = await dbStep((db) => db.document.findMany({
    where: pendingReviewWhere(businessId),
    select: { createdAt: true },
  }));
  return distinctMonthsDescending(rows.map((r) => r.createdAt));
}
