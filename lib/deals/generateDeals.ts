import { PrismaClient, CollaborationActionType } from "@prisma/client";

const prisma = new PrismaClient();

type GenerateDealsInput = {
  businessId: number;
  category: string;
  subCategory?: string;
};

export async function generateDeals(input: GenerateDealsInput) {
  const { businessId, category, subCategory } = input;

  const existingDeals = await prisma.collaborationDeal.findMany({
    where: { businessId },
    orderBy: { createdAt: "desc" },
  });

  if (existingDeals.length > 0) {
    return existingDeals;
  }

  const dealsToCreate = [];

  if (category === "Beauty" && subCategory === "Hair Salon") {
    dealsToCreate.push({
      businessId,
      title: "שיתוף פעולה עם קוסמטיקאית",
      description:
        "שלח לקוחות לקוסמטיקאית וקבל עמלה על כל לקוחה שמגיעה דרכך.",
      partnerType: "Cosmetician",
      actionType: CollaborationActionType.REFERRAL,
      estimatedValue: 250,
    });

    dealsToCreate.push({
      businessId,
      title: "קופון משותף עם מכון ציפורניים",
      description:
        "הצע ללקוחות שלך קופון משותף עם מכון ציפורניים כדי להגדיל הכנסות.",
      partnerType: "Nail Studio",
      actionType: CollaborationActionType.COUPON,
      estimatedValue: 180,
    });
  }

  if (category === "Fitness") {
    dealsToCreate.push({
      businessId,
      title: "שיתוף פעולה עם תזונאי",
      description: "הפנה לקוחות לתזונאי וקבל עמלה על כל לקוח חדש.",
      partnerType: "Nutritionist",
      actionType: CollaborationActionType.REFERRAL,
      estimatedValue: 300,
    });
  }

  if (dealsToCreate.length === 0) {
    dealsToCreate.push({
      businessId,
      title: "שיתוף פעולה עם עסק משלים",
      description:
        "מצא עסק משלים בתחום שלך והתחל להחליף לקוחות כדי להגדיל הכנסות.",
      partnerType: "General Partner",
      actionType: CollaborationActionType.REFERRAL,
      estimatedValue: 200,
    });
  }

  await prisma.collaborationDeal.createMany({
    data: dealsToCreate,
  });

  const createdDeals = await prisma.collaborationDeal.findMany({
    where: { businessId },
    orderBy: { createdAt: "desc" },
  });

  return createdDeals;
}