/**
 * Unit test — month-over-month net delta (PulseCard display logic).
 * Run: npx tsx components/documents/home/PulseCard.test.ts
 */
import assert from "node:assert/strict";
import { computeDelta } from "@/components/documents/home/PulseCard";

function main() {
  // No prior data → hidden (null). The card renders nothing for a null delta.
  assert.equal(computeDelta(18240, null), null, "previousNet null → hidden");

  // Zero baseline → hidden (division-by-zero guard), never a fabricated %.
  assert.equal(computeDelta(18240, 0), null, "previousNet 0 → hidden");

  // Increase 16285 → 18240 = +12.006% → rounds to +12, up.
  assert.deepEqual(
    computeDelta(18240, 16285),
    { pct: 12, dir: "up" },
    "increase → ▲ +12%"
  );

  // Decrease 20000 → 14000 = -30% → down.
  assert.deepEqual(
    computeDelta(14000, 20000),
    { pct: -30, dir: "down" },
    "decrease → ▼ -30%"
  );

  // Negative baseline improving -5000 → -2000 = +60% (uses Math.abs of base).
  assert.deepEqual(
    computeDelta(-2000, -5000),
    { pct: 60, dir: "up" },
    "negative baseline improving → ▲ +60%"
  );

  // Negative baseline worsening -2000 → -5000 = -150% → down.
  assert.deepEqual(
    computeDelta(-5000, -2000),
    { pct: -150, dir: "down" },
    "negative baseline worsening → ▼ -150%"
  );

  // Flat 100 → 100 = 0% → neutral variant, no arrow.
  assert.deepEqual(
    computeDelta(100, 100),
    { pct: 0, dir: "flat" },
    "no change → 0% flat"
  );

  console.log("PulseCard.test.ts: ok");
}

main();
