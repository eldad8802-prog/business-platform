import { prisma } from "@/lib/prisma";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { logAuditEvent } from "@/lib/services/audit.service";

export async function redeemCoupon(
  token: string,
  redeemingBusinessId: number
) {
  if (!token) {
    throw new ValidationError("Coupon token is required");
  }

  if (!redeemingBusinessId || Number.isNaN(redeemingBusinessId)) {
    throw new ValidationError("Redeeming business is required");
  }

  const coupon = await prisma.coupon.findUnique({
    where: { token },
  });

  if (!coupon) {
    throw new NotFoundError("Coupon not found");
  }

  if (coupon.status === "REDEEMED") {
    await logAuditEvent({
      businessId: coupon.issuingBusinessId,
      eventType: "REVENUE_COUPON_REDEEM_REJECTED",
      entityType: "COUPON",
      entityId: coupon.id,
      payload: {
        reason: "ALREADY_REDEEMED",
        couponId: coupon.id,
        token: coupon.token,
        redeemingBusinessId,
      },
    });

    throw new ValidationError("Coupon was already redeemed");
  }

  if (coupon.status === "CANCELLED") {
    await logAuditEvent({
      businessId: coupon.issuingBusinessId,
      eventType: "REVENUE_COUPON_REDEEM_REJECTED",
      entityType: "COUPON",
      entityId: coupon.id,
      payload: {
        reason: "CANCELLED",
        couponId: coupon.id,
        token: coupon.token,
        redeemingBusinessId,
      },
    });

    throw new ValidationError("Coupon was cancelled");
  }

  if (coupon.status === "EXPIRED") {
    await logAuditEvent({
      businessId: coupon.issuingBusinessId,
      eventType: "REVENUE_COUPON_REDEEM_REJECTED",
      entityType: "COUPON",
      entityId: coupon.id,
      payload: {
        reason: "EXPIRED",
        couponId: coupon.id,
        token: coupon.token,
        redeemingBusinessId,
      },
    });

    throw new ValidationError("Coupon has expired");
  }

  const now = new Date();

  if (coupon.expiresAt <= now) {
    await prisma.coupon.update({
      where: { id: coupon.id },
      data: {
        status: "EXPIRED",
      },
    });

    await logAuditEvent({
      businessId: coupon.issuingBusinessId,
      eventType: "REVENUE_COUPON_REDEEM_REJECTED",
      entityType: "COUPON",
      entityId: coupon.id,
      payload: {
        reason: "EXPIRED_BY_TIME_CHECK",
        couponId: coupon.id,
        token: coupon.token,
        expiresAt: coupon.expiresAt.toISOString(),
        redeemingBusinessId,
      },
    });

    throw new ValidationError("Coupon has expired");
  }

  const redeemedAt = new Date();

  const result = await prisma.$transaction(async (tx) => {
    const existingRedemption = await tx.redemptionEvent.findFirst({
      where: {
        couponId: coupon.id,
      },
    });

    if (existingRedemption) {
      throw new ValidationError("Coupon was already redeemed");
    }

    const updateResult = await tx.coupon.updateMany({
      where: {
        id: coupon.id,
        status: "ACTIVE",
        redeemedAt: null,
      },
      data: {
        status: "REDEEMED",
        redeemedAt,
      },
    });

    if (updateResult.count === 0) {
      throw new ValidationError("Coupon was already redeemed");
    }

    const updatedCoupon = await tx.coupon.findUnique({
      where: { id: coupon.id },
    });

    if (!updatedCoupon) {
      throw new NotFoundError("Coupon not found after update");
    }

    const redemptionEvent = await tx.redemptionEvent.create({
      data: {
        couponId: coupon.id,
        issuingBusinessId: coupon.issuingBusinessId,
        redeemingBusinessId,
        redeemedAt,
      },
    });

    return {
      coupon: updatedCoupon,
      redemptionEvent,
    };
  });

  await logAuditEvent({
    businessId: coupon.issuingBusinessId,
    eventType: "REVENUE_COUPON_REDEEMED",
    entityType: "REDEMPTION_EVENT",
    entityId: result.redemptionEvent.id,
    payload: {
      couponId: result.coupon.id,
      offerId: result.coupon.offerId,
      issuingBusinessId: coupon.issuingBusinessId,
      redeemingBusinessId,
      redemptionEventId: result.redemptionEvent.id,
      redeemedAt: result.redemptionEvent.redeemedAt.toISOString(),
      token: result.coupon.token,
    },
  });

  return result;
}