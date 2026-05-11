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
