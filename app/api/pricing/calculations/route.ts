import { NextResponse } from "next/server";
import { tenantTx } from "../../../../lib/tenant/tenant-tx";
import { getCurrentUser } from "../../../../lib/auth";

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    // `PricingCalculation` is FORCE RLS. Read on the bare client this returned
    // an empty list for every tenant — saved pricing work that still existed in
    // the database and could no longer be seen.
    const calculations = await tenantTx(user.businessId, (tx) =>
      tx.pricingCalculation.findMany({
      where: {
        businessId: user.businessId,
      },
      orderBy: {
        createdAt: "desc",
      },
      select: {
        id: true,
        businessId: true,
        pricingProfileId: true,

        inputMaterialCost: true,
        inputLaborMinutes: true,
        inputHourlyRate: true,
        inputOverheadPercent: true,

        laborCost: true,
        directCost: true,
        overheadCost: true,
        fullCost: true,

        minimumPrice: true,
        recommendedPrice: true,
        premiumPrice: true,

        marketLow: true,
        marketHigh: true,
        marketStatus: true,

        explanationText: true,
        createdAt: true,
      },
      })
    );

    return NextResponse.json({
      count: calculations.length,
      calculations,
    });
  } catch (error) {
    console.error("pricing calculations get error:", error);

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 400 }
    );
  }
}