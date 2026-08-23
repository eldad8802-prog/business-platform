import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { getCouponBusinessIdentity } from "@/lib/services/revenue/coupon-business-identity.service";

/**
 * The authenticated business's real identity for the coupon preview (COUPON-04).
 * Read-only projection over `Business` + `BusinessProfile` — it introduces no
 * new source of truth, and the business id comes from the session only.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);

    if (!user?.businessId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const business = await getCouponBusinessIdentity(user.businessId);

    return NextResponse.json({ business }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
