/**
 * Customer domain core — pure validation, no Prisma, no DB.
 *
 * EXTRACTED VERBATIM from `customer.service.ts`, which now imports these
 * instead of defining them. Behaviour is unchanged: same limits, same messages,
 * same `ValidationError` type, same trim-then-check order.
 *
 * # Why the extraction
 *
 * The Import preview (I-5) has to tell an owner whether a spreadsheet row would
 * be accepted, WITHOUT writing anything. The rules lived inside a module that
 * instantiates a Prisma client on import, so a dry run could not reach them —
 * and the alternative, restating "a customer needs a name, max 200 chars" in
 * the import layer, is exactly the shadow business rule that drifts.
 *
 * This mirrors the shape the Leads domain already uses: `lead-core.ts` holds
 * the pure vocabulary and validation, `lead.service.ts` holds the DB work.
 */

import { ValidationError } from "@/lib/errors";

export const CUSTOMER_NAME_MAX = 200;
export const CUSTOMER_EMAIL_MAX = 200;
export const CUSTOMER_CITY_MAX = 120;
export const CUSTOMER_NOTES_MAX = 5000;

/** A customer must have a name. Trimmed, bounded, and required. */
export function normalizeCustomerName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError("name is required");
  }
  const trimmed = value.trim();
  if (trimmed.length > CUSTOMER_NAME_MAX) {
    throw new ValidationError(
      `name must be at most ${CUSTOMER_NAME_MAX} characters`
    );
  }
  return trimmed;
}

/** Optional text: null when absent or blank, bounded when present. */
export function normalizeCustomerOptionalText(
  value: unknown,
  field: string,
  max: number
): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be a string or null`);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) {
    throw new ValidationError(`${field} must be at most ${max} characters`);
  }
  return trimmed;
}
