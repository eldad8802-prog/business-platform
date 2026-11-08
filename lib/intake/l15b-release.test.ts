/**
 * Leads L1.5-b · PR-5 — release throughput and resume without one big transaction.
 * Pure suite. Run with:
 *   npx tsx lib/intake/l15b-release.test.ts
 *
 * Pins:
 *   - the sweep never starts a business past its budget, and the budget fits the route's maxDuration with margin
 *   - run order rotates with the schedule's slot, so a business left out for lack of time leads a later run
 *   - release rounds go only to businesses whose drain was full AND moved work forward; bounded per business; drain
 *     only (no store polling, no health read), round-robin across businesses
 *   - resume: the transaction only flips the status; receipts are re-armed afterwards in bounded batches, never a
 *     receipt under a live lease, best effort (the hold recheck releases whatever is left)
 * The DB halves (50,000 held resumed, lease safety, release rounds with racing sweeps, budget + rotation over many
 * businesses, pause during release) run in .m6/release-battery.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { emptyTally } from "./core/processor";
import { MAX_RELEASE_ROUNDS, rotateTenants, SWEEP_BUDGET_MS, SWEEP_ROTATION_PERIOD_MS, wantsReleaseRound } from "./intake-sweeper";
import { REARM_BATCH, REARM_BUDGET_MS } from "./intake-event.store";
import { HOLD_RECHECK_MS } from "./acquisition/gate";

let checks = 0;
function test(name: string, fn: () => void) {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
}
const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");

console.log("\nLeads L1.5-b · PR-5 — release + resume — pure suite\n");

test("budget fits the route's maxDuration with margin", () => {
  const route = read("app/api/intake/sweep/route.ts");
  const max = Number(/export const maxDuration = (\d+);/.exec(route)![1]);
  assert.ok(SWEEP_BUDGET_MS <= max * 1000 - 15_000, `${SWEEP_BUDGET_MS} vs maxDuration ${max}s`);
  assert.ok(REARM_BUDGET_MS < 10_000, "a resume answers quickly");
  assert.ok(REARM_BATCH > 0 && REARM_BATCH <= 1000);
  assert.ok(MAX_RELEASE_ROUNDS >= 1 && MAX_RELEASE_ROUNDS <= 20);
  assert.ok(SWEEP_ROTATION_PERIOD_MS === HOLD_RECHECK_MS, "one slot per scheduled run");
});

test("rotation: every business leads within n runs; order otherwise preserved", () => {
  const ids = [3, 8, 11, 42, 57];
  const leaders = new Set<number>();
  for (let slot = 0; slot < ids.length; slot++) {
    const order = rotateTenants(ids, new Date(slot * SWEEP_ROTATION_PERIOD_MS + 1234));
    assert.equal(order.length, ids.length);
    assert.deepEqual([...order].sort((a, b) => a - b), ids);
    leaders.add(order[0]);
  }
  assert.equal(leaders.size, ids.length);
  assert.deepEqual(rotateTenants([], new Date()), []);
});

test("release rounds only where the drain was full and moved work forward", () => {
  const t = (p: Partial<ReturnType<typeof emptyTally>>) => ({ ...emptyTally(), ...p });
  assert.equal(wantsReleaseRound(t({ processed: 50 }), 50), true);
  assert.equal(wantsReleaseRound(t({ processed: 10, deferred: 40 }), 50), true);
  assert.equal(wantsReleaseRound(t({ processed: 49 }), 50), false, "not full: nothing more was due");
  assert.equal(wantsReleaseRound(t({ deferred: 50 }), 50), false, "only holds: another round releases nothing");
  assert.equal(wantsReleaseRound(t({ not_claimed: 50 }), 50), false, "another worker has them");
});

const sweeper = read("lib/intake/intake-sweeper.ts");
test("the run never starts a business past its budget; release rounds are bounded drain-only", () => {
  const loop = sweeper.slice(sweeper.indexOf("for (const businessId of rotateTenants(businessIds, now))"));
  assert.match(loop, /^for \(const businessId of rotateTenants\(businessIds, now\)\) \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*if \(clock\(\) >= deadline\) \{\s*report\.budget\.businessesNotReached \+= 1;\s*continue;/);
  const release = sweeper.slice(sweeper.indexOf("let round = 0;"), sweeper.indexOf("return report;\n}"));
  assert.ok(release.includes("while (pending.length > 0 && round < MAX_RELEASE_ROUNDS && clock() + RELEASE_ROUND_MIN_MS <= deadline)"), "a round needs RELEASE_ROUND_MIN_MS of budget left");
  assert.ok(release.includes("if (clock() + RELEASE_ROUND_MIN_MS > deadline) break;"));
  assert.match(release, /drainIntake\(registry, businessId, \{ now, limit \}\)/);
  assert.doesNotMatch(release, /reconcileCommerce|syncRivhit|intakeHealthCounts|purgeExpiredFailedPayloads/);
});

test("resume: status flips in the transaction, receipts re-armed after it in bounded batches", () => {
  const svc = read("lib/intake/acquisition/connection.service.ts");
  const fn = svc.slice(svc.indexOf("export async function setPaused("), svc.indexOf("export async function setAllowedOrigins("));
  const tx = fn.slice(0, fn.indexOf("if (!changed) return null;"));
  assert.ok(!tx.includes("intakeEvent"), "no receipt inside the resume transaction");
  const store = read("lib/intake/intake-event.store.ts");
  const rearm = store.slice(store.indexOf("export async function rearmPausedReceipts("));
  assert.match(rearm, /while \(clock\(\) < stopAt\)/);
  assert.match(rearm, /if \(n < batch\) break;/);
  assert.match(rearm, /set_config\('statement_timeout'/);
  assert.match(rearm, /s\."nextAttemptAt" > \$\{utc\(now\)\}/, "only receipts waiting for a later look");
  assert.match(rearm, /s\."lastAttemptAt" IS NULL OR s\."nextAttemptAt" > s\."lastAttemptAt" \+ make_interval/, "never a live lease");
});

test("racing sweeps never deadlock or queue on the health read / purge (SKIP LOCKED, lock + statement timeouts)", () => {
  const store = read("lib/intake/intake-event.store.ts");
  const health = store.slice(store.indexOf("export async function intakeHealthCounts("), store.indexOf("export const FAILED_PAYLOAD_RETENTION_MS"));
  assert.equal(health.split("FOR UPDATE SKIP LOCKED").length - 1, 2, "both stamps skip rows the other run holds");
  assert.ok(health.includes("set_config('lock_timeout', ${String(HEALTH_LOCK_TIMEOUT_MS)}, true)"));
  assert.ok(health.includes("set_config('statement_timeout', ${String(SIBLING_STATEMENT_TIMEOUT_MS)}, true)"));
  const purge = store.slice(store.indexOf("export async function purgeExpiredFailedPayloads("), store.indexOf("export function laneReserve("));
  assert.ok(purge.includes("set_config('lock_timeout', ${String(HEALTH_LOCK_TIMEOUT_MS)}, true)"));
});

console.log(`\nALL L1.5-b RELEASE TESTS PASSED — ${checks} checks\n`);
