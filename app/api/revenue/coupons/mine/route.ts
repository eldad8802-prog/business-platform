import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { getMyCoupons } from "@/lib/services/revenue/my-coupons.service";

/**
 * The business owner's own coupons (COUPON-02).
 *
 * `mine` is a static segment so it resolves here and no longer falls through to
 * the public `[id]` route, where it was being cast to a UUID and 500-ing.
 *
 * Tenant scope: the business id comes from the authenticated session only — it
 * is never accepted from the query string or body, so this endpoint cannot be
 * pointed at another business's coupons.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);

    if (!user?.businessId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const coupons = await getMyCoupons(user.businessId);

    return NextResponse.json({ coupons }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
