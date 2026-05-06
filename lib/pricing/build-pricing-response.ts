import type { NormalizedPricingInput, PricingResult } from "./types";
import type { MarketStatus } from "./market-check";

type ProfitSimulation = {
  profitValue: number;
  profitPercent: number;
};

export function buildPricingResponse(params: {
  calculationResult: PricingResult;
  marketCheckResult: MarketStatus;
  input: NormalizedPricingInput;
  recommendedPrice: number;
}) {
  const { calculationResult, marketCheckResult, input, recommendedPrice } = params;

  const roundTo2 = (value: number) => Math.round(value * 100) / 100;

  function simulate(price: number): ProfitSimulation {
    const profitValue = roundTo2(price - calculationResult.fullCost);
    const profitPercent =
      price > 0 ? roundTo2((profitValue / price) * 100) : 0;
    return { profitValue, profitPercent };
  }

  const minimumSim = simulate(calculationResult.minimumPrice);
  const recommendedSim = simulate(recommendedPrice);
  const premiumSim = simulate(calculationResult.premiumPrice);

  const breakEvenPrice = calculationResult.fullCost;

  const market =
    input.marketLow === undefined || input.marketHigh === undefined
      ? null
      : {
          low: input.marketLow,
          high: input.marketHigh,
          status: marketCheckResult,
          positionRatio:
            input.marketHigh > input.marketLow
              ? roundTo2(
                  (recommendedPrice - input.marketLow) /
                    (input.marketHigh - input.marketLow)
                )
              : null,
        };

  const insights: string[] = [
    `הרווח במחיר מינימלי הוא ${minimumSim.profitPercent.toFixed(1)}%.`,
    `הרווח במחיר מומלץ הוא ${recommendedSim.profitPercent.toFixed(1)}%.`,
    `הרווח במחיר פרימיום הוא ${premiumSim.profitPercent.toFixed(1)}%.`,
  ];

  if (market) {
    const marketText =
      marketCheckResult === "BELOW_MARKET"
        ? "המחיר המומלץ מתחת לטווח השוק."
        : marketCheckResult === "WITHIN_MARKET"
        ? "המחיר המומלץ בתוך טווח השוק."
        : marketCheckResult === "ABOVE_MARKET"
        ? "המחיר המומלץ מעל טווח השוק."
        : "לא סופק מספיק מידע כדי להשוות לטווח השוק.";

    insights.push(marketText);
  }

  return {
    cost: {
      total: calculationResult.fullCost,
      breakdown: {
        materials: input.materialCost,
        labor: calculationResult.laborCost,
        overhead: calculationResult.overheadCost,
      },
    },
    priceOptions: {
      minimum: calculationResult.minimumPrice,
      recommended: recommendedPrice,
      premium: calculationResult.premiumPrice,
    },
    profit: {
      value: recommendedSim.profitValue,
      percent: recommendedSim.profitPercent,
    },
    breakEven: {
      price: breakEvenPrice,
    },
    simulations: {
      minimum: {
        price: calculationResult.minimumPrice,
        profitValue: minimumSim.profitValue,
        profitPercent: minimumSim.profitPercent,
      },
      recommended: {
        price: recommendedPrice,
        profitValue: recommendedSim.profitValue,
        profitPercent: recommendedSim.profitPercent,
      },
      premium: {
        price: calculationResult.premiumPrice,
        profitValue: premiumSim.profitValue,
        profitPercent: premiumSim.profitPercent,
      },
    },
    market,
    insights,
  };
}
