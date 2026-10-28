/**
 * Leads L1 · G-07 — the sweep's verdict separates "the job failed" from "business events need someone",
 * and neither can hide behind a green run. Pure suite. Run with:
 *   npx tsx lib/intake/sweep-health.test.ts
 *
 * Pins:
 *   - a business that could not be swept → JOB problem
 *   - a receipt failed in this run, a dead letter no sweep had reported yet (webhook-time ones included),
 *     a store reconciliation failure → EVENT problems; each makes the run unhealthy
 *   - open (already reported) dead letters and stale receipts are reported as counts, not as red forever
 *   - Rivhit (S1-A, its own track) stays in the report and out of this verdict
 *   - the route answers 500 on either kind and names which; the report and logs carry counts only
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sweepHealth, type IntakeSweepReport } from "./intake-sweeper";
import { emptyTally } from "./core/processor";

let checks = 0;
function test(name: string, fn: () => void) {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
}

const clean = (): IntakeSweepReport => ({
  businesses: 3,
  quarantinedSkipped: 0,
  businessErrors: 0,
  events: emptyTally(),
  payloadsPurged: 0,
  commerce: { receipts: 0, webhooksReactivated: 0, failures: 0 },
  revenueSources: { receipts: 0, unreadable: 0, failures: 0, calls: 0 },
  backlog: { deadLettersNew: 0, deadLettersOpen: 0, pendingStale: 0, businessesNeedingAttention: 0 },
});
const withR = (patch: (r: IntakeSweepReport) => void) => { const r = clean(); patch(r); return sweepHealth(r); };

console.log("\nLeads L1 · G-07 sweep health — pure suite\n");

test("a clean run is healthy", () => {
  assert.deepEqual(sweepHealth(clean()), { ok: true, job: [], events: [] });
});

test("a business that could not be swept is a JOB problem", () => {
  assert.deepEqual(withR((r) => { r.businessErrors = 1; }), { ok: false, job: ["business_errors"], events: [] });
});

test("failed receipts, NEW dead letters (any path) and store reconciliation failures are EVENT problems", () => {
  assert.deepEqual(withR((r) => { r.events.failed = 2; }), { ok: false, job: [], events: ["failed_receipts"] });
  assert.deepEqual(withR((r) => { r.backlog.deadLettersNew = 1; }), { ok: false, job: [], events: ["dead_letters_new"] });
  assert.deepEqual(withR((r) => { r.commerce.failures = 1; }), { ok: false, job: [], events: ["commerce_reconcile_failures"] });
  assert.deepEqual(withR((r) => { r.businessErrors = 1; r.commerce.failures = 1; r.backlog.deadLettersNew = 3; }),
    { ok: false, job: ["business_errors"], events: ["dead_letters_new", "commerce_reconcile_failures"] });
});

test("already-reported dead letters and stale receipts are visible counts, not red forever", () => {
  assert.equal(withR((r) => { r.backlog.deadLettersOpen = 5; r.backlog.pendingStale = 2; r.backlog.businessesNeedingAttention = 1; }).ok, true);
});

test("Rivhit (S1-A) failures stay in the report, outside this verdict", () => {
  assert.equal(withR((r) => { r.revenueSources.failures = 4; }).ok, true);
});

test("structural: the route answers by this verdict; the store reports each dead letter once; counts only", () => {
  const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
  const route = read("app/api/intake/sweep/route.ts");
  assert.match(route, /const health = sweepHealth\(report\)/);
  assert.match(route, /\{ status: health\.ok \? 200 : 500 \}/);
  assert.match(route, /health: \{ job: health\.job, events: health\.events \}/);
  const store = read("lib/intake/intake-event.store.ts");
  const fn = store.slice(store.indexOf("export async function intakeHealthCounts("), store.indexOf("export const FAILED_PAYLOAD_RETENTION_MS"));
  assert.match(fn, /jsonb_build_object\('deadLetterReportedAt'/);
  assert.match(fn, /\("metadata" -> 'deadLetterReportedAt'\) IS NULL/);
  assert.match(fn, /"businessId" = \$\{businessId\}/);
  const sweeper = read("lib/intake/intake-sweeper.ts");
  assert.match(sweeper, /console\.warn\("\[intake-sweep\] business attention", \{ businessId, \.\.\.h \}\)/);
  assert.doesNotMatch(sweeper.slice(sweeper.indexOf("export async function runIntakeSweep(")), /\bpayload\b|phone|email|externalEventId/);
});

console.log(`\nALL L1 SWEEP-HEALTH TESTS PASSED — ${checks} checks\n`);
