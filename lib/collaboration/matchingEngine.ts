import { CollaborationActionType, type CollaborationDeal } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { TenantTx } from "@/lib/tenant/transaction";

type MatchingInput = {
  businessId: number;
  category: string;
  subCategory?: string;
};

type Candidate = {
  title: string;
  description: string;
  partnerType: string;
  actionType: CollaborationActionType;
  estimatedValue: number;
};

type ScoredCandidate = Candidate & {
  matchScore: number;
  reasonText: string;
  priority: number;
};

/** Outcome of a generation attempt. `no_matches` means no real rule applied and
 * — per F-25 · 4B — nothing was fabricated. */
export type MatchingResult =
  | { status: "ok"; deals: CollaborationDeal[] }
  | { status: "no_matches" };

/**
 * Pure candidate selection from the (server-derived) business identity.
 * Deliberately has NO generic fallback (F-25 · 4B): an unsupported or missing
 * category/subCategory returns [] so the caller surfaces a fail-safe state
 * instead of fabricating a generic collaboration that isn't tailored to the
 * business. Kept pure (no DB) so this coverage is unit-testable.
 */
export function selectCandidates(
  category: string | null | undefined,
  subCategory?: string | null
): Candidate[] {
  const candidates: Candidate[] = [];

  if (category === "Beauty" && subCategory === "Hair Salon") {
    candidates.push(
      {
        title: "שיתוף פעולה עם קוסמטיקאית",
        description: "שלח לקוחות וקבל עמלה על כל לקוחה",
        partnerType: "Cosmetician",
        actionType: CollaborationActionType.REFERRAL,
        estimatedValue: 250,
      },
      {
        title: "קופון משותף עם מכון ציפורניים",
        description: "הצע חבילה משולבת ללקוחות",
        partnerType: "Nail Studio",
        actionType: CollaborationActionType.COUPON,
        estimatedValue: 180,
      }
    );
  }

  if (category === "Fitness") {
    candidates.push({
      title: "שיתוף פעולה עם תזונאי",
      description: "הפנה לקוחות וקבל עמלה",
      partnerType: "Nutritionist",
      actionType: CollaborationActionType.REFERRAL,
      estimatedValue: 300,
    });
  }

  return candidates;
}

export async function runMatchingEngine(
  input: MatchingInput,
  options?: { tx?: TenantTx }
): Promise<MatchingResult> {
  // D2/P7 Wave 1: bind to the tenant transaction when provided. A TenantTx is
  // a single interactive transaction — writes below are sequential, never
  // Promise.all on the same tx.
  const db = options?.tx ?? prisma;
  const { businessId, category, subCategory } = input;

  // 1. מונעים כפילויות: אם כבר יש deals פתוחים, מחזירים אותם
  const existingNewDeals = await db.collaborationDeal.findMany({
    where: {
      businessId,
      status: "NEW",
    },
    orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
  });

  if (existingNewDeals.length > 0) {
    return { status: "ok", deals: existingNewDeals };
  }

  // 2. Candidate Selection — from the server-derived identity only.
  const candidates = selectCandidates(category, subCategory);

  // Fail-safe (F-25 · 4B): no real rule matched → do NOT fabricate a generic
  // deal. The caller surfaces a user-facing "no matches yet" state instead.
  if (candidates.length === 0) {
    return { status: "no_matches" };
  }

  // 3. Scoring
  const scored: ScoredCandidate[] = candidates.map((candidate) => {
    let score = 0;
    const reasons: string[] = [];

    // קהל יעד משותף
    score += 40;
    reasons.push("קהל יעד דומה");

    // השלמת שירות
    score += 30;
    reasons.push("שירות משלים");

    // פוטנציאל הכנסה
    if (candidate.estimatedValue > 200) {
      score += 20;
      reasons.push("פוטנציאל הכנסה גבוה");
    }

    // קלות ביצוע
    score += 10;
    reasons.push("קל ליישום");

    const matchScore = score;

    // priority הוא feed-facing ונגזר מהסקור
    const priority = 100 - matchScore;

    return {
      ...candidate,
      matchScore,
      reasonText: reasons.join(" • "),
      priority,
    };
  });

  // 4. Ranking
  scored.sort((a, b) => {
    if (b.matchScore !== a.matchScore) {
      return b.matchScore - a.matchScore;
    }

    return a.priority - b.priority;
  });

  const topDeals = scored.slice(0, 3);

  // 5. Deal Creation (sequential — an interactive tx client must not run
  // concurrent queries)
  const createdDeals = [];
  for (const deal of topDeals) {
    createdDeals.push(
      await db.collaborationDeal.create({
        data: {
          businessId,
          title: deal.title,
          description: deal.description,
          partnerType: deal.partnerType,
          actionType: deal.actionType,
          estimatedValue: deal.estimatedValue,
          matchScore: deal.matchScore,
          reasonText: deal.reasonText,
          priority: deal.priority,
          sourceType: "RULE_BASED_MATCH",
          status: "NEW",
        },
      })
    );
  }

  // 6. Passive Learning: DEAL_CREATED
  for (const deal of createdDeals) {
    await db.learningEvent.create({
      data: {
        businessId: deal.businessId,
        eventType: "DEAL_CREATED",
        entityType: "COLLABORATION_DEAL",
        entityId: null,
        payload: {
          dealId: deal.id,
          title: deal.title,
          partnerType: deal.partnerType,
          actionType: deal.actionType,
          estimatedValue: deal.estimatedValue,
          matchScore: deal.matchScore,
          reasonText: deal.reasonText,
          priority: deal.priority,
          sourceType: deal.sourceType,
          status: deal.status,
        },
      },
    });
  }

  const deals = await db.collaborationDeal.findMany({
    where: { businessId, status: "NEW" },
    orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
  });
  return { status: "ok", deals };
}