/**
 * A0 — golden characterization of the EXISTING billing documents (pure).
 *
 * Compares every observation from golden-observations.ts to the baseline recorded
 * from unmodified code (baseline/golden.json). This test NEVER writes the
 * baseline: a mismatch is a change in behaviour or output, and it fails.
 *
 * No database, no network, no clock. Run: npx tsx .billing-a0/golden.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { computeObservations } from "./golden-observations";

type Baseline = { meta: Record<string, unknown>; observations: Record<string, string> };

let pass = 0;
const failures: string[] = [];

function firstDiff(a: string, b: string): string {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return `first difference at char ${i}: expected …${JSON.stringify(a.slice(Math.max(0, i - 40), i + 40))}… got …${JSON.stringify(b.slice(Math.max(0, i - 40), i + 40))}…`;
}

async function main() {
  const file = path.join(__dirname, "baseline", "golden.json");
  const baseline = JSON.parse(readFileSync(file, "utf8")) as Baseline;
  const actual = await computeObservations();

  console.log(`baseline recorded from ${String(baseline.meta.sourceCommit)} (${String(baseline.meta.recordedWith)})`);

  const expectedKeys = Object.keys(baseline.observations).sort();
  const actualKeys = Object.keys(actual).sort();

  for (const key of expectedKeys) {
    const want = baseline.observations[key];
    const got = actual[key];
    if (got === undefined) {
      failures.push(key);
      console.log(`  [FAIL] ${key} — no longer produced`);
    } else if (got !== want) {
      failures.push(key);
      console.log(`  [FAIL] ${key} — ${firstDiff(want, got)}`);
    } else {
      pass++;
      console.log(`  [PASS] ${key}`);
    }
  }
  for (const key of actualKeys) {
    if (!(key in baseline.observations)) {
      failures.push(key);
      console.log(`  [FAIL] ${key} — produced but not in the baseline`);
    }
  }

  console.log(`\n${pass} passed, ${failures.length} failed (of ${expectedKeys.length} recorded observations)`);
  if (failures.length > 0) {
    console.log("FAIL: existing billing behaviour or output changed:");
    for (const f of failures) console.log(`FAIL: ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
