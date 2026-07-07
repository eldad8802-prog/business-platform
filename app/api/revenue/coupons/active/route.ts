import { NextRequest, NextResponse } from "next/server";
import { handleError } from "@/lib/handle-error";
import { getActiveCoupons } from "@/lib/services/revenue/active-coupons.service";

export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;
    const limitRaw = params.get("limit");
    const limit = limitRaw ? Number(limitRaw) : 6;

    // Opt-in reference point for distance. Invalid/absent → no distance computed.
    const latRaw = params.get("lat");
    const lngRaw = params.get("lng");
    const near =
      latRaw !== null && lngRaw !== null
        ? { lat: Number(latRaw), lng: Number(lngRaw) }
        : null;

    const coupons = await getActiveCoupons({ limit, near });

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

