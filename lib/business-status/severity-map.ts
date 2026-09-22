import type { InventoryAlertType } from "@prisma/client";

import type { Severity } from "./types";

/** Inventory alert type → unified severity (business-safe defaults). */
export function severityFromInventoryAlertType(
  type: InventoryAlertType
): Severity {
  switch (type) {
    case "CRITICAL_STOCK":
      return "CRITICAL";
    case "LOW_STOCK":
      return "MEDIUM";
    case "UNMATCHED_POS_PRODUCT":
      return "HIGH";
    case "SUSPICIOUS_CORRECTION":
      return "HIGH";
    default:
      return "MEDIUM";
  }
}

export function severityBillingPdfFailed(): Severity {
  return "HIGH";
}

export function severityBillingPendingReview(): Severity {
  return "MEDIUM";
}

/**
 * M1 — payables.
 *
 * Severity rises with how late the money already is, because that is the only signal available at L0.
 * It deliberately does NOT consider the amount: "large" is meaningless without a baseline for this
 * business, and inventing one from the number alone would be the first cross-business judgement in the
 * knowledge layer. Amount-awareness belongs to M4, once a per-business baseline exists.
 */
export function severityPayablesOverdue(daysLate: number): Severity {
  if (daysLate >= 30) return "CRITICAL";
  if (daysLate >= 7) return "HIGH";
  return "MEDIUM";
}

/** Nothing is wrong yet, so this never reaches CRITICAL — it only gets closer. */
export function severityPayablesDueSoon(daysUntil: number): Severity {
  if (daysUntil <= 3) return "MEDIUM";
  return "LOW";
}
