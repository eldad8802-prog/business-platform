import { PrismaClient, CollaborationActionType } from "@prisma/client";

const prisma = new PrismaClient();

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

export async function runMatchingEngine(input: MatchingInput) {
  const { businessId, category, subCategory } = input;

  // 1. מונעים כפילויות: אם כבר יש deals פתוחים, מחזירים אותם
  const existingNewDeals = await prisma.collaborationDeal.findMany({
    where: {
      businessId,
      status: "NEW",
    },
    orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
  });

  if (existingNewDeals.length > 0) {
    return existingNewDeals;
  }

  // 2. Candidate Selection
  const candidates: Candidate[] = [];

  if (category === "Beauty" && subCategory === "Hair Salon") {
    candidates.push({
      title: "שיתוף פעולה עם קוסמטיקאית",
      description: "שלח לקוחות וקבל עמלה על כל לקוחה",
      partnerType: "Cosmetician",
      actionType: CollaborationActionType.REFERRAL,
      estimatedValue: 250,
    });

    candidates.push({
      title: "קופון משותף עם מכון ציפורניים",
      description: "הצע חבילה משולבת ללקוחות",
      partnerType: "Nail Studio",
      actionType: CollaborationActionType.COUPON,
      estimatedValue: 180,
    });
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

  if (candidates.length === 0) {
    candidates.push({
      title: "שיתוף פעולה כללי",
      description: "מצא עסק משלים והחלף לקוחות",
      partnerType: "General Partner",
      actionType: CollaborationActionType.REFERRAL,
      estimatedValue: 200,
    });
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

  // 5. Deal Creation
  const createdDeals = await Promise.all(
    topDeals.map((deal) =>
      prisma.collaborationDeal.create({
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
    )
  );

  // 6. Passive Learning: DEAL_CREATED
  await Promise.all(
    createdDeals.map((deal) =>
      prisma.learningEvent.create({
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
      })
    )
  );

  return prisma.collaborationDeal.findMany({
    where: { businessId, status: "NEW" },
    orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
  });
}