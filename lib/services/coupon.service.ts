import { prisma } from "@/lib/prisma";
import { randomUUID } from "crypto";
import {
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import { logAuditEvent } from "@/lib/services/audit.service";

type CreateCouponFromOfferInput = {
  offerId: number;
  businessId: number;
};

export async function createCouponFromOffer(
  input: CreateCouponFromOfferInput
) {
  const { offerId, businessId } = input;

  if (!businessId || Number.isNaN(businessId)) {
    throw new UnauthorizedError();
  }

  if (!offerId || Number.isNaN(offerId)) {
    throw new ValidationError("Invalid offer id");
  }

  const offer = await prisma.offer.findUnique({
    where: { id: offerId },
  });

  if (!offer) {
    throw new NotFoundError("Offer not found");
  }

  if (offer.issuingBusinessId !== businessId) {
    await logAuditEvent({
      businessId,
      eventType: "REVENUE_COUPON_CREATE_REJECTED",
      entityType: "OFFER",
      entityId: offerId,
      payload: {
        reason: "FORBIDDEN",
        offerId,
        ownerBusinessId: offer.issuingBusinessId,
        actorBusinessId: businessId,
      },
    });

    throw new ForbiddenError();
  }

  if (!offer.isActive) {
    await logAuditEvent({
      businessId,
      eventType: "REVENUE_COUPON_CREATE_REJECTED",
      entityType: "OFFER",
      entityId: offerId,
      payload: {
        reason: "OFFER_NOT_ACTIVE",
        offerId,
      },
    });

    throw new ValidationError("Offer is not active");
  }

  if (offer.validUntil <= new Date()) {
    await logAuditEvent({
      businessId,
      eventType: "REVENUE_COUPON_CREATE_REJECTED",
      entityType: "OFFER",
      entityId: offerId,
      payload: {
        reason: "OFFER_EXPIRED",
        offerId,
        validUntil: offer.validUntil.toISOString(),
      },
    });

    throw new ValidationError("Offer has already expired");
  }

  const token = randomUUID();
  const qrValue = `http://localhost:3000/revenue/redeem?token=${token}`;

  const coupon = await prisma.coupon.create({
    data: {
      offerId: offer.id,
      issuingBusinessId: businessId,
      token,
      qrValue,
      expiresAt: offer.validUntil,
      status: "ACTIVE",
    },
  });

  await logAuditEvent({
    businessId,
    eventType: "REVENUE_COUPON_CREATED",
    entityType: "COUPON",
    entityId: coupon.id,
    payload: {
      couponId: coupon.id,
      offerId: coupon.offerId,
      token: coupon.token,
      qrValue: coupon.qrValue,
      expiresAt: coupon.expiresAt.toISOString(),
      status: coupon.status,
    },
  });

  return coupon;
}