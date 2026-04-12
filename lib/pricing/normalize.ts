import type { PricingInput, NormalizedPricingInput } from "./types";

function toSafeNumber(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0;
  }

  return value;
}

export function normalizeInput(input: PricingInput): NormalizedPricingInput {
  const materialCost = toSafeNumber(input.materialCost);
  const laborMinutes = toSafeNumber(input.laborMinutes);
  const hourlyRate = toSafeNumber(input.hourlyRate);

  const overheadPercent =
    typeof input.overheadPercent === "number" && !Number.isNaN(input.overheadPercent)
      ? input.overheadPercent
      : 10;

  const marketLow =
    typeof input.marketLow === "number" && !Number.isNaN(input.marketLow)
      ? input.marketLow
      : undefined;

  const marketHigh =
    typeof input.marketHigh === "number" && !Number.isNaN(input.marketHigh)
      ? input.marketHigh
      : undefined;

  return {
    materialCost,
    laborMinutes,
    hourlyRate,
    overheadPercent,
    marketLow,
    marketHigh,
  };
}