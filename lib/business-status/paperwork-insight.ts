import { prisma } from "@/lib/prisma";
import { getTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

// D2/P7-W4D, hardened in CUTOVER-2A: FinancialRecord is FORCE-RLS'd, so this read
// must carry `app.current_business_id`. The previous fallback said it out loud —
// "a bare global-client read would silently count 0" — and then did exactly that
// whenever no context was established. Silently counting 0 is the failure mode; it
// now raises instead, so a missing context is a bug report rather than a wrong
// number presented as a right one.
async function dbStep<T>(fn: (db: typeof prisma) => Promise<T>): Promise<T> {
  if (getTenantContext() === undefined) {
    throw new Error(
      "paperwork insight requires a tenant context — wrap the call in runWithTenantContext({ businessId })"
    );
  }
  return withTenantTransaction((tx) => fn(tx as unknown as typeof prisma));
}

import {
  countPendingReviewAllTime,
  listPendingReviewMonths,
} from "@/lib/documents/pending-review";
import type { PaperworkInsightPayload } from "./types";

/** Minimum backlog (needs_review) before surfacing — trust over coverage. */
export const PAPERWORK_PENDING_MIN = 5;

/** Rolling window for “recent approvals” (days). */
export const PAPERWORK_APPROVED_WINDOW_DAYS = 7;

/**
 * If more than this many financial rows were added after approval in the window,
 * the pipeline is “moving” enough — hide the insight.
 */
export const PAPERWORK_APPROVED_RECENT_MAX = 2;

/**
 * Proof-of-understanding insight: paperwork backlog vs recent approvals.
 * Rule-based only; returns null when confidence gate fails.
 */
export async function evaluatePaperworkInsight(
  businessId: number
): Promise<PaperworkInsightPayload | null> {
  const since = new Date();
  since.setDate(since.getDate() - PAPERWORK_APPROVED_WINDOW_DAYS);

  // Total across ALL time (the backlog) — via the canonical shared selector so
  // this number always agrees with the inbox's "total pending".
  const [pendingCount, approvedRecentCount] = await Promise.all([
    countPendingReviewAllTime(businessId),
    dbStep((db) =>
      db.financialRecord.count({
        where: {
          businessId,
          approvedAt: { gte: since },
        },
      })
    ),
  ]);

  if (pendingCount < PAPERWORK_PENDING_MIN) {
    return null;
  }

  if (approvedRecentCount > PAPERWORK_APPROVED_RECENT_MAX) {
    return null;
  }

  // The inbox is month-scoped, so a CTA to its default (current month) can land
  // on an empty view while the backlog sits in earlier months. Point the CTA at
  // the most recent month that actually has pending documents, so it never
  // contradicts this insight.
  const pendingMonths = await listPendingReviewMonths(businessId);
  const targetMonth = pendingMonths[0] ?? null;
  const ctaHref = targetMonth
    ? `/documents/inbox?month=${targetMonth}`
    : "/documents/inbox";

  return {
    title: "הניירת הפיננסית נשארת מאחור",
    explanation:
      "נראה שיש עומס בתהליך אישור המסמכים, לעומת מה שנכנס לדוחות לאחרונה.",
    evidenceLines: [
      `${pendingCount} מסמכים מחכים לבדיקה בסך הכול (מכל החודשים)`,
      `בשבוע האחרון נוספו ${approvedRecentCount} רשומות לדוחות לאחר אישור`,
    ],
    ctaLabel: "הצג מסמכים ממתינים",
    ctaHref,
  };
}
