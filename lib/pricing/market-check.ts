import type { NormalizedPricingInput } from "./types";

export type MarketStatus =
  | "UNKNOWN"
  | "BELOW_MARKET"
  | "WITHIN_MARKET"
  | "ABOVE_MARKET";

export function checkMarket(
  price: number,
  input: NormalizedPricingInput
): MarketStatus {
  if (
    input.marketLow === undefined ||
    input.marketHigh === undefined
  ) {
    return "UNKNOWN";
  }

  if (price < input.marketLow) {
    return "BELOW_MARKET";
  }

  if (price > input.marketHigh) {
    return "ABOVE_MARKET";
  }

  return "WITHIN_MARKET";
}