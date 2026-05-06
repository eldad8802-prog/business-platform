import { prisma } from "@/lib/prisma";
import {
  rankActiveCoupons,
  type ActiveCouponCard,
} from "./active-coupons.rank";

type GetActiveCouponsInput = {
  limit: number;
};

function clampLimit(limit: number) {
  if (!Number.isFinite(limit)) return 6;
  return Math.max(1, Math.min(6, Math.floor(limit)));
}

export async function getActiveCoupons(
  input: Partial<GetActiveCouponsInput> = {}
): Promise<ActiveCouponCard[]> {
  const limit = clampLimit(input.limit ?? 6);
  const now = new Date();

  const coupons = await prisma.coupon.findMany({
    where: {
      status: "ACTIVE",
      expiresAt: {
        gt: now,
      },
    },
    select: {
      id: true,
      publicId: true,
      issuedAt: true,
      expiresAt: true,
      offer: {
        select: {
          id: true,
          title: true,
          customerBenefitText: true,
          description: true,
          imageUrl: true,
        },
      },
      issuingBusiness: {
        select: {
          id: true,
          name: true,
        },
      },
    },
    orderBy: {
      issuedAt: "desc",
    },
    take: 200,
  });

  const cards: ActiveCouponCard[] = coupons.map((coupon) => ({
    publicId: coupon.publicId,
    issuedAt: coupon.issuedAt.toISOString(),
    expiresAt: coupon.expiresAt.toISOString(),
    business: {
      id: coupon.issuingBusiness.id,
      name: coupon.issuingBusiness.name,
      city: undefined,
      address: undefined,
    },
    offer: {
      id: coupon.offer.id,
      title: coupon.offer.title,
      customerBenefitText: coupon.offer.customerBenefitText,
      description: coupon.offer.description ?? null,
      imageUrl: coupon.offer.imageUrl ?? null,
    },
  }));

  const ranked = rankActiveCoupons(cards, now);
  return ranked.slice(0, limit);
}

