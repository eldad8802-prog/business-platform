import { PaymentMethod, Prisma } from "@prisma/client";
import { ValidationError } from "@/lib/errors";
import { parseDecimalString } from "./billing-decimal.parse";
import { validateLineIndex } from "./billing-line.validation";

/**
 * Pure validation + parsing for a single receipt payment line (תקבול),
 * the future D120 source. No DB access. Required fields depend on the
 * payment method. Amounts are sent as strings to preserve Decimal precision.
 */

const AMOUNT_MAX_VALUE = "9999999999999999"; // bounded under DECIMAL(18,2)
const TEXT_MAX_LENGTH = 200;

export type PaymentLineInputRaw = {
  method: unknown;
  amount: unknown;
  currency?: unknown;
  paymentDate: unknown;
  bankName?: unknown;
  bankBranch?: unknown;
  bankAccountNumber?: unknown;
  checkNumber?: unknown;
  checkDueDate?: unknown;
  cardBrand?: unknown;
  cardLast4?: unknown;
  reference?: unknown;
  lineIndex?: unknown;
};

export type PaymentLineParsed = {
  method: PaymentMethod;
  amount: Prisma.Decimal;
  currency: string;
  paymentDate: Date;
  bankName: string | null;
  bankBranch: string | null;
  bankAccountNumber: string | null;
  checkNumber: string | null;
  checkDueDate: Date | null;
  cardBrand: string | null;
  cardLast4: string | null;
  reference: string | null;
  lineIndex: number;
};

const PAYMENT_METHODS = new Set<string>(Object.values(PaymentMethod));

export function validatePaymentMethod(value: unknown): PaymentMethod {
  if (typeof value !== "string" || !PAYMENT_METHODS.has(value)) {
    throw new ValidationError(
      `method must be one of: ${Object.values(PaymentMethod).join(", ")}`
    );
  }
  return value as PaymentMethod;
}

function optionalTrimmedText(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ValidationError(`${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > TEXT_MAX_LENGTH) {
    throw new ValidationError(
      `${fieldName} must be at most ${TEXT_MAX_LENGTH} characters`
    );
  }
  return trimmed;
}

function requireText(value: string | null, fieldName: string): string {
  if (value === null) {
    throw new ValidationError(`${fieldName} is required for this payment method`);
  }
  return value;
}

function parseDateInput(value: unknown, fieldName: string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new ValidationError(`${fieldName} is not a valid date`);
    }
    return value;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${fieldName} must be an ISO date string`);
  }
  const parsed = new Date(value.trim());
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(`${fieldName} is not a valid date`);
  }
  return parsed;
}

function validateCurrency(value: unknown): string {
  if (value === undefined || value === null) return "ILS";
  if (typeof value !== "string") {
    throw new ValidationError("currency must be a string");
  }
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new ValidationError("currency must be a 3-letter code (e.g. ILS)");
  }
  return normalized;
}

function validateCardLast4(value: string | null): string {
  if (value === null) {
    throw new ValidationError("cardLast4 is required for CREDIT_CARD");
  }
  if (!/^\d{4}$/.test(value)) {
    throw new ValidationError("cardLast4 must be exactly 4 digits");
  }
  return value;
}

export function validateAndParsePaymentLine(
  raw: PaymentLineInputRaw,
  fallbackLineIndex: number
): PaymentLineParsed {
  if (raw === null || typeof raw !== "object") {
    throw new ValidationError("payment line input must be an object");
  }

  const indexSource =
    raw.lineIndex === undefined || raw.lineIndex === null
      ? fallbackLineIndex
      : raw.lineIndex;
  const lineIndex = validateLineIndex(indexSource, "lineIndex");

  const method = validatePaymentMethod(raw.method);
  const currency = validateCurrency(raw.currency);
  const paymentDate = parseDateInput(raw.paymentDate, "paymentDate");

  const amount = parseDecimalString(raw.amount, "amount", {
    min: "0",
    max: AMOUNT_MAX_VALUE,
    maxScale: 2,
    allowNegative: false,
  });
  if (amount.isZero()) {
    throw new ValidationError("amount must be greater than 0");
  }

  // Optional instrument fields (parsed regardless; required per method below).
  const bankName = optionalTrimmedText(raw.bankName, "bankName");
  const bankBranch = optionalTrimmedText(raw.bankBranch, "bankBranch");
  const bankAccountNumber = optionalTrimmedText(
    raw.bankAccountNumber,
    "bankAccountNumber"
  );
  const checkNumber = optionalTrimmedText(raw.checkNumber, "checkNumber");
  const cardBrand = optionalTrimmedText(raw.cardBrand, "cardBrand");
  const cardLast4Raw = optionalTrimmedText(raw.cardLast4, "cardLast4");
  const reference = optionalTrimmedText(raw.reference, "reference");

  let checkDueDate: Date | null = null;
  let cardLast4: string | null = cardLast4Raw;

  switch (method) {
    case PaymentMethod.CASH:
      // amount + date only.
      break;
    case PaymentMethod.BANK_TRANSFER:
      requireText(bankName, "bankName");
      requireText(bankBranch, "bankBranch");
      requireText(bankAccountNumber, "bankAccountNumber");
      break;
    case PaymentMethod.CHECK:
      requireText(bankName, "bankName");
      requireText(bankBranch, "bankBranch");
      requireText(bankAccountNumber, "bankAccountNumber");
      requireText(checkNumber, "checkNumber");
      checkDueDate = parseDateInput(raw.checkDueDate, "checkDueDate");
      break;
    case PaymentMethod.CREDIT_CARD:
      requireText(cardBrand, "cardBrand");
      cardLast4 = validateCardLast4(cardLast4Raw);
      break;
    case PaymentMethod.BIT:
    case PaymentMethod.PAYBOX:
    case PaymentMethod.OTHER:
      requireText(reference, "reference");
      break;
    default: {
      const _exhaustive: never = method;
      throw new ValidationError(`Unsupported payment method: ${_exhaustive}`);
    }
  }

  return {
    method,
    amount,
    currency,
    paymentDate,
    bankName,
    bankBranch,
    bankAccountNumber,
    checkNumber,
    checkDueDate,
    cardBrand,
    cardLast4,
    reference,
    lineIndex,
  };
}
