import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { inventoryIntelligenceService } from "@/lib/services/inventory/inventory-intelligence.service";

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return authRequiredResponse(req);
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