import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";

import { normalizeInput } from "@/lib/pricing/normalize";
import { calculatePricing } from "@/lib/pricing/calculate";
import { checkMarket } from "@/lib/pricing/market-check";
import { buildExplanation } from "@/lib/pricing/explain";

type ProfitIndicator = "LOW" | "OK" | "HIGH";

function getProfitIndicator(profitPercent: number): ProfitIndicator {
  if (profitPercent < 20) return "LOW";
  if (profitPercent <= 40) return "OK";
  return "HIGH";
}

function getProfitIndicatorLabel(indicator: ProfitIndicator): string {
  switch (indicator) {
    case "LOW":
      return "נמוך";
    case "OK":
      return "תקין";
    case "HIGH":
      return "גבוה";
    default:
      return "תקין";
  }
}

function buildEnhancedExplanation(params: {
  baseExplanation: string;
  recommendedPrice: number;
  fullCost: number;
  profitAmount: number;
  profitPercent: number;
  marketStatus: string;
  profitIndicator: ProfitIndicator;
}): string {
  const {
    baseExplanation,
    recommendedPrice,
    fullCost,
    profitAmount,
    profitPercent,
    marketStatus,
    profitIndicator,
  } = params;

  const marketText =
    marketStatus === "BELOW_MARKET"
      ? "המחיר המומלץ נמוך מטווח השוק שסיפקת."
      : marketStatus === "WITHIN_MARKET"
      ? "המחיר המומלץ נמצא בתוך טווח השוק שסיפקת."
      : marketStatus === "ABOVE_MARKET"
      ? "המחיר המומלץ גבוה מטווח השוק שסיפקת."
      : "לא סופק מספיק מידע כדי להשוות לטווח השוק.";

  const profitText =
    profitIndicator === "LOW"
      ? "רמת הרווח כרגע נמוכה יחסית, ולכן כדאי לבדוק אם אפשר לעלות מעט את המחיר או לשפר עלויות."
      : profitIndicator === "OK"
      ? "רמת הרווח תקינה ומייצרת מרווח סביר."
      : "רמת הרווח גבוהה, וזה נותן לך מרווח חזק יותר על כל עסקה.";

  return [
    baseExplanation,
    `העלות המלאה שלך היא ${fullCost.toFixed(2)} ש"ח והמחיר המומלץ הוא ${recommendedPrice.toFixed(2)} ש"ח.`,
    `ברמת המחיר הזאת הרווח המשוער הוא ${profitAmount.toFixed(2)} ש"ח, שהם ${profitPercent.toFixed(1)}%.`,
    marketText,
    profitText,
  ]
    .filter(Boolean)
    .join(" ");
}

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const body = await req.json();

    let profile = null;

    if (body.pricingProfileId !== undefined && body.pricingProfileId !== null) {
      const pricingProfileId = Number(body.pricingProfileId);

      if (Number.isNaN(pricingProfileId)) {
        return NextResponse.json(
          { error: "pricingProfileId must be a valid number" },
          { status: 400 }
        );
      }

      profile = await prisma.pricingProfile.findFirst({
        where: {
          id: pricingProfileId,
          businessId: user.businessId,
          isActive: true,
        },
      });

      if (!profile) {
        return NextResponse.json(
          { error: "Pricing profile not found" },
          { status: 404 }
        );
      }
    }

    const normalized = normalizeInput({
      materialCost: body.materialCost ?? profile?.defaultMaterialCost ?? 0,
      laborMinutes: body.laborMinutes ?? profile?.defaultLaborMinutes ?? 0,
      hourlyRate: body.hourlyRate ?? profile?.defaultHourlyRate ?? 0,
      overheadPercent:
        body.overheadPercent ?? profile?.defaultOverheadPercent ?? undefined,
      marketLow: body.marketLow,
      marketHigh: body.marketHigh,
    });

    const result = calculatePricing(normalized);
    const marketStatus = checkMarket(result.recommendedPrice, normalized);

    const profitAmount = Number(
      (result.recommendedPrice - result.fullCost).toFixed(2)
    );

    const profitPercent =
      result.recommendedPrice > 0
        ? Number(((profitAmount / result.recommendedPrice) * 100).toFixed(2))
        : 0;

    const profitIndicator = getProfitIndicator(profitPercent);
    const profitIndicatorLabel = getProfitIndicatorLabel(profitIndicator);

    const baseExplanation = buildExplanation(result);
    const explanation = buildEnhancedExplanation({
      baseExplanation,
      recommendedPrice: result.recommendedPrice,
      fullCost: result.fullCost,
      profitAmount,
      profitPercent,
      marketStatus,
      profitIndicator,
    });

    const savedCalculation = await prisma.pricingCalculation.create({
      data: {
        businessId: user.businessId,
        pricingProfileId: profile?.id ?? null,

        inputMaterialCost: normalized.materialCost,
        inputLaborMinutes: normalized.laborMinutes,
        inputHourlyRate: normalized.hourlyRate,
        inputOverheadPercent: normalized.overheadPercent,

        laborCost: result.laborCost,
        directCost: result.directCost,
        overheadCost: result.overheadCost,
        fullCost: result.fullCost,

        minimumPrice: result.minimumPrice,
        recommendedPrice: result.recommendedPrice,
        premiumPrice: result.premiumPrice,

        marketLow: normalized.marketLow ?? null,
        marketHigh: normalized.marketHigh ?? null,
        marketStatus,
        explanationText: explanation,
      },
    });

    return NextResponse.json({
      calculationId: savedCalculation.id,
      businessId: savedCalculation.businessId,
      pricingProfileId: savedCalculation.pricingProfileId,
      itemContext: {
        profileName: profile?.name ?? null,
        itemType: profile?.type ?? null,
      },
      costBreakdown: {
        materialCost: normalized.materialCost,
        laborCost: result.laborCost,
        directCost: result.directCost,
        overheadCost: result.overheadCost,
        fullCost: result.fullCost,
      },
      priceOptions: {
        minimum: result.minimumPrice,
        recommended: result.recommendedPrice,
        premium: result.premiumPrice,
      },
      profit: {
        amount: profitAmount,
        percent: profitPercent,
        indicator: profitIndicator,
        label: profitIndicatorLabel,
      },
      marketCheck: {
        status: marketStatus,
        low: normalized.marketLow ?? null,
        high: normalized.marketHigh ?? null,
      },
      explanation,
    });
  } catch (error) {
    console.error("pricing calculate error:", error);

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
        rawError: String(error),
      },
      { status: 400 }
    );
  }
}