import { PRICING_CONFIG } from "./config";
import type { NormalizedPricingInput, PricingResult } from "./types";

function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function calculatePricing(
  input: NormalizedPricingInput
): PricingResult {
  const laborHours = input.laborMinutes / 60;
  const laborCost = laborHours * input.hourlyRate;

  const directCost = input.materialCost + laborCost;
  const overheadCost = directCost * (input.overheadPercent / 100);
  const fullCost = directCost + overheadCost;

  const minimumPrice = Math.max(
    fullCost,
    fullCost * PRICING_CONFIG.profitMultipliers.minimum
  );

  const recommendedPrice =
    fullCost * PRICING_CONFIG.profitMultipliers.recommended;

  const premiumPrice = fullCost * PRICING_CONFIG.profitMultipliers.premium;

  return {
    laborCost: roundTo2(laborCost),
    directCost: roundTo2(directCost),
    overheadCost: roundTo2(overheadCost),
    fullCost: roundTo2(fullCost),
    minimumPrice: roundTo2(minimumPrice),
    recommendedPrice: roundTo2(recommendedPrice),
    premiumPrice: roundTo2(premiumPrice),
  };
}