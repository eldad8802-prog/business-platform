/**
 * Purchasing Phase B — derived fulfillment (pure, no DB):
 *   npx tsx lib/services/inventory/purchase-fulfillment.test.ts
 */
import {
  derivePurchaseOrderFulfillment,
  type FulfillmentLineQuantities,
} from "@/lib/services/inventory/purchase-fulfillment";

let failed = 0;
function ok(name: string, cond: boolean) {
  if (!cond) {
    console.error("FAIL:", name);
    failed += 1;
  } else {
    console.log("OK:", name);
  }
}

function line(
  orderedQty: number,
  receivedQty: number,
  closedShortQty: number
): FulfillmentLineQuantities {
  return {
    orderedQty,
    receivedQty,
    closedShortQty,
    openQty: orderedQty - receivedQty - closedShortQty,
  };
}

const status = (lines: FulfillmentLineQuantities[]) =>
  derivePurchaseOrderFulfillment(lines).status;

// Single-line states.
ok("no receiving → NOT_RECEIVED", status([line(10, 0, 0)]) === "NOT_RECEIVED");
ok("partial → PARTIALLY_RECEIVED", status([line(10, 4, 0)]) === "PARTIALLY_RECEIVED");
ok("full → FULLY_RECEIVED", status([line(10, 10, 0)]) === "FULLY_RECEIVED");
ok("received + closed-short remainder → CLOSED", status([line(10, 4, 6)]) === "CLOSED");
ok("closed-short with nothing received → CLOSED", status([line(10, 0, 10)]) === "CLOSED");

// closed-short but remainder still open (degenerate ordering) → still open work.
ok(
  "closed part, received part, open remainder → PARTIALLY_RECEIVED",
  status([line(10, 2, 3)]) === "PARTIALLY_RECEIVED"
);

// Multi-line aggregation.
ok(
  "one full + one untouched → PARTIALLY_RECEIVED",
  status([line(10, 10, 0), line(5, 0, 0)]) === "PARTIALLY_RECEIVED"
);
ok(
  "all lines full → FULLY_RECEIVED",
  status([line(10, 10, 0), line(5, 5, 0)]) === "FULLY_RECEIVED"
);
ok(
  "one full + one closed-short → CLOSED",
  status([line(10, 10, 0), line(5, 2, 3)]) === "CLOSED"
);

// Totals are derived and reported.
const readout = derivePurchaseOrderFulfillment([line(10, 4, 0), line(5, 1, 0)]);
ok("totals.orderedQty = 15", readout.totals.orderedQty === 15);
ok("totals.receivedQty = 5", readout.totals.receivedQty === 5);
ok("totals.openQty = 10", readout.totals.openQty === 10);

// Edge: empty (unreachable — PO always has lines) → NOT_RECEIVED, not FULLY.
ok("empty → NOT_RECEIVED", status([]) === "NOT_RECEIVED");

// Float tolerance.
ok(
  "fractional full → FULLY_RECEIVED",
  status([line(2.5, 2.5, 0)]) === "FULLY_RECEIVED"
);

if (failed > 0) {
  console.error(`\n${failed} fulfillment check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll purchase-fulfillment (pure) checks passed");
