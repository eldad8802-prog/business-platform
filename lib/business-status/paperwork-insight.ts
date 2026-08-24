import { prisma } from "@/lib/prisma";

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
    prisma.financialRecord.count({
      where: {
        businessId,
        approvedAt: { gte: since },
      },
    }),
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
