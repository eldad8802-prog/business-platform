import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { disableCoupon } from "@/lib/services/revenue/my-coupons.service";

/**
 * Kill switch — stop a live coupon (COUPON-02).
 *
 * Authorization is server-side and unconditional: the service compares the
 * coupon's `issuingBusinessId` against the authenticated session before it
 * reads state, so a business cannot disable another business's coupon (403)
 * and cannot use the response to learn whether it exists.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);

    if (!user?.businessId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const result = await disableCoupon(id, user.businessId);

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
