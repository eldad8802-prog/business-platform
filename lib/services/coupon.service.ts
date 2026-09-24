import { prisma } from "@/lib/prisma";
import { randomUUID } from "crypto";
import {
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import {
  logAuditEvent,
  type AuditActor,
  type AuditSource,
} from "@/lib/services/audit.service";
import { buildCouponQrValue } from "@/lib/revenue/coupon-base-url";

function actorFields(actorUserId: number | undefined): {
  actor: AuditActor;
  source: AuditSource;
} {
  return actorUserId
    ? { actor: { type: "OWNER_USER", userId: actorUserId }, source: "OWNER_UI" }
    : { actor: { type: "UNKNOWN" }, source: "UNKNOWN" };
}

type CreateCouponFromOfferInput = {
  offerId: number;
  businessId: number;
  /**
   * Absolute origin for the coupon's QR target. Resolved by the route via
   * `resolveCouponBaseUrl` (env override, else the request origin) — see
   * COUPON-01 in `lib/revenue/coupon-base-url.ts` for why this is no longer
   * read from `process.env` down here.
   */
  baseUrl: string;
  /**
   * Session user id, from the route's authenticated user — never from a request body. Optional so a
   * caller with no person behind it records UNKNOWN rather than a guess.
   */
  actorUserId?: number;
};

export async function createCouponFromOffer(
  input: CreateCouponFromOfferInput
) {
  const { offerId, businessId, baseUrl } = input;
  const auditActor = actorFields(input.actorUserId);

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
      ...auditActor,
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
      ...auditActor,
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
      ...auditActor,
      payload: {
        reason: "OFFER_EXPIRED",
        offerId,
        validUntil: offer.validUntil.toISOString(),
      },
    });

    throw new ValidationError("Offer has already expired");
  }

  const token = randomUUID();

  if (!baseUrl) {
    // Defensive only — the route always supplies one. A ValidationError (not a
    // bare Error) so a misconfiguration can never surface as an opaque 500.
    throw new ValidationError("Cannot generate coupon QR without a base URL");
  }

  const qrValue = buildCouponQrValue(baseUrl, token);

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
    ...auditActor,
    // No token and no QR value: either one IS the coupon (a bearer credential for redemption) and
    // has no place in an event log.
    payload: {
      couponId: coupon.id,
      offerId: coupon.offerId,
      expiresAt: coupon.expiresAt.toISOString(),
      status: coupon.status,
    },
  });

  return coupon;
}