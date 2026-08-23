import { prisma } from "@/lib/prisma";
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "@/lib/errors";
import { logAuditEvent } from "@/lib/services/audit.service";
import {
  canDisable,
  canEnable,
  deriveLifecycleState,
  type CouponLifecycleState,
  type StoredCouponStatus,
} from "@/lib/revenue/coupon-lifecycle";

/**
 * "הקופונים שלי" — the business owner's management surface (COUPON-02).
 *
 * There was no such endpoint at all. `GET /api/revenue/coupons/mine` fell
 * through to the public `[id]` route with `id = "mine"`, which ran
 * `findUnique({ where: { publicId: "mine" } })` against a `@db.Uuid` column —
 * Postgres rejects the cast, the driver error is not an `AppError`, and
 * `handleError` returned a bare 500. That is the audit's `mine` failure.
 *
 * Every function here derives the tenant from the authenticated user and
 * compares it against `issuingBusinessId` in the DB. Nothing trusts a
 * caller-supplied business id, and ownership is always checked before state, so
 * one business cannot probe another's coupons.
 */

export type MyCouponDTO = {
  publicId: string;
  benefit: string;
  description: string | null;
  state: CouponLifecycleState;
  issuedAt: string;
  expiresAt: string;
  redeemedAt: string | null;
  createdAt: string;
  offerId: number;
  /** 0 or 1 — a coupon token is single-redemption by construction. */
  redemptionCount: number;
};

type MyCouponRecord = {
  publicId: string;
  status: StoredCouponStatus;
  issuedAt: Date;
  expiresAt: Date;
  redeemedAt: Date | null;
  createdAt: Date;
  offerId: number;
  offer: { title: string; customerBenefitText: string; description: string | null };
  /** Singular by design: `RedemptionEvent.couponId` is `@unique`, so a coupon
   *  has at most one redemption. Present ⇒ redeemed. */
  redemptionEvents: { redeemedAt: Date } | null;
};

/** Pure mapper — the owner sees the derived state, never the raw enum. */
export function toMyCouponDTO(coupon: MyCouponRecord, now: Date): MyCouponDTO {
  return {
    publicId: coupon.publicId,
    benefit: coupon.offer.customerBenefitText || coupon.offer.title,
    description: coupon.offer.description ?? null,
    state: deriveLifecycleState(coupon, now),
    issuedAt: coupon.issuedAt.toISOString(),
    expiresAt: coupon.expiresAt.toISOString(),
    redeemedAt: coupon.redeemedAt ? coupon.redeemedAt.toISOString() : null,
    createdAt: coupon.createdAt.toISOString(),
    offerId: coupon.offerId,
    redemptionCount: coupon.redemptionEvents ? 1 : 0,
  };
}

function requireBusinessId(businessId: number | null | undefined): number {
  if (typeof businessId !== "number" || !Number.isInteger(businessId) || businessId <= 0) {
    throw new UnauthorizedError();
  }
  return businessId;
}

export async function getMyCoupons(
  businessId: number,
  now: Date = new Date()
): Promise<MyCouponDTO[]> {
  const owner = requireBusinessId(businessId);

  const coupons = await prisma.coupon.findMany({
    where: { issuingBusinessId: owner },
    select: {
      publicId: true,
      status: true,
      issuedAt: true,
      expiresAt: true,
      redeemedAt: true,
      createdAt: true,
      offerId: true,
      offer: {
        select: { title: true, customerBenefitText: true, description: true },
      },
      redemptionEvents: { select: { redeemedAt: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return coupons.map((coupon) => toMyCouponDTO(coupon, now));
}

/**
 * Load a coupon *as its owner*. Ownership is checked before anything else so a
 * foreign coupon is indistinguishable from a non-existent one to the caller.
 */
async function loadOwnedCoupon(publicId: string, businessId: number) {
  if (!publicId || typeof publicId !== "string") {
    throw new ValidationError("Invalid coupon id");
  }
  // A non-UUID would blow up the `@db.Uuid` comparison with a driver error and
  // surface as a 500 — the exact failure mode that broke `mine`. Reject early.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(publicId)) {
    throw new NotFoundError("Coupon not found");
  }

  const coupon = await prisma.coupon.findUnique({
    where: { publicId },
    select: {
      id: true,
      publicId: true,
      issuingBusinessId: true,
      status: true,
      expiresAt: true,
      offerId: true,
    },
  });

  if (!coupon) {
    throw new NotFoundError("Coupon not found");
  }
  if (coupon.issuingBusinessId !== businessId) {
    throw new ForbiddenError("אין לך הרשאה לנהל קופון זה");
  }

  return coupon;
}

/**
 * Kill switch (COUPON-02). Disabling flips the coupon to CANCELLED, which takes
 * effect immediately and everywhere, because both readers already gate on it:
 *   • `redeemCoupon` rejects CANCELLED before any state change → no new redemption.
 *   • `getActiveCoupons` filters `status: "ACTIVE"` → it leaves the marketplace.
 * History is untouched: the coupon row, its audit trail and any RedemptionEvent
 * all survive, so disabling is reversible while the coupon is still in date.
 *
 * SCOPE IS THE WHOLE OFFER, NOT THE ONE ROW — this is load-bearing.
 * `Offer → Coupon` is one-to-many, and the legacy `POST /api/offers/[id]/coupon`
 * path can mint additional coupons against the same offer. An adversarial pass
 * confirmed the damage: with two coupons on one offer, disabling via the owner's
 * UI stopped only the row it was given, the UI reported "מושבת", and the sibling
 * token was then redeemed successfully by another business. "Stop" that leaves a
 * live token in circulation is worse than no stop button at all, so the switch
 * now covers every coupon under the offer.
 */
export async function disableCoupon(
  publicId: string,
  businessId: number,
  now: Date = new Date()
): Promise<{ publicId: string; state: CouponLifecycleState; stoppedCount: number }> {
  const owner = requireBusinessId(businessId);
  const coupon = await loadOwnedCoupon(publicId, owner);
  const state = deriveLifecycleState(coupon, now);

  if (!canDisable(state)) {
    throw new ValidationError(
      state === "REDEEMED"
        ? "הקופון כבר מומש ולא ניתן להשבית אותו"
        : state === "EXPIRED"
          ? "הקופון כבר פג תוקף"
          : "הקופון כבר מושבת"
    );
  }

  // Deactivate the offer FIRST: while it is inactive `createCouponFromOffer`
  // refuses to issue, so no new coupon can slip in behind the sweep below.
  await prisma.offer.updateMany({
    where: { id: coupon.offerId, issuingBusinessId: owner },
    data: { isActive: false },
  });

  // Guarded sweep: only ACTIVE rows flip, so a concurrent redemption that has
  // already won keeps its REDEEMED state and is not silently overwritten.
  const updated = await prisma.coupon.updateMany({
    where: { offerId: coupon.offerId, issuingBusinessId: owner, status: "ACTIVE" },
    data: { status: "CANCELLED" },
  });

  if (updated.count === 0) {
    // Someone else got there first (redeemed or disabled) between our read and
    // this write. Restore the offer so we do not leave it deactivated on a
    // no-op, then report the conflict.
    await prisma.offer.updateMany({
      where: { id: coupon.offerId, issuingBusinessId: owner },
      data: { isActive: true },
    });
    throw new ValidationError("מצב הקופון השתנה — רענן ונסה שוב");
  }

  await logAuditEvent({
    businessId: owner,
    eventType: "REVENUE_COUPON_DISABLED",
    entityType: "COUPON",
    entityId: coupon.id,
    payload: {
      couponId: coupon.id,
      publicId: coupon.publicId,
      offerId: coupon.offerId,
      stoppedCount: updated.count,
    },
  });

  return { publicId: coupon.publicId, state: "DISABLED", stoppedCount: updated.count };
}

/**
 * Re-activate a disabled coupon — only while it is still in date.
 *
 * Mirrors `disableCoupon`'s offer-wide scope so stop/resume are symmetric: what
 * one switched off, the other switches back on. Only rows this switch could
 * have cancelled are restored — a coupon that was REDEEMED or has since expired
 * is left exactly as it is, and the guarded `status: "CANCELLED"` filter plus
 * the per-row expiry filter is what enforces that.
 */
export async function enableCoupon(
  publicId: string,
  businessId: number,
  now: Date = new Date()
): Promise<{ publicId: string; state: CouponLifecycleState; resumedCount: number }> {
  const owner = requireBusinessId(businessId);
  const coupon = await loadOwnedCoupon(publicId, owner);
  const state = deriveLifecycleState(coupon, now);

  if (!canEnable(state)) {
    throw new ValidationError(
      state === "EXPIRED"
        ? "הקופון פג תוקף ולא ניתן להפעיל אותו מחדש"
        : state === "REDEEMED"
          ? "הקופון כבר מומש"
          : "הקופון כבר פעיל"
    );
  }

  const updated = await prisma.coupon.updateMany({
    where: {
      offerId: coupon.offerId,
      issuingBusinessId: owner,
      status: "CANCELLED",
      // Never resurrect something already out of date.
      expiresAt: { gt: now },
    },
    data: { status: "ACTIVE" },
  });

  if (updated.count === 0) {
    throw new ValidationError("מצב הקופון השתנה — רענן ונסה שוב");
  }

  await prisma.offer.updateMany({
    where: { id: coupon.offerId, issuingBusinessId: owner },
    data: { isActive: true },
  });

  await logAuditEvent({
    businessId: owner,
    eventType: "REVENUE_COUPON_ENABLED",
    entityType: "COUPON",
    entityId: coupon.id,
    payload: {
      couponId: coupon.id,
      publicId: coupon.publicId,
      offerId: coupon.offerId,
      resumedCount: updated.count,
    },
  });

  return { publicId: coupon.publicId, state: "ACTIVE", resumedCount: updated.count };
}
