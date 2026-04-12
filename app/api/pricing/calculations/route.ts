import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/prisma";
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

    const calculations = await prisma.pricingCalculation.findMany({
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
    });

    return NextResponse.json({
      count: calculations.length,
      calculations,
    });
  } catch (error) {
    console.error("pricing calculations get error:", error);

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
        rawError: String(error),
      },
      { status: 400 }
    );
  }
}