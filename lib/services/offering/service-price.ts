import { Prisma } from "@prisma/client";

export const SERVICE_PRICE_MODES = [
  "FIXED",
  "FROM",
  "RANGE",
  "QUOTE_REQUIRED",
  "NO_PUBLIC_PRICE",
] as const;

export type ServicePriceModeName = (typeof SERVICE_PRICE_MODES)[number];

export type ServicePriceInput = {
  priceMode: ServicePriceModeName;
  priceAmount?: number | string | null;
  priceMax?: number | string | null;
};

export type ServicePriceValue = {
  priceMode: ServicePriceModeName;
  priceAmount: Prisma.Decimal | null;
  priceMax: Prisma.Decimal | null;
};

export class ServicePriceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServicePriceError";
  }
}

function money(value: number | string | null | undefined, field: string): Prisma.Decimal | null {
  if (value === undefined || value === null || value === "") return null;
  let decimal: Prisma.Decimal;
  try {
    decimal = new Prisma.Decimal(value);
  } catch {
    throw new ServicePriceError(`${field} is not a price`);
  }
  if (!decimal.isFinite() || decimal.isNegative()) {
    throw new ServicePriceError(`${field} must be zero or greater`);
  }
  return decimal;
}

/**
 * A public service price. Zero is a real price. "Ask us" is a mode, not a zero.
 */
export function normalizeServicePrice(input: ServicePriceInput): ServicePriceValue {
  if (!SERVICE_PRICE_MODES.includes(input.priceMode)) {
    throw new ServicePriceError("Unknown price mode");
  }
  const priceAmount = money(input.priceAmount, "priceAmount");
  const priceMax = money(input.priceMax, "priceMax");

  if (input.priceMode === "FIXED" || input.priceMode === "FROM") {
    if (!priceAmount) throw new ServicePriceError(`${input.priceMode} requires a price`);
    if (priceMax) throw new ServicePriceError(`${input.priceMode} does not take a maximum`);
    return { priceMode: input.priceMode, priceAmount, priceMax: null };
  }

  if (input.priceMode === "RANGE") {
    if (!priceAmount || !priceMax) {
      throw new ServicePriceError("RANGE requires a minimum and a maximum");
    }
    if (priceMax.lessThan(priceAmount)) {
      throw new ServicePriceError("RANGE maximum is below the minimum");
    }
    return { priceMode: input.priceMode, priceAmount, priceMax };
  }

  if (priceAmount || priceMax) {
    throw new ServicePriceError(`${input.priceMode} does not take a price`);
  }
  return { priceMode: input.priceMode, priceAmount: null, priceMax: null };
}
