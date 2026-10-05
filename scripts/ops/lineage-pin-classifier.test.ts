/**
 * The lineage-pin classifier, proven without a database. Run:
 *   npx tsx scripts/ops/lineage-pin-classifier.test.ts
 *
 * Covers the three classes, every corroboration path, the fail-closed edges, and the real Production case
 * (run 37255469626: DOC-04 in B3/B9) expressed as facts only — no rule id or business enters the classifier.
 */
import { classifyPinMismatch, type PinFacts } from "./lineage-pin-classifier";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}
const d = (s: string) => new Date(s);
const LINEAGE = d("2026-09-24T17:00:48Z");
const f = (p: Partial<PinFacts>): PinFacts => ({ status: "SUPERSEDED", materializedAt: d("2026-09-23T23:36:07Z"), expectedLineageCreatedAt: LINEAGE, currentSlotStatus: "ACTIVE", ...p });

ok("LEGITIMATE_HISTORY: superseded, predates lineage, live slot row", classifyPinMismatch(f({})) === "LEGITIMATE_HISTORY");
ok("LEGITIMATE_HISTORY: predates lineage alone corroborates", classifyPinMismatch(f({ currentSlotStatus: null })) === "LEGITIMATE_HISTORY");
ok("LEGITIMATE_HISTORY: live slot row alone corroborates", classifyPinMismatch(f({ materializedAt: d("2026-09-30T00:00:00Z") })) === "LEGITIMATE_HISTORY");
ok("LEGITIMATE_HISTORY: STALE with corroboration", classifyPinMismatch(f({ status: "STALE" })) === "LEGITIMATE_HISTORY");
ok("LEGITIMATE_HISTORY: INSUFFICIENT_EVIDENCE slot row corroborates", classifyPinMismatch(f({ materializedAt: d("2026-09-30T00:00:00Z"), currentSlotStatus: "INSUFFICIENT_EVIDENCE" })) === "LEGITIMATE_HISTORY");

ok("HISTORICAL_STATUS_UNEXPLAINED: superseded, after lineage, no slot row",
  classifyPinMismatch(f({ materializedAt: d("2026-09-30T00:00:00Z"), currentSlotStatus: null })) === "HISTORICAL_STATUS_UNEXPLAINED");
ok("HISTORICAL_STATUS_UNEXPLAINED: a slot row that is itself SUPERSEDED does not corroborate",
  classifyPinMismatch(f({ materializedAt: d("2026-09-30T00:00:00Z"), currentSlotStatus: "SUPERSEDED" })) === "HISTORICAL_STATUS_UNEXPLAINED");
ok("HISTORICAL_STATUS_UNEXPLAINED: unknown expected-lineage time cannot corroborate",
  classifyPinMismatch(f({ expectedLineageCreatedAt: null, currentSlotStatus: null })) === "HISTORICAL_STATUS_UNEXPLAINED");
ok("HISTORICAL_STATUS_UNEXPLAINED: created at the same instant as the lineage is not 'before'",
  classifyPinMismatch(f({ materializedAt: LINEAGE, currentSlotStatus: null })) === "HISTORICAL_STATUS_UNEXPLAINED");

ok("LIVE_WRONG_PIN: ACTIVE under the wrong lineage, even with corroboration", classifyPinMismatch(f({ status: "ACTIVE" })) === "LIVE_WRONG_PIN");
ok("LIVE_WRONG_PIN: INSUFFICIENT_EVIDENCE under the wrong lineage", classifyPinMismatch(f({ status: "INSUFFICIENT_EVIDENCE" })) === "LIVE_WRONG_PIN");
ok("LIVE_WRONG_PIN: an unknown status is never history (fail-closed)", classifyPinMismatch(f({ status: "WHATEVER" })) === "LIVE_WRONG_PIN");

// The real Production case (diagnostic run 37255469626), facts only.
ok("Production B3 (facts of run 37255469626) => LEGITIMATE_HISTORY", classifyPinMismatch({
  status: "SUPERSEDED", materializedAt: d("2026-09-23T23:36:07.317Z"), expectedLineageCreatedAt: d("2026-09-24T17:00:48.814Z"), currentSlotStatus: "ACTIVE" }) === "LEGITIMATE_HISTORY");
ok("Production B9 (facts of run 37255469626) => LEGITIMATE_HISTORY", classifyPinMismatch({
  status: "SUPERSEDED", materializedAt: d("2026-09-23T23:34:26.320Z"), expectedLineageCreatedAt: d("2026-09-24T17:00:48.814Z"), currentSlotStatus: "ACTIVE" }) === "LEGITIMATE_HISTORY");

console.log(failed === 0 ? "\nLineage-pin classifier: history passes only when proven; live or unexplained mismatches fail. ✔" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
