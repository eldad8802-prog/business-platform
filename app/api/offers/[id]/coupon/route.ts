import { NextRequest, NextResponse } from "next/server";
import { guardFeature } from "@/lib/services/feature-access/feature-guard";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { getCurrentUser } from "@/lib/auth";
import { createCouponFromOffer } from "@/lib/services/coupon.service";
import { handleError } from "@/lib/handle-error";
import { resolveCouponBaseUrl } from "@/lib/revenue/coupon-base-url";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const featureDenied = await guardFeature(req, PLATFORM_FEATURE_KEYS.REVENUE);
  if (featureDenied) return featureDenied;
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const offerId = Number(id);

    const coupon = await createCouponFromOffer({
      offerId,
      businessId: user.businessId,
      baseUrl: resolveCouponBaseUrl(req),
      actorUserId: user.id,
    });

    return NextResponse.json({ coupon }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}