import { ValidationError } from "@/lib/errors";
import {
  BillingDraftHeaderInputParsed,
  BillingDraftHeaderInputRaw,
  BillingLineInputRaw,
  BillingLineParsed,
} from "../domain/billing.types";
import { parseDecimalString } from "./billing-decimal.parse";

const DESCRIPTION_MAX_LENGTH = 500;
const CUSTOMER_NAME_MAX_LENGTH = 200;
// Bounded under DECIMAL(18, 4) and DECIMAL(18, 2) DB columns.
const QUANTITY_MAX_VALUE = "99999999999999";
const UNIT_PRICE_MAX_VALUE = "99999999999999";

export function validateLineIndex(
  value: unknown,
  fieldName: string = "lineIndex"
): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ValidationError(`${fieldName} must be an integer`);
  }
  if (value < 1) {
    throw new ValidationError(`${fieldName} must be >= 1 (1-based)`);
  }
  return value;
}

function validateDescription(value: unknown): string {
  if (typeof value !== "string") {
    throw new ValidationError("description must be a string");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ValidationError("description is required");
  }
  if (trimmed.length > DESCRIPTION_MAX_LENGTH) {
    throw new ValidationError(
      `description must be at most ${DESCRIPTION_MAX_LENGTH} characters`
    );
  }
  return trimmed;
}

export function validateAndParseLineInput(
  raw: BillingLineInputRaw,
  fallbackLineIndex: number
): BillingLineParsed {
  if (raw === null || typeof raw !== "object") {
    throw new ValidationError("line input must be an object");
  }

  const indexSource =
    raw.lineIndex === undefined || raw.lineIndex === null
      ? fallbackLineIndex
      : raw.lineIndex;
  const lineIndex = validateLineIndex(indexSource, "lineIndex");

  const description = validateDescription(raw.description);

  const quantity = parseDecimalString(raw.quantity, "quantity", {
    min: "0",
    max: QUANTITY_MAX_VALUE,
    maxScale: 4,
    allowNegative: false,
  });
  if (quantity.isZero()) {
    throw new ValidationError("quantity must be greater than 0");
  }

  const unitPrice = parseDecimalString(raw.unitPrice, "unitPrice", {
    min: "0",
    max: UNIT_PRICE_MAX_VALUE,
    maxScale: 4,
    allowNegative: false,
  });

  const vatRatePercent = parseDecimalString(
    raw.vatRatePercent,
    "vatRatePercent",
    {
      min: "0",
      max: "100",
      maxScale: 2,
      allowNegative: false,
    }
  );

  return {
    description,
    quantity,
    unitPrice,
    vatRatePercent,
    lineIndex,
  };
}

export function validateDraftHeaderInput(
  raw: unknown
): BillingDraftHeaderInputParsed {
  if (raw === null || typeof raw !== "object") {
    throw new ValidationError("draft header input must be an object");
  }
  const obj = raw as BillingDraftHeaderInputRaw;

  let customerId: number | null = null;
  if (obj.customerId !== undefined && obj.customerId !== null) {
    if (
      typeof obj.customerId !== "number" ||
      !Number.isInteger(obj.customerId)
    ) {
      throw new ValidationError("customerId must be an integer");
    }
    if (obj.customerId <= 0) {
      throw new ValidationError("customerId must be a positive integer");
    }
    customerId = obj.customerId;
  }

  let customerNameSnapshot: string | null = null;
  if (
    obj.customerNameSnapshot !== undefined &&
    obj.customerNameSnapshot !== null
  ) {
    if (typeof obj.customerNameSnapshot !== "string") {
      throw new ValidationError("customerNameSnapshot must be a string");
    }
    const trimmed = obj.customerNameSnapshot.trim();
    if (trimmed.length === 0) {
      throw new ValidationError("customerNameSnapshot must not be empty");
    }
    if (trimmed.length > CUSTOMER_NAME_MAX_LENGTH) {
      throw new ValidationError(
        `customerNameSnapshot must be at most ${CUSTOMER_NAME_MAX_LENGTH} characters`
      );
    }
    customerNameSnapshot = trimmed;
  }

  return { customerId, customerNameSnapshot };
}
