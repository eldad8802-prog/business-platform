import { prisma } from "@/lib/prisma";
import { NotFoundError, ValidationError } from "@/lib/errors";

export type PublicCouponDetailsDTO = {
  coupon: {
    id: number;
    status: "ACTIVE" | "REDEEMED" | "EXPIRED" | "CANCELLED";
    issuedAt: string;
    expiresAt: string;
    redeemedAt: string | null;
  };
  offer: {
    id: number;
    title: string;
    customerBenefitText: string;
    description: string | null;
    imageUrl: string | null;
  };
  business: {
    id: number;
    name: string;
  };
};

export async function getPublicCouponDetails(
  publicId: string
): Promise<PublicCouponDetailsDTO> {
  if (!publicId || typeof publicId !== "string") {
    throw new ValidationError("Invalid coupon id");
  }

  const coupon = await prisma.coupon.findUnique({
    where: { publicId },
    select: {
      id: true,
      publicId: true,
      status: true,
      issuedAt: true,
      expiresAt: true,
      redeemedAt: true,
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
  });

  if (!coupon) {
    throw new NotFoundError("Coupon not found");
  }

  return {
    coupon: {
      id: coupon.id,
      status: coupon.status,
      issuedAt: coupon.issuedAt.toISOString(),
      expiresAt: coupon.expiresAt.toISOString(),
      redeemedAt: coupon.redeemedAt ? coupon.redeemedAt.toISOString() : null,
    },
    offer: {
      id: coupon.offer.id,
      title: coupon.offer.title,
      customerBenefitText: coupon.offer.customerBenefitText,
      description: coupon.offer.description ?? null,
      imageUrl: coupon.offer.imageUrl ?? null,
    },
    business: {
      id: coupon.issuingBusiness.id,
      name: coupon.issuingBusiness.name,
    },
  };
}

