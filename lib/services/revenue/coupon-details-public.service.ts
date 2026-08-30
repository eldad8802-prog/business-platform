import { prisma } from "@/lib/prisma";
import { assertCouponPublicId } from "@/lib/services/revenue/coupon-public-id";
import { NotFoundError } from "@/lib/errors";

export type PublicCouponDetailsDTO = {
  coupon: {
    // W1-01: public identity is the opaque publicId only — the internal numeric
    // `coupon.id` is never exposed on a public DTO.
    publicId: string;
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
    city?: string;
    address?: string;
    phone?: string;
    category?: string;
    openingHours?: string;
  };
};

/** Coupon record shape the public mapper needs (marketing metadata only). */
export type PublicCouponDetailsRecord = {
  publicId: string;
  status: "ACTIVE" | "REDEEMED" | "EXPIRED" | "CANCELLED";
  issuedAt: Date;
  expiresAt: Date;
  redeemedAt: Date | null;
  offer: {
    id: number;
    title: string;
    customerBenefitText: string;
    description: string | null;
    imageUrl: string | null;
  };
  issuingBusiness: {
    id: number;
    name: string;
    profile: {
      category: string | null;
      city: string | null;
      openingHours: string | null;
      billingAddress: string | null;
      billingPhone: string | null;
    } | null;
  };
};

/**
 * Pure mapper → public marketing DTO. Deliberately never selects or returns
 * `token`, `qrValue`, `redeemLink`, or the internal numeric `coupon.id`.
 */
export function toPublicCouponDetailsDTO(
  coupon: PublicCouponDetailsRecord
): PublicCouponDetailsDTO {
  return {
    coupon: {
      publicId: coupon.publicId,
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
      city: coupon.issuingBusiness.profile?.city ?? undefined,
      address: coupon.issuingBusiness.profile?.billingAddress ?? undefined,
      phone: coupon.issuingBusiness.profile?.billingPhone ?? undefined,
      category: coupon.issuingBusiness.profile?.category ?? undefined,
      openingHours: coupon.issuingBusiness.profile?.openingHours ?? undefined,
    },
  };
}

export async function getPublicCouponDetails(
  publicId: string
): Promise<PublicCouponDetailsDTO> {
  const id = assertCouponPublicId(publicId);

  const coupon = await prisma.coupon.findUnique({
    where: { publicId: id },
    select: {
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
          profile: {
            select: {
              category: true,
              city: true,
              openingHours: true,
              billingAddress: true,
              billingPhone: true,
            },
          },
        },
      },
    },
  });

  if (!coupon) {
    throw new NotFoundError("Coupon not found");
  }

  return toPublicCouponDetailsDTO(coupon);
}
