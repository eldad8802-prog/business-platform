/**
 * A0 — rendered-PDF characterization of the EXISTING billing documents.
 *
 * Renders each document type through BOTH existing renderers (HTML/Chromium —
 * the Production default — and pdfmake) and compares page count and extracted
 * text to baseline/pdf-render.json. Metadata that changes on every render is
 * excluded (see pdf-render-observations.ts). Never writes the baseline.
 *
 * Needs a local Chromium: npx playwright install chromium
 * Run: npx tsx .billing-a0/pdf-render.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { computePdfRenderObservations, PDF_METADATA_EXCLUDED } from "./pdf-render-observations";

let pass = 0;
const failures: string[] = [];

async function main() {
  const baseline = JSON.parse(readFileSync(path.join(__dirname, "baseline", "pdf-render.json"), "utf8")) as {
    meta: Record<string, unknown>;
    observations: Record<string, string>;
  };
  console.log(`baseline recorded from ${String(baseline.meta.sourceCommit)} (${String(baseline.meta.recordedWith)})`);
  console.log(`metadata excluded from comparison: ${PDF_METADATA_EXCLUDED.join(", ")}`);

  const actual = await computePdfRenderObservations();
  for (const key of Object.keys(baseline.observations).sort()) {
    const want = baseline.observations[key];
    const got = actual[key];
    if (got === want) {
      pass++;
      console.log(`  [PASS] ${key}`);
    } else {
      failures.push(key);
      console.log(`  [FAIL] ${key}\n      expected: ${JSON.stringify(want)}\n      actual:   ${JSON.stringify(got)}`);
    }
  }
  for (const key of Object.keys(actual)) {
    if (!(key in baseline.observations)) {
      failures.push(key);
      console.log(`  [FAIL] ${key} — produced but not in the baseline`);
    }
  }
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`FAIL: ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
