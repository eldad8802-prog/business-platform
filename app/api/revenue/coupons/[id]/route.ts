import { NextRequest, NextResponse } from "next/server";
import { handleError } from "@/lib/handle-error";
import { getPublicCouponDetails } from "@/lib/services/revenue/coupon-details-public.service";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const publicId = id;
    const details = await getPublicCouponDetails(publicId);
    return NextResponse.json(details, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}

