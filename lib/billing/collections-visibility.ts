/**
 * Pure visibility + labeling logic for the invoice "גבייה" (Collections)
 * section. Kept out of the client component so it is unit-testable without a
 * DOM or render harness.
 */

export type PaymentRequestStatus =
  | "PENDING"
  | "PAID"
  | "FAILED"
  | "CANCELLED"
  | "EXPIRED";

export const PAYMENT_REQUEST_STATUS_LABEL: Record<PaymentRequestStatus, string> =
  {
    PENDING: "ממתין לתשלום",
    PAID: "שולם",
    FAILED: "נכשל",
    CANCELLED: "בוטל",
    EXPIRED: "פג תוקף",
  };

export function isPaymentRequestStatus(
  value: unknown
): value is PaymentRequestStatus {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(PAYMENT_REQUEST_STATUS_LABEL, value)
  );
}

/**
 * Collections is shown ONLY for an ISSUED TAX_INVOICE — the canonical open-debt
 * instrument. Drafts, quotes, receipts, credit notes, and invoice-receipts
 * (paid at issue) never show it.
 */
export function shouldShowCollections(
  documentType: string,
  status: string
): boolean {
  return documentType === "TAX_INVOICE" && status === "ISSUED";
}
