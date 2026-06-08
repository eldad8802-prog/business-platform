import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { createCouponFromOffer } from "@/lib/services/coupon.service";
import { handleError } from "@/lib/handle-error";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return authRequiredResponse(req);
    }

    const { id } = await context.params;
    const offerId = Number(id);

    const coupon = await createCouponFromOffer({
      offerId,
      businessId: user.businessId,
    });

    return NextResponse.json({ coupon }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}