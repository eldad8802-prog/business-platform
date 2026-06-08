import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { deleteTestBusinesses } from "@/lib/testing/cleanup-test-businesses";
import { signAuthToken } from "@/lib/auth-token";
import { ForbiddenError } from "@/lib/errors";
import { GET as getCouponCodeRoute } from "@/app/api/revenue/coupons/[id]/code/route";
import { getActiveCoupons } from "@/lib/services/revenue/active-coupons.service";
import { getCouponCode } from "@/lib/services/revenue/coupon-code.service";
import { getPublicCouponDetails } from "@/lib/services/revenue/coupon-details-public.service";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const REDEMPTION_SECRET_KEYS = ["token", "qrValue", "redeemLink"] as const;

function assertNoRedemptionSecrets(payload: unknown, label: string) {
  const serialized = JSON.stringify(payload);
  for (const key of REDEMPTION_SECRET_KEYS) {
    assert.equal(
      serialized.includes(`"${key}"`),
      false,
      `${label} must not include ${key}`
    );
  }
}

async function createBusiness(label: string) {
  const business = await prisma.business.create({
    data: {
      name: `W1-01 Coupon ${label} ${runId}`,
      users: {
        create: {
          email: `w1-01-coupon-${label}-${runId}@example.test`,
          password: "test-password",
          name: "Coupon Test User",
        },
      },
    },
    include: { users: true },
  });

  return {
    businessId: business.id,
    userId: business.users[0]!.id,
  };
}

async function createActiveCoupon(businessId: number) {
  const validUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const token = randomUUID();

  const offer = await prisma.offer.create({
    data: {
      issuingBusinessId: businessId,
      title: `Offer ${runId}`,
      customerBenefitText: "10% off",
      validUntil,
      isActive: true,
    },
  });

  const coupon = await prisma.coupon.create({
    data: {
      offerId: offer.id,
      issuingBusinessId: businessId,
      token,
      qrValue: `http://localhost:3000/revenue/redeem?token=${token}`,
      expiresAt: validUntil,
      status: "ACTIVE",
    },
  });

  return coupon;
}

async function main() {
  const issuer = await createBusiness("issuer");
  const other = await createBusiness("other");
  const businessIds = [issuer.businessId, other.businessId];

  const previousBypass = process.env.COUPON_PUBLIC_CODE_ENABLED;
  process.env.COUPON_PUBLIC_CODE_ENABLED = "false";

  try {
    const coupon = await createActiveCoupon(issuer.businessId);

    const marketing = await getPublicCouponDetails(coupon.publicId);
    assert.equal(marketing.coupon.publicId, coupon.publicId);
    assert.equal(
      (marketing.coupon as { id?: number }).id,
      undefined,
      "public coupon DTO must not expose internal id"
    );
    assertNoRedemptionSecrets(marketing, "public coupon details");

    const active = await getActiveCoupons({ limit: 6 });
    const activeHit = active.find((c) => c.publicId === coupon.publicId);
    assert.ok(activeHit, "active list includes seeded coupon");
    assertNoRedemptionSecrets(active, "active coupons");

    await assert.rejects(
      () =>
        getCouponCode(coupon.publicId, {
          mode: "issuer",
          issuerBusinessId: other.businessId,
        }),
      ForbiddenError,
      "non-issuer cannot load coupon code"
    );

    const issuerCode = await getCouponCode(coupon.publicId, {
      mode: "issuer",
      issuerBusinessId: issuer.businessId,
    });
    assert.equal(issuerCode.token, coupon.token);
    assert.ok(issuerCode.qrValue.includes(coupon.token));

    const unauthReq = new NextRequest(
      `http://localhost/api/revenue/coupons/${coupon.publicId}/code`
    );
    const unauthRes = await getCouponCodeRoute(unauthReq, {
      params: Promise.resolve({ id: coupon.publicId }),
    });
    assert.equal(unauthRes.status, 401, "route returns 401 without auth");

    let authToken: string;
    try {
      authToken = signAuthToken(other.userId);
    } catch (error) {
      console.warn(
        "Skipping authenticated route tests: AUTH_TOKEN_SECRET not configured.",
        error
      );
      return;
    }

    const forbiddenReq = new NextRequest(
      `http://localhost/api/revenue/coupons/${coupon.publicId}/code`,
      { headers: { Authorization: `Bearer ${authToken}` } }
    );
    const forbiddenRes = await getCouponCodeRoute(forbiddenReq, {
      params: Promise.resolve({ id: coupon.publicId }),
    });
    assert.equal(forbiddenRes.status, 403, "route returns 403 for non-issuer");

    const issuerToken = signAuthToken(issuer.userId);
    const successReq = new NextRequest(
      `http://localhost/api/revenue/coupons/${coupon.publicId}/code`,
      { headers: { Authorization: `Bearer ${issuerToken}` } }
    );
    const successRes = await getCouponCodeRoute(successReq, {
      params: Promise.resolve({ id: coupon.publicId }),
    });
    assert.equal(successRes.status, 200, "issuer receives coupon code");
    const successBody = await successRes.json();
    assert.equal(successBody.token, coupon.token);

    console.log("coupon-surface.w1-01: all assertions passed");
  } finally {
    if (previousBypass === undefined) {
      delete process.env.COUPON_PUBLIC_CODE_ENABLED;
    } else {
      process.env.COUPON_PUBLIC_CODE_ENABLED = previousBypass;
    }
    await deleteTestBusinesses(businessIds);
  }
}

main().catch((error) => {
  console.error("coupon-surface.w1-01 failed:", error);
  process.exit(1);
});
