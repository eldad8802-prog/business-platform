import { NextRequest, NextResponse } from "next/server";
import { guardFeature } from "@/lib/services/feature-access/feature-guard";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { inventoryIntelligenceService } from "@/lib/services/inventory/inventory-intelligence.service";

export async function GET(req: NextRequest) {
  const featureDenied = await guardFeature(req, PLATFORM_FEATURE_KEYS.INVENTORY);
  if (featureDenied) return featureDenied;
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const insights = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          inventoryIntelligenceService.getInsights(user.businessId, { tx })
        )
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