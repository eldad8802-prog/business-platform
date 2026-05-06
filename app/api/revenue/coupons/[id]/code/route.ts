import { NextRequest, NextResponse } from "next/server";
import { handleError } from "@/lib/handle-error";
import { getCouponCode } from "@/lib/services/revenue/coupon-code.service";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const publicId = id;
    const code = await getCouponCode(publicId);
    return NextResponse.json(code, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}

