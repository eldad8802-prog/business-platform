/**
 * Offer semantics — pure. No database.
 *   npx tsx lib/services/revenue/offer-semantics.verify.test.ts
 */

import { canonicalOfferSemantics } from "@/lib/services/revenue/offer-semantics";

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

const semantics = canonicalOfferSemantics({
  benefitType: "pct",
  value: "20",
  scope: "כל העסק",
  minPurchase: 50,
  newCustomersOnly: true,
});

ok("benefit type is structured", semantics.benefitType === "pct");
ok("benefit value is the raw value, not a sentence", semantics.benefitValue === "20");
ok("scope is structured", semantics.benefitScope === "כל העסק");
ok("minimum is a decimal string", semantics.minPurchaseAmount === "50.00");
ok("new-customers flag is explicit", semantics.newCustomersOnly === true);

const open = canonicalOfferSemantics({
  benefitType: "giftProduct",
  value: "קפה",
  scope: "קפה",
  minPurchase: null,
  newCustomersOnly: false,
});
ok("missing minimum stays null", open.minPurchaseAmount === null);
ok("new-customers false is stored, not left unknown", open.newCustomersOnly === false);

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\noffer semantics: all checks passed");
