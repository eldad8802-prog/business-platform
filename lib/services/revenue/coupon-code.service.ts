import { prisma } from "@/lib/prisma";
import { NotFoundError, ValidationError } from "@/lib/errors";

export type CouponCodeDTO = {
  token: string;
  qrValue: string;
  redeemLink: string;
};

export async function getCouponCode(publicId: string): Promise<CouponCodeDTO> {
  if (!publicId || typeof publicId !== "string") {
    throw new ValidationError("Invalid coupon id");
  }

  const coupon = await prisma.coupon.findUnique({
    where: { publicId },
    select: {
      status: true,
      expiresAt: true,
      token: true,
      qrValue: true,
    },
  });

  if (!coupon) {
    throw new NotFoundError("Coupon not found");
  }

  const now = new Date();
  if (coupon.expiresAt <= now) {
    throw new ValidationError("Coupon has expired");
  }

  if (coupon.status !== "ACTIVE") {
    throw new ValidationError("Coupon is not active");
  }

  return {
    token: coupon.token,
    qrValue: coupon.qrValue,
    redeemLink: coupon.qrValue,
  };
}

