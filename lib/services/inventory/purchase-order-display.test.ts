/**
 * Purchasing Phase D — derived display state (pure, no DB):
 *   npx tsx lib/services/inventory/purchase-order-display.test.ts
 */
import {
  derivePurchaseOrderDisplayState,
  purchaseOrderDisplayBucket,
  isReceivableDisplayState,
  type PurchaseOrderDisplayInput,
} from "@/lib/services/inventory/purchase-order-display";

let failed = 0;
function ok(name: string, cond: boolean) {
  if (!cond) {
    console.error("FAIL:", name);
    failed += 1;
  } else {
    console.log("OK:", name);
  }
}

function inp(
  partial: Partial<PurchaseOrderDisplayInput>
): PurchaseOrderDisplayInput {
  return {
    status: "CONFIRMED",
    orderedQty: 10,
    receivedQty: 0,
    closedShortQty: 0,
    openQty: 10,
    sharedAt: null,
    ...partial,
  };
}
const state = (p: Partial<PurchaseOrderDisplayInput>) =>
  derivePurchaseOrderDisplayState(inp(p));

// States.
ok("open, not shared → OPEN", state({}) === "OPEN");
ok("shared, nothing received → SHARED", state({ sharedAt: new Date() }) === "SHARED");
ok("some received, open remainder → PARTIAL", state({ receivedQty: 4, openQty: 6 }) === "PARTIAL");
ok("full → RECEIVED", state({ receivedQty: 10, openQty: 0 }) === "RECEIVED");
ok("closed short → CLOSED", state({ receivedQty: 4, closedShortQty: 6, openQty: 0 }) === "CLOSED");
ok("cancelled → CANCELLED", state({ status: "CANCELLED" }) === "CANCELLED");

// Precedence.
ok("received beats shared → PARTIAL", state({ sharedAt: new Date(), receivedQty: 4, openQty: 6 }) === "PARTIAL");
ok("cancelled beats everything", state({ status: "CANCELLED", sharedAt: new Date(), receivedQty: 4, openQty: 6 }) === "CANCELLED");

// Buckets.
ok("OPEN → pending", purchaseOrderDisplayBucket("OPEN") === "pending");
ok("SHARED → transit", purchaseOrderDisplayBucket("SHARED") === "transit");
ok("PARTIAL → transit", purchaseOrderDisplayBucket("PARTIAL") === "transit");
ok("RECEIVED → history", purchaseOrderDisplayBucket("RECEIVED") === "history");
ok("CLOSED → history", purchaseOrderDisplayBucket("CLOSED") === "history");
ok("CANCELLED → history", purchaseOrderDisplayBucket("CANCELLED") === "history");

// Receivable states.
ok("OPEN receivable", isReceivableDisplayState("OPEN"));
ok("SHARED receivable", isReceivableDisplayState("SHARED"));
ok("PARTIAL receivable", isReceivableDisplayState("PARTIAL"));
ok("RECEIVED not receivable", !isReceivableDisplayState("RECEIVED"));
ok("CLOSED not receivable", !isReceivableDisplayState("CLOSED"));
ok("CANCELLED not receivable", !isReceivableDisplayState("CANCELLED"));

if (failed > 0) {
  console.error(`\n${failed} display check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll purchase-order-display (pure) checks passed");
