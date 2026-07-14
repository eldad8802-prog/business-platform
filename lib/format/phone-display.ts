/**
 * Display-only phone formatter.
 *
 * NEVER used for storage or identity — the canonical value in the DB (produced
 * by `normalizeCustomerPhone`) is the source of truth and is untouched. This
 * only makes a canonical Israeli number pleasant to read in the UI.
 *
 * Contract:
 *  - A canonical Israeli number (digits, starting `972`) → readable IL format
 *    (mobile / 07x: `0XX-XXX-XXXX`; landline: `0X-XXX-XXXX`).
 *  - Anything not safely recognizable (foreign, unusual length, non-numeric)
 *    → returned exactly as stored. We never guess.
 */
export function formatPhoneForDisplay(phone: string | null | undefined): string {
  const raw = (phone ?? "").trim();
  if (!raw) return raw;

  const digits = raw.replace(/\D/g, "");
  // Only canonical Israeli numbers are safe to reformat.
  if (!/^972\d+$/.test(digits)) return raw;

  const local = "0" + digits.slice(3); // 972XXXXXXXXX → 0XXXXXXXXX

  // Mobile (05x) and 07x virtual numbers: 10 digits → 3-3-4.
  if (/^0[57]\d{8}$/.test(local)) {
    return `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}`;
  }
  // Geographic landlines (02/03/04/08/09) and 07-less variants: 9 digits → 2-3-4.
  if (/^0[234689]\d{7}$/.test(local)) {
    return `${local.slice(0, 2)}-${local.slice(2, 5)}-${local.slice(5)}`;
  }

  // Israeli prefix but an unusual length — don't guess; show as stored.
  return raw;
}
