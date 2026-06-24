/**
 * Supplier Domain Phase 3 — Measure conversion (pure, no DB):
 *   npx tsx lib/services/inventory/measure-conversion.service.test.ts
 */
import {
  effectiveFactor,
  toStockQuantity,
  toStockUnitCost,
} from "@/lib/services/inventory/measure-conversion.service";

let failed = 0;
function ok(name: string, cond: boolean) {
  if (!cond) {
    console.error("FAIL:", name);
    failed += 1;
  } else {
    console.log("OK:", name);
  }
}

// effectiveFactor — null / non-positive / non-finite all collapse to 1:1.
ok("effectiveFactor(null) = 1", effectiveFactor(null) === 1);
ok("effectiveFactor(undefined) = 1", effectiveFactor(undefined) === 1);
ok("effectiveFactor(0) = 1 (degrade)", effectiveFactor(0) === 1);
ok("effectiveFactor(-5) = 1 (degrade)", effectiveFactor(-5) === 1);
ok("effectiveFactor(NaN) = 1", effectiveFactor(NaN) === 1);
ok("effectiveFactor(12) = 12", effectiveFactor(12) === 12);
ok("effectiveFactor(1.5) = 1.5", effectiveFactor(1.5) === 1.5);

// toStockQuantity — purchase-units × factor.
ok("5 cases × 12 = 60", toStockQuantity(5, 12) === 60);
ok("5 × null = 5 (1:1)", toStockQuantity(5, null) === 5);
ok("3 × 1 = 3", toStockQuantity(3, 1) === 3);
ok("2 × 1.5 = 3", toStockQuantity(2, 1.5) === 3);

// toStockUnitCost — per purchase-unit ÷ factor; null cost ⇒ null.
ok("₪120/case ÷ 12 = ₪10", toStockUnitCost(120, 12) === 10);
ok("₪120 ÷ null = ₪120 (1:1)", toStockUnitCost(120, null) === 120);
ok("null cost → null", toStockUnitCost(null, 12) === null);
ok("undefined cost → null", toStockUnitCost(undefined, 12) === null);
ok("₪100 ÷ 0 = ₪100 (degrade to 1:1)", toStockUnitCost(100, 0) === 100);

if (failed > 0) {
  console.error(`\n${failed} measure-conversion check(s) failed.`);
  process.exit(1);
}
console.log("\nmeasure-conversion.service.test.ts: ok");
