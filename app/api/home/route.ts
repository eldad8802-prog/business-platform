import { NextResponse } from "next/server";
import { getHomeData } from "@/features/home/services/home.service";
import { getCurrentUser } from "@/lib/auth";
import { getServerI18n } from "@/lib/i18n/server";

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const businessId = user.business?.id;

    if (!businessId) {
      return NextResponse.json(
        { error: "Business not found for current user" },
        { status: 400 }
      );
    }

    const { t } = await getServerI18n();
    const homeData = await getHomeData({
      businessName: user.business?.name || t("insights.home.businessFallback"),
      businessId,
      ownerName: user.name ?? undefined,
      t,
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