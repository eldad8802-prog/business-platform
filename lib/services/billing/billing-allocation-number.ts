/**
 * Canonical derivation of the printable / reportable ITA allocation number.
 *
 * Per the official "Israel Invoice Model API Description" v2.0 (7/2024) §2.2.1,
 * the value shown under the heading "Allocation Number" on the invoice — and
 * included in the designated field of the detailed report — is the **9
 * right-most digits** of the `confirmation_number` returned by the Approval
 * service. The full `confirmation_number` is retained separately (in the
 * BillingAuthoritySubmission / BillingDocument allocationNumber columns) for
 * provider/audit/reconciliation and is NOT itself the displayed allocation
 * number.
 *
 * This is the SINGLE source of truth for that derivation — never re-slice the 9
 * digits anywhere else.
 */

/** §2.2.1 — the allocation number shown/reported is exactly 9 digits. */
export const ALLOCATION_NUMBER_DIGITS = 9 as const;

/**
 * Returns the 9 right-most digits of a confirmation number, or `null` when the
 * value cannot yield a valid allocation number.
 *
 * Fail-closed: `null` for empty/undefined, non-digit content, or fewer than 9
 * digits. Never uses `Number(...)`, so leading zeros and full precision are
 * preserved (the return is a string slice).
 */
export function deriveAllocationNumber(
  confirmationNumber: string | null | undefined
): string | null {
  if (typeof confirmationNumber !== "string") {
    return null;
  }
  const trimmed = confirmationNumber.trim();
  // Digits only — the contract's confirmation_number is numeric; anything else
  // is an unexpected format and must not be guessed at.
  if (!/^[0-9]+$/.test(trimmed)) {
    return null;
  }
  if (trimmed.length < ALLOCATION_NUMBER_DIGITS) {
    return null;
  }
  return trimmed.slice(-ALLOCATION_NUMBER_DIGITS);
}
