import { Prisma } from "@prisma/client";
import { ValidationError } from "@/lib/errors";

type DecimalLike = Prisma.Decimal | string;

type ParseOptions = {
  min?: DecimalLike;
  max?: DecimalLike;
  maxScale?: number;
  allowNegative?: boolean;
};

export function parseDecimalString(
  input: unknown,
  fieldName: string,
  opts: ParseOptions = {}
): Prisma.Decimal {
  if (typeof input === "number") {
    throw new ValidationError(
      `${fieldName} must be sent as a string to preserve Decimal precision; got number`
    );
  }
  if (typeof input !== "string") {
    throw new ValidationError(`${fieldName} must be a string`);
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new ValidationError(`${fieldName} is required`);
  }

  let value: Prisma.Decimal;
  try {
    value = new Prisma.Decimal(trimmed);
  } catch {
    throw new ValidationError(`${fieldName} is not a valid decimal value`);
  }

  if (!value.isFinite()) {
    throw new ValidationError(`${fieldName} must be a finite number`);
  }

  if (opts.allowNegative === false && value.isNegative()) {
    throw new ValidationError(`${fieldName} must not be negative`);
  }

  if (opts.min !== undefined) {
    const minDec = new Prisma.Decimal(opts.min);
    if (value.lessThan(minDec)) {
      throw new ValidationError(
        `${fieldName} must be >= ${minDec.toString()}`
      );
    }
  }

  if (opts.max !== undefined) {
    const maxDec = new Prisma.Decimal(opts.max);
    if (value.greaterThan(maxDec)) {
      throw new ValidationError(
        `${fieldName} must be <= ${maxDec.toString()}`
      );
    }
  }

  if (opts.maxScale !== undefined) {
    assertDecimalScale(value, opts.maxScale, fieldName);
  }

  return value;
}

export function assertDecimalScale(
  value: Prisma.Decimal,
  maxScale: number,
  fieldName: string
): void {
  const decimalPlaces = value.decimalPlaces();
  if (decimalPlaces > maxScale) {
    throw new ValidationError(
      `${fieldName} has too many decimal places (max ${maxScale}, got ${decimalPlaces})`
    );
  }
}
