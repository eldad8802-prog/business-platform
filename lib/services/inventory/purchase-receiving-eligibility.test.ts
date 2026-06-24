/**
 * Purchasing Phase C — receive eligibility (pure, no DB):
 *   npx tsx lib/services/inventory/purchase-receiving-eligibility.test.ts
 */
import { PurchaseOrderStatus } from "@prisma/client";
import { isPurchaseOrderReceivable } from "@/lib/services/inventory/purchase-receiving-eligibility";
import type { FulfillmentStatus } from "@/lib/services/inventory/purchase-fulfillment";

let failed = 0;
function ok(name: string, cond: boolean) {
  if (!cond) {
    console.error("FAIL:", name);
    failed += 1;
  } else {
    console.log("OK:", name);
  }
}

function rec(
  status: PurchaseOrderStatus,
  fulfillment: FulfillmentStatus,
  orderedQty: number,
  openQty: number
): boolean {
  return isPurchaseOrderReceivable({ status, fulfillment, totals: { orderedQty, openQty } });
}

// Receivable: open commitment, not received / partially received.
ok("CONFIRMED + NOT_RECEIVED + open → receivable", rec("CONFIRMED", "NOT_RECEIVED", 10, 10));
ok("CONFIRMED + PARTIALLY + open → receivable", rec("CONFIRMED", "PARTIALLY_RECEIVED", 10, 6));

// Not receivable: nothing open.
ok("FULLY_RECEIVED (open 0) → not receivable", !rec("CONFIRMED", "FULLY_RECEIVED", 10, 0));
ok("CLOSED (open 0) → not receivable", !rec("CONFIRMED", "CLOSED", 10, 0));

// CANCELLED never receivable, even with open qty.
ok("CANCELLED + open → not receivable", !rec("CANCELLED", "NOT_RECEIVED", 10, 10));

// No ordered lines → not receivable.
ok("no ordered lines → not receivable", !rec("CONFIRMED", "NOT_RECEIVED", 0, 0));

// Independent of AWAITING_DELIVERY: a CONFIRMED open PO is receivable WITHOUT ever
// being AWAITING_DELIVERY; a DRAFT open PO is receivable too (status≠CANCELLED).
ok("DRAFT + open → receivable (not gated on AWAITING_DELIVERY)", rec("DRAFT", "NOT_RECEIVED", 10, 10));
ok("CONFIRMED open is receivable without AWAITING_DELIVERY", rec("CONFIRMED", "NOT_RECEIVED", 5, 5));

if (failed > 0) {
  console.error(`\n${failed} eligibility check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll purchase-receiving-eligibility (pure) checks passed");
