import { prisma } from "@/lib/prisma";

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

  const [pendingCount, approvedRecentCount] = await Promise.all([
    prisma.document.count({
      where: {
        businessId,
        status: "needs_review",
      },
    }),
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

  return {
    title: "הניירת הפיננסית נשארת מאחור",
    explanation:
      "נראה שיש עומס בתהליך אישור המסמכים, לעומת מה שנכנס לדוחות לאחרונה.",
    evidenceLines: [
      `${pendingCount} מסמכים עדיין מחכים לבדיקה`,
      `בשבוע האחרון נוספו ${approvedRecentCount} רשומות לדוחות לאחר אישור`,
    ],
    ctaLabel: "פתח מסמכים",
    ctaHref: "/documents/inbox",
  };
}
