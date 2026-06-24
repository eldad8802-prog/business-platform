import { dateKeyJerusalem } from "@/lib/utils/jerusalem-month-range";

/** ITA allocation disclosure thresholds (ILS, before VAT) by invoice calendar date. */
export const AUTHORITY_THRESHOLD_2024_AND_EARLIER_ILS = 25_000;
export const AUTHORITY_THRESHOLD_2025_ILS = 20_000;
export const AUTHORITY_THRESHOLD_2026_H1_ILS = 10_000;
export const AUTHORITY_THRESHOLD_2026_H2_AND_LATER_ILS = 5_000;

const THRESHOLD_EFFECTIVE_FROM_2025 = "2025-01-01";
const THRESHOLD_EFFECTIVE_FROM_2026_H1 = "2026-01-01";
const THRESHOLD_EFFECTIVE_FROM_2026_H2 = "2026-06-01";

/**
 * Returns the ITA regulatory allocation threshold (ILS, before VAT) for the
 * invoice calendar date in Asia/Jerusalem.
 *
 * - Through 2024-12-31 → 25,000
 * - 2025-01-01 through 2025-12-31 → 20,000
 * - 2026-01-01 through 2026-05-31 → 10,000
 * - From 2026-06-01 → 5,000
 */
export function getAuthorityAllocationThresholdIls(invoiceDate: Date): number {
  const dateKey = dateKeyJerusalem(invoiceDate);

  if (dateKey >= THRESHOLD_EFFECTIVE_FROM_2026_H2) {
    return AUTHORITY_THRESHOLD_2026_H2_AND_LATER_ILS;
  }
  if (dateKey >= THRESHOLD_EFFECTIVE_FROM_2026_H1) {
    return AUTHORITY_THRESHOLD_2026_H1_ILS;
  }
  if (dateKey >= THRESHOLD_EFFECTIVE_FROM_2025) {
    return AUTHORITY_THRESHOLD_2025_ILS;
  }
  return AUTHORITY_THRESHOLD_2024_AND_EARLIER_ILS;
}
