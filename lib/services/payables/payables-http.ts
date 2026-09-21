/**
 * Payables ↔ HTTP boundary.
 *
 * The domain throws its own errors so that `payables-core` and the service stay
 * free of anything web-shaped. But `handleError` only understands `AppError`,
 * so an un-translated domain error would leave the route as a 500 — the wrong
 * status for "you asked for a commitment that does not exist", and a 500 that
 * would also show up in exactly the monitoring that is supposed to mean
 * something is broken.
 *
 * So the translation happens here, once, at the edge:
 *
 *   PayablesNotFoundError          → 404
 *   PayablesValidationError        → 400
 *   BankCoordinatesInvalidError    → 400  (names the field, never the value)
 *   PayablesConflictError          → 409
 *   PayablesBankCryptoConfigError  → 503  (generic text: a missing key is an
 *                                          operator problem, not the owner's)
 *   anything else                  → untouched, and `handleError` still reports 500
 *
 * A cross-tenant reference is deliberately a 404 rather than a 403: the service
 * finds nothing under the caller's tenant context, and answering "forbidden"
 * would confirm that the row exists in someone else's business.
 */

import { NextResponse } from "next/server";
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "@/lib/errors";
import { handleError } from "@/lib/handle-error";
import {
  PayablesConflictError,
  PayablesNotFoundError,
  PayablesValidationError,
} from "@/lib/services/payables/payables-core";
import {
  BankCoordinatesInvalidError,
  PayablesBankCryptoConfigError,
} from "@/lib/services/payables/payables-bank-crypto";

export const BANK_STORAGE_UNAVAILABLE = "Bank account storage is not configured";

export function handlePayablesError(error: unknown): NextResponse {
  if (error instanceof PayablesNotFoundError) {
    return handleError(new NotFoundError(error.message));
  }
  if (error instanceof PayablesValidationError || error instanceof BankCoordinatesInvalidError) {
    return handleError(new ValidationError(error.message));
  }
  if (error instanceof PayablesConflictError) {
    return handleError(new ConflictError("PAYABLES_CONFLICT", error.message));
  }
  if (error instanceof PayablesBankCryptoConfigError) {
    // The operator needs to know; the log line names the class only.
    console.error("payables: bank crypto is not configured (PayablesBankCryptoConfigError)");
    return handleError(new ServiceUnavailableError(BANK_STORAGE_UNAVAILABLE));
  }
  return handleError(error);
}

/** A positive integer route parameter, or a 400 — never a silent NaN lookup. */
export function parseId(value: string, label: string): number {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw new ValidationError(`Invalid ${label}`);
  }
  return num;
}

export async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = (await req.json()) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* an unparseable body is an empty body; required fields then fail properly */
  }
  return {};
}

export function requiredString(
  body: Record<string, unknown>,
  key: string,
): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${key} is required`);
  }
  return value.trim();
}

export function optionalString(
  body: Record<string, unknown>,
  key: string,
): string | null {
  const value = body[key];
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new ValidationError(`${key} must be a string`);
  return value.trim() || null;
}

export function requiredDate(body: Record<string, unknown>, key: string): Date {
  const value = body[key];
  if (typeof value !== "string" || value === "") {
    throw new ValidationError(`${key} is required (ISO date string)`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError(`${key} must be a valid date`);
  }
  return date;
}

export function optionalPositiveInt(
  body: Record<string, unknown>,
  key: string,
): number | null {
  const value = body[key];
  if (value == null) return null;
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw new ValidationError(`${key} must be a positive integer`);
  }
  return num;
}

/**
 * An amount stays a STRING all the way to the domain, which parses it into
 * integer minor units and rejects a third decimal place. Passing it through a
 * JS number here would be the one place a rounding error could enter, so a
 * number is accepted but immediately stringified rather than arithmetic'd.
 */
export function amountString(
  body: Record<string, unknown>,
  key: string,
): string {
  const value = body[key];
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new ValidationError(`${key} is required`);
}
