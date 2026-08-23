import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getOffersByBusiness } from "@/lib/services/offer.service";
import { handleError } from "@/lib/handle-error";

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const offers = await getOffersByBusiness(user.businessId);

    return NextResponse.json({ offers }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * RETIRED (COUPON-01). This is the endpoint that produced the audit's orphaned
 * offers 6, 7 and 8.
 *
 * It created an `Offer` on its own and left issuing the `Coupon` to a second,
 * separate client call. When that second call failed, the offer stayed behind:
 * invisible in "הקופונים שלי" (which lists coupons), unredeemable, and
 * impossible for the owner to stop — an adversarial pass confirmed such a row
 * is completely unreachable through the product.
 *
 * Publishing is now one atomic server-side operation at `POST /api/revenue/coupons`,
 * so a bare offer is not a state the product can produce. This handler is kept
 * as an explicit 410 rather than deleted so any unknown caller gets a clear
 * signal instead of a mystery 404. No live code path calls it.
 */
export async function POST() {
  return NextResponse.json(
    {
      error:
        "Endpoint retired. Publish a coupon atomically via POST /api/revenue/coupons.",
      code: "OFFER_CREATE_RETIRED",
    },
    { status: 410 }
  );
}