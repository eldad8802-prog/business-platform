/**
 * Sale price evidence — pure. No database.
 *   npx tsx lib/services/inventory/sale-price.verify.test.ts
 */

import {
  observeUnitPrice,
  unitPriceForResolvedPending,
} from "@/lib/services/inventory/sale-price";

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

ok("omitted price stays absent", observeUnitPrice(undefined).kind === "absent");
ok("null price stays absent", observeUnitPrice(null).kind === "absent");
ok("blank price stays absent", observeUnitPrice("  ").kind === "absent");
ok("supplied price is kept", observeUnitPrice("59.9").kind === "present" && observeUnitPrice("59.9").kind === "present");

const supplied = observeUnitPrice(59.9);
ok(
  "numeric price canonicalizes without borrowing a catalog price",
  supplied.kind === "present" && supplied.amount === "59.90"
);
ok("zero is a real price, not absence", observeUnitPrice(0).kind === "present" && observeUnitPrice(0).kind === "present" && (observeUnitPrice(0) as { amount: string }).amount === "0.00");
ok("negative price is rejected", observeUnitPrice(-1).kind === "invalid");
ok("unparsed prose is rejected", observeUnitPrice("catalog").kind === "invalid");

ok(
  "one observed line keeps its price",
  unitPriceForResolvedPending({
    quantity: 2,
    allItems: [{ quantity: 2, unitPrice: "10.00" }],
  }) === "10.00"
);
ok(
  "collapsed multi-line pending sale does not invent a unit price",
  unitPriceForResolvedPending({
    quantity: 5,
    allItems: [
      { quantity: 2, unitPrice: "10.00" },
      { quantity: 3, unitPrice: "4.00" },
    ],
  }) === null
);
ok(
  "a line without a price stays without a price",
  unitPriceForResolvedPending({
    quantity: 1,
    allItems: [{ quantity: 1, unitPrice: null }],
  }) === null
);

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nsale price evidence: all checks passed");
