/**
 * Unit test — previous-month net derivation (server, summaryOnly).
 * Run: npx tsx lib/documents/previous-net.test.ts
 */
import assert from "node:assert/strict";
import { derivePreviousNet } from "@/lib/documents/previous-net";

function main() {
  // Both aggregates null (zero rows) → no prior data → null, NOT 0. This is the
  // signal the client uses to hide the delta entirely.
  assert.equal(
    derivePreviousNet(null, null),
    null,
    "both sums null → null (no prior data)"
  );
  assert.notEqual(
    derivePreviousNet(null, null),
    0,
    "no prior data must be null, never 0"
  );

  // Income only (expense had no rows) → positive net.
  assert.equal(
    derivePreviousNet(42900, null),
    42900,
    "income only → net = income"
  );

  // Expense only (income had no rows) → negative net.
  assert.equal(
    derivePreviousNet(null, 24660),
    -24660,
    "expense only → net = -expense"
  );

  // Both present → income - expense.
  assert.equal(
    derivePreviousNet(42900, 24660),
    18240,
    "both present → income - expense"
  );

  // A real zero baseline (income exactly equals expense) stays 0, NOT null —
  // 0 here is genuine data (there were rows), distinct from "no prior data".
  assert.equal(
    derivePreviousNet(5000, 5000),
    0,
    "equal income/expense → 0 (real data, not null)"
  );

  console.log("previous-net.test.ts: ok");
}

main();
