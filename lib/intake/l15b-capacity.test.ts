/**
 * Leads L1.5-b · PR-2 — capacity metrics for held / waiting intake receipts (monitoring only).
 * Pure suite. Run with:
 *   npx tsx lib/intake/l15b-capacity.test.ts
 *
 * Pins:
 *   - tiers 500 / 1,000 / 2,000 per business and 20,000 platform-wide; reading them never refuses anything
 *   - the backlog / flow reads are bounded (row cap + server statement timeout), read-only, scan only the OPEN
 *     backlog (never PROCESSED / IGNORED history, never purged dead letters), select no payload or person field
 *   - the sweep reads capacity once per business per run, after its own work, best effort (a failed read is counted,
 *     never a business error); new red reasons exist ONLY with INTAKE_CAPACITY_ALERTS_ENABLED=true; a tier crossing
 *     is reported once; the platform alert at most once a day
 * The DB halves (exact counts per class and connection, the cap, timings at 50 / 500 / 2,000 / 20,000 / 50,000,
 * flow, tier crossing once, RLS isolation) run in .m6/capacity-battery.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cappedCount, HELD_GLOBAL_ALERT, HELD_TIERS, heldTier, oldest, totalsOf } from "./intake-capacity";
import { capacityAlertsEnabled, emptyCapacity, firstRunOfUtcDay, sweepHealth, type IntakeSweepReport } from "./intake-sweeper";
import { emptyTally } from "./core/processor";

let checks = 0;
function test(name: string, fn: () => void) {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
}
const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");

console.log("\nLeads L1.5-b · PR-2 — capacity — pure suite\n");

test("tiers and the platform threshold", () => {
  assert.deepEqual([...HELD_TIERS], [500, 1000, 2000]);
  assert.equal(HELD_GLOBAL_ALERT, 20_000);
  assert.equal(heldTier(0), 0);
  assert.equal(heldTier(499), 0);
  assert.equal(heldTier(500), 500);
  assert.equal(heldTier(999), 500);
  assert.equal(heldTier(1000), 1000);
  assert.equal(heldTier(2000), 2000);
  assert.equal(heldTier(50_000), 2000);
});

test("a capped count reads as at most the cap, with +", () => {
  assert.deepEqual(cappedCount(2501, { capped: true, scanCap: 2500 }), { n: 2500, plus: true });
  assert.deepEqual(cappedCount(40, { capped: true, scanCap: 2500 }), { n: 40, plus: true });
  assert.deepEqual(cappedCount(2501, { capped: false, scanCap: 2500 }), { n: 2501, plus: false });
});

test("totals and oldest", () => {
  const c = (held: number, due: number, retrying: number, deadLetters: number) =>
    ({ sourceKey: "web.form", providerAccountRef: "x", held, heldByReason: {}, due, retrying, deadLetters, oldestHeldAt: null, oldestUnfinishedAt: null });
  assert.deepEqual(totalsOf([c(1, 2, 3, 4), c(10, 20, 30, 40)]), { held: 11, due: 22, retrying: 33, deadLetters: 44 });
  const a = new Date("2026-11-01T00:00:00Z"), b = new Date("2026-11-02T00:00:00Z");
  assert.equal(oldest([null, b, a, null]), a);
  assert.equal(oldest([null, null]), null);
});

test("alerts are off unless exactly \"true\"; the platform alert once a day", () => {
  assert.equal(capacityAlertsEnabled({}), false);
  assert.equal(capacityAlertsEnabled({ INTAKE_CAPACITY_ALERTS_ENABLED: "1" }), false);
  assert.equal(capacityAlertsEnabled({ INTAKE_CAPACITY_ALERTS_ENABLED: "TRUE" }), false);
  assert.equal(capacityAlertsEnabled({ INTAKE_CAPACITY_ALERTS_ENABLED: "true" }), true);
  assert.equal(firstRunOfUtcDay(new Date("2026-11-07T00:04:00Z")), true);
  assert.equal(firstRunOfUtcDay(new Date("2026-11-07T00:10:00Z")), false);
  assert.equal(firstRunOfUtcDay(new Date("2026-11-07T13:02:00Z")), false);
});

test("health: capacity changes the verdict only through the two flagged fields", () => {
  const base = (): IntakeSweepReport => ({
    businesses: 1, quarantinedSkipped: 0, businessErrors: 0, events: emptyTally(), payloadsPurged: 0,
    commerce: { receipts: 0, webhooksReactivated: 0, failures: 0 },
    revenueSources: { receipts: 0, unreadable: 0, failures: 0, calls: 0 },
    backlog: { deadLettersNew: 0, deadLettersOpen: 0, pendingStale: 0, pendingStaleNew: 0, held: 0, businessesNeedingAttention: 0 },
    capacity: emptyCapacity(),
  });
  const r = base();
  Object.assign(r.capacity, { held: 30_000, businessesAt500: 3, businessesAt1000: 2, businessesAt2000: 1, maxHeldPerBusiness: 25_000, oldestHeldHours: 300, cappedBusinesses: 1, unreadBusinesses: 2 });
  assert.deepEqual(sweepHealth(r), { ok: true, job: [], events: [] }, "counts alone never turn the run red");
  const t = base(); t.capacity.tierCrossingsNew = 1;
  assert.deepEqual(sweepHealth(t).events, ["held_capacity_tier"]);
  const g = base(); g.capacity.globalAlert = true;
  assert.deepEqual(sweepHealth(g).events, ["held_capacity_global"]);
});

const store = read("lib/intake/intake-event.store.ts");
const backlog = store.slice(store.indexOf("export async function intakeBacklog("), store.indexOf("export async function intakeFlow("));
const flow = store.slice(store.indexOf("export async function intakeFlow("), store.indexOf("export async function claimHeldTierCrossing("));
const tierFn = store.slice(store.indexOf("export async function claimHeldTierCrossing("));

test("backlog / flow reads: bounded, read-only, open backlog only, no payload", () => {
  for (const [name, fn] of [["backlog", backlog], ["flow", flow]] as const) {
    assert.match(fn, /set_config\('statement_timeout', \$\{String\(CAPACITY_STATEMENT_TIMEOUT_MS\)\}, true\)/, name);
    assert.ok(fn.includes("LIMIT ${cap + 1}::int"), `${name}: row cap`);
    assert.doesNotMatch(fn, /\bUPDATE\b|\bINSERT\b|\bDELETE\b/, `${name}: read-only`);
    assert.doesNotMatch(fn, /"payload"|"metadata"|"externalEventId"|customerId|messageId/, `${name}: no payload or person field`);
    assert.match(fn, /"businessId" = \$\{businessId\}::int/, name);
    assert.match(fn, /withTenantTransaction/, `${name}: under the business's RLS`);
  }
  assert.match(backlog, /e\."status" IN \('RECEIVED', 'PERSISTED', 'FAILED'\)/, "never PROCESSED / IGNORED");
  assert.match(backlog, /e\."status" <> 'FAILED' OR e\."nextAttemptAt" IS NOT NULL OR e\."payloadPurgedAt" IS NULL/, "never a purged dead letter");
  assert.match(flow, /e\."receivedAt" >= \$\{utc\(lookback\)\}/, "flow scans a bounded window");
  assert.match(store, /const CAPACITY_STATEMENT_TIMEOUT_MS = (\d+);/);
  assert.ok(Number(/const CAPACITY_STATEMENT_TIMEOUT_MS = (\d+);/.exec(store)![1]) < 5000);
});

test("a tier crossing is claimed once: newest `tier` stamped, re-reported only after falling below", () => {
  assert.ok(tierFn.includes("if (Number(c.held) < tier || Number(c.stamped) >= tier) return false;"));
  assert.match(tierFn, /ORDER BY e\."receivedAt" DESC, e\."id" DESC\s*LIMIT \$\{tier\}::int/);
  assert.match(tierFn, /return true;/);
});

test("the sweep reads capacity after its work, best effort, and alerts only when switched on", () => {
  const sweeper = read("lib/intake/intake-sweeper.ts");
  const job = sweeper.slice(sweeper.indexOf("const h = await intakeHealthCounts(businessId, now);"), sweeper.indexOf("return drained;"));
  assert.match(job, /await readCapacity\(report\.capacity, businessId, now, alerts\)\.catch\(\(\) => \{\s*report\.capacity\.unreadBusinesses \+= 1;\s*\}\);/);
  assert.match(sweeper, /const alerts = capacityAlertsEnabled\(\);/);
  assert.match(sweeper, /if \(alerts\) for \(const t of HELD_TIERS\) if \(t <= tier && \(await claimHeldTierCrossing\(businessId, t, now\)\)\) c\.tierCrossingsNew \+= 1;/);
  assert.match(sweeper, /report\.capacity\.globalAlert = alerts && report\.capacity\.held >= HELD_GLOBAL_ALERT && firstRunOfUtcDay\(now\);/);
  assert.doesNotMatch(sweeper.slice(sweeper.indexOf("async function readCapacity(")), /\bpayload\b|phone|email|externalEventId/);
});

console.log(`\nALL L1.5-b CAPACITY TESTS PASSED — ${checks} checks\n`);
