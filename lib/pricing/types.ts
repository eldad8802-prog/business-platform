export type PricingInput = {
  materialCost?: number;
  laborMinutes?: number;
  hourlyRate?: number;
  overheadPercent?: number;
  marketLow?: number;
  marketHigh?: number;
};

export type NormalizedPricingInput = {
  materialCost: number;
  laborMinutes: number;
  hourlyRate: number;
  overheadPercent: number;
  marketLow?: number;
  marketHigh?: number;
};

export type PricingResult = {
  laborCost: number;
  directCost: number;
  overheadCost: number;
  fullCost: number;
  minimumPrice: number;
  recommendedPrice: number;
  premiumPrice: number;
};