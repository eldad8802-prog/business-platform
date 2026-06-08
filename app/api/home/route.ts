import { NextResponse } from "next/server";
import { getHomeData } from "@/features/home/services/home.service";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return authRequiredResponse(req);
    }

    const businessId = user.business?.id;

    if (!businessId) {
      return NextResponse.json(
        { error: "Business not found for current user" },
        { status: 400 }
      );
    }

    const homeData = await getHomeData({
      businessName: user.business?.name || "העסק שלך",
      businessId,
    });

    return NextResponse.json(homeData);
  } catch (error) {
    console.error("Home API error:", error);
    return NextResponse.json(
      { error: "Failed to load home data" },
      { status: 500 }
    );
  }
}