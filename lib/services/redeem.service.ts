import { prisma } from "@/lib/prisma";
import { NotFoundError, ValidationError } from "@/lib/errors";
import {
  logAuditEvent,
  type AuditActor,
  type AuditSource,
} from "@/lib/services/audit.service";

export async function redeemCoupon(
  token: string,
  redeemingBusinessId: number,
  /** The redeeming session user's id, from the route — never from a request body. */
  actorUserId?: number
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

  /**
   * Every event below lands in the ISSUING business's log. The person who acted is a user of the
   * REDEEMING business, so unless the two are the same business, recording that user as this
   * tenant's OWNER_USER would be false (and would plant another tenant's user id in this tenant's
   * rows). The counterparty is already identified by `redeemingBusinessId` in the payload.
   */
  const auditActor: { actor: AuditActor; source: AuditSource } =
    actorUserId && redeemingBusinessId === coupon.issuingBusinessId
      ? { actor: { type: "OWNER_USER", userId: actorUserId }, source: "OWNER_UI" }
      : { actor: { type: "UNKNOWN" }, source: "UNKNOWN" };

  /**
   * A business may not redeem its own coupon.
   *
   * Redemption in Dubiz is business-to-business by construction —
   * `RedemptionEvent` carries `issuingBusinessId` AND `redeemingBusinessId`, and
   * the canonical model describes them as distinct. Two concrete harms made
   * this worth enforcing rather than leaving open:
   *
   *   1. `getActiveCoupons` derives a per-business `redemptionCount` from
   *      `RedemptionEvent`, which the marketplace surfaces as "הכי מבוקשים".
   *      Self-redemption inflates a public trust signal with a business's own
   *      activity.
   *   2. It is a trap disguised as a feature. A coupon is single-redemption, so
   *      an owner "testing" their coupon destroys the one they just published —
   *      and nothing in the UI warned them.
   *
   * The owner still has every safe way to verify a coupon: the coupon page, the
   * QR, and the backup code are all readable by the issuer.
   */
  if (coupon.issuingBusinessId === redeemingBusinessId) {
    await logAuditEvent({
      businessId: coupon.issuingBusinessId,
      eventType: "REVENUE_COUPON_REDEEM_REJECTED",
      entityType: "COUPON",
      entityId: coupon.id,
      ...auditActor,
      payload: {
        reason: "SELF_REDEMPTION",
        couponId: coupon.id,
        redeemingBusinessId,
      },
    });

    throw new ValidationError(
      "זהו קופון שהעסק שלך הנפיק. מימוש נעשה על ידי העסק שמקבל את הלקוח — הקופון נשאר פעיל."
    );
  }

  if (coupon.status === "REDEEMED") {
    await logAuditEvent({
      businessId: coupon.issuingBusinessId,
      eventType: "REVENUE_COUPON_REDEEM_REJECTED",
      entityType: "COUPON",
      entityId: coupon.id,
      ...auditActor,
      payload: {
        reason: "ALREADY_REDEEMED",
        couponId: coupon.id,
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
      ...auditActor,
      payload: {
        reason: "CANCELLED",
        couponId: coupon.id,
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
      ...auditActor,
      payload: {
        reason: "EXPIRED",
        couponId: coupon.id,
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
      ...auditActor,
      payload: {
        reason: "EXPIRED_BY_TIME_CHECK",
        couponId: coupon.id,
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
      include: {
        offer: {
          select: {
            title: true,
            customerBenefitText: true,
            description: true,
          },
        },
      },
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
  }, {
    // This interactive transaction pins a pooled connection. Against a remote
    // (Neon) database Prisma's default 2s `maxWait` is regularly not enough to
    // acquire one, and the redeem call fails with "Unable to start a
    // transaction in the given time" — surfacing to the person at the counter
    // as an opaque 500 on a perfectly valid coupon. Observed intermittently in
    // the v1 browser smoke. The budget is widened; the logic is unchanged, so
    // the "one coupon = one redemption" anchor still rests on the guarded
    // `updateMany` plus `RedemptionEvent.couponId @unique`.
    maxWait: 15_000,
    timeout: 20_000,
  });

  await logAuditEvent({
    businessId: coupon.issuingBusinessId,
    eventType: "REVENUE_COUPON_REDEEMED",
    entityType: "REDEMPTION_EVENT",
    entityId: result.redemptionEvent.id,
    ...auditActor,
    payload: {
      couponId: result.coupon.id,
      offerId: result.coupon.offerId,
      issuingBusinessId: coupon.issuingBusinessId,
      redeemingBusinessId,
      redemptionEventId: result.redemptionEvent.id,
      redeemedAt: result.redemptionEvent.redeemedAt.toISOString(),
    },
  });

  return result;
}