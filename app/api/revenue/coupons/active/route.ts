import { NextRequest, NextResponse } from "next/server";
import { handleError } from "@/lib/handle-error";
import { getActiveCoupons } from "@/lib/services/revenue/active-coupons.service";

export async function GET(req: NextRequest) {
  try {
    const limitRaw = req.nextUrl.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : 6;

    const coupons = await getActiveCoupons({ limit });

    return NextResponse.json(
      {
        coupons,
      },
      { status: 200 }
    );
  } catch (error) {
    return handleError(error);
  }
}

