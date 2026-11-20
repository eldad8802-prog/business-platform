import { NextRequest, NextResponse } from "next/server";
import { guardFeature } from "@/lib/services/feature-access/feature-guard";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { enableCoupon } from "@/lib/services/revenue/my-coupons.service";

/** Re-activate a disabled coupon that is still in date. Owner-only (see disable). */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const featureDenied = await guardFeature(req, PLATFORM_FEATURE_KEYS.REVENUE);
  if (featureDenied) return featureDenied;
  try {
    const user = await getCurrentUser(req);

    if (!user?.businessId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const result = await enableCoupon(id, user.businessId, undefined, user.id);

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
