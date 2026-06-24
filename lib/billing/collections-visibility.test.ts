/**
 * Run: npx tsx lib/billing/collections-visibility.test.ts
 *
 * Pure logic for the invoice "גבייה" section visibility + status labels.
 */
import assert from "node:assert/strict";
import {
  isPaymentRequestStatus,
  PAYMENT_REQUEST_STATUS_LABEL,
  shouldShowCollections,
} from "./collections-visibility";

// --- not issued => hidden ---
assert.equal(shouldShowCollections("TAX_INVOICE", "DRAFT"), false);
assert.equal(shouldShowCollections("TAX_INVOICE", "PENDING_REVIEW"), false);

// --- QUOTE (even issued) => hidden ---
assert.equal(shouldShowCollections("QUOTE", "ISSUED"), false);

// --- other issued doc types => hidden ---
assert.equal(shouldShowCollections("RECEIPT", "ISSUED"), false);
assert.equal(shouldShowCollections("TAX_INVOICE_RECEIPT", "ISSUED"), false);
assert.equal(shouldShowCollections("CREDIT_NOTE", "ISSUED"), false);

// --- TAX_INVOICE + ISSUED => shown ---
assert.equal(shouldShowCollections("TAX_INVOICE", "ISSUED"), true);

// --- status labels: all five present and Hebrew, guard works ---
for (const status of [
  "PENDING",
  "PAID",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
] as const) {
  assert.equal(isPaymentRequestStatus(status), true);
  assert.ok(
    PAYMENT_REQUEST_STATUS_LABEL[status].length > 0,
    `missing label for ${status}`
  );
}
assert.equal(isPaymentRequestStatus("NOPE"), false);
assert.equal(isPaymentRequestStatus(null), false);
assert.equal(PAYMENT_REQUEST_STATUS_LABEL.PAID, "שולם");
assert.equal(PAYMENT_REQUEST_STATUS_LABEL.PENDING, "ממתין לתשלום");

console.log("collections-visibility tests: OK");
