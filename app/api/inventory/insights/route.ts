import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { inventoryIntelligenceService } from "@/lib/services/inventory/inventory-intelligence.service";

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const insights =
      await inventoryIntelligenceService.getInsights(
        user.businessId
      );

    return NextResponse.json({
      success: true,
      insights,
    });
  } catch (err) {
    console.error("INSIGHTS ERROR:", err);

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}