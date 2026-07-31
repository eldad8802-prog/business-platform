import { prisma } from "@/lib/prisma";
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "@/lib/errors";

export type CouponCodeDTO = {
  token: string;
  qrValue: string;
  redeemLink: string;
};

type CouponStatusValue = "ACTIVE" | "REDEEMED" | "EXPIRED" | "CANCELLED";

/** Minimal coupon shape the access guard needs. Kept narrow on purpose so the
 *  guard stays pure and unit-testable without a DB. */
export type CouponCodeRecord = {
  issuingBusinessId: number;
  status: CouponStatusValue;
  expiresAt: Date;
  token: string;
  qrValue: string;
};

/**
 * W1-01: the caller MUST be an authenticated business. Derive the issuer
 * identity from the authenticated user only — never from request input.
 * Returns the businessId, or throws 401 when there is no valid authenticated
 * business. There is NO environment flag or bypass — auth is unconditional in
 * every environment (fail-closed by absence).
 */
export function requireIssuerBusinessId(
  user: { businessId?: number | null } | null | undefined
): number {
  if (!user || typeof user.businessId !== "number") {
    throw new UnauthorizedError();
  }
  return user.businessId;
}

/**
 * W1-01 authorization + validity guard for the coupon redemption secret.
 *
 * Ownership is checked BEFORE status/expiry so a non-issuer can never probe a
 * coupon's existence/state (anti-enumeration): a foreign coupon and an expired
 * one both look the same to a non-owner (403 either way, once past 404).
 *
 * Pure function — no DB, no env, no clock except the injectable `now`.
 */
export function assertCouponCodeAccess(input: {
  coupon: CouponCodeRecord | null;
  requestingBusinessId: number;
  now?: Date;
}): CouponCodeDTO {
  const { coupon, requestingBusinessId } = input;
  const now = input.now ?? new Date();

  if (!coupon) {
    throw new NotFoundError("Coupon not found");
  }

  // Issuer ownership — the decisive W1-01 check. Non-issuer → 403.
  if (coupon.issuingBusinessId !== requestingBusinessId) {
    throw new ForbiddenError("אין לך הרשאה לצפות בקוד של קופון זה");
  }

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

/**
 * Returns the redemption secret (token/QR) for a coupon — ONLY to the issuing
 * business. `requestingBusinessId` must come from the authenticated user.
 */
export async function getCouponCode(
  publicId: string,
  requestingBusinessId: number
): Promise<CouponCodeDTO> {
  if (!publicId || typeof publicId !== "string") {
    throw new ValidationError("Invalid coupon id");
  }
  if (!Number.isInteger(requestingBusinessId)) {
    // Defensive: the route derives this from the authenticated user, but never
    // trust a non-integer through to a DB comparison.
    throw new UnauthorizedError();
  }

  const coupon = await prisma.coupon.findUnique({
    where: { publicId },
    select: {
      issuingBusinessId: true,
      status: true,
      expiresAt: true,
      token: true,
      qrValue: true,
    },
  });

  return assertCouponCodeAccess({ coupon, requestingBusinessId });
}
