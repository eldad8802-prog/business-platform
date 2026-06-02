/**
 * Canonical phone format for `Customer.phone` — the platform's source of truth.
 *
 * # Why this exists
 *
 * Customer identity hinges on `(businessId, normalizedPhone)`. The DB unique
 * index `Customer_businessId_phone_key` only catches duplicates when both
 * rows were normalized identically — every `Customer` write path MUST go
 * through this function. That contract is how the constraint stays
 * meaningful over time.
 *
 * # Normalization rules
 *
 * 1. Strip every non-digit (`+`, `-`, spaces, parentheses, etc.).
 * 2. If the result starts with `"00"` (international dialing prefix in many
 *    countries), drop those two leading zeros.
 * 3. If the result starts with `"972"` → keep as-is.
 * 4. If the result starts with `"0"` (Israeli local format) → replace the
 *    leading `"0"` with `"972"`.
 * 5. Otherwise → keep the stripped digits.
 *
 * # Validity
 *
 * Returns `null` for:
 *   - `null` / `undefined` / empty input
 *   - input that produces fewer than 8 digits after stripping
 *
 * Callers that receive `null` MUST treat the phone as missing — never persist
 * the raw input as a fallback.
 *
 * # Scope today vs. future
 *
 * The product is IL-launched, so the canonicalization is IL-aware. Extending
 * to a full E.164 normalizer (libphonenumber or equivalent) is a strict
 * superset that does not require any caller change — the call site contract
 * (`string | null | undefined → string | null`) stays identical.
 *
 * # Examples
 *
 *   "0501234567"          → "972501234567"
 *   "+972-50-123-4567"    → "972501234567"
 *   "972 50 123 4567"     → "972501234567"
 *   "00972501234567"      → "972501234567"   (00-prefix stripped)
 *   "+1 (555) 123-4567"   → "15551234567"
 *   ""                    → null
 *   null                  → null
 *   "12"                  → null             (too short)
 */
export function normalizeCustomerPhone(
  raw: string | null | undefined
): string | null {
  if (!raw) return null;

  let digits = raw.replace(/\D/g, "");

  // International "00" dialing prefix → strip.
  if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }

  if (digits.length < 8) return null;

  if (digits.startsWith("972")) return digits;
  if (digits.startsWith("0")) return "972" + digits.slice(1);

  return digits;
}
