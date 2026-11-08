/**
 * Leads L1.5-a — the emergency switch HOLDS, everything else that is off records nothing, and the gate is asked
 * again before every attempt. Pure suite. Run with:
 *   npx tsx lib/intake/l15a-hold-gate.test.ts
 *
 * Pins (owner decisions 2026-11-04):
 *   - the feature resolver names the three "off" states apart: EMERGENCY_DISABLED (wins even over a business
 *     ENABLED), BUSINESS_DISABLED, GLOBAL_DEFAULT — only the first is holdable
 *   - quarantine is decided before the feature (a quarantined business is never held)
 *   - the ingest path refuses everything that is not holdable, records what is
 *   - every connection adapter (lead / commerce / telephony) runs the gate again AFTER the revoked check and
 *     BEFORE any provider work, and a hold is a deferral (no attempt, nothing deleted)
 *   - hold codes are bounded and non-personal; held receipts are a visible count, never a red run by themselves
 * The DB halves (per provider, release, race, revoked-wins, quarantine) run in the .m6 / .m7bc batteries.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveFeatureAccessFromInputs } from "@/lib/services/feature-access/resolve-feature-access";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { BusinessFeatureAccessState } from "@prisma/client";
import { HOLD_CODES, HOLD_RECHECK_MS } from "./acquisition/gate";
import { sweepHealth, type IntakeSweepReport, emptyCapacity } from "./intake-sweeper";
import { emptyTally } from "./core/processor";

let checks = 0;
function test(name: string, fn: () => void) {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
}
const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
const key = PLATFORM_FEATURE_KEYS.ACQUISITION_GOOGLE_LEAD_FORMS;
const resolve = (policy: { globalEnabled: boolean; emergencyDisabled: boolean } | null, override: BusinessFeatureAccessState | null) =>
  resolveFeatureAccessFromInputs({ featureKey: key, catalogDefaultEnabled: false, policy, override: override ? { state: override } : null });

console.log("\nLeads L1.5-a — hold on the emergency switch, gate before every attempt — pure suite\n");

test("the resolver names the three off-states apart; the emergency switch wins over a business ENABLED", () => {
  assert.equal(resolve({ globalEnabled: false, emergencyDisabled: true }, BusinessFeatureAccessState.ENABLED).reasonCode, "EMERGENCY_DISABLED");
  assert.equal(resolve({ globalEnabled: false, emergencyDisabled: false }, BusinessFeatureAccessState.DISABLED).reasonCode, "BUSINESS_DISABLED");
  assert.equal(resolve({ globalEnabled: false, emergencyDisabled: false }, null).reasonCode, "GLOBAL_DEFAULT");
  assert.equal(resolve({ globalEnabled: false, emergencyDisabled: false }, BusinessFeatureAccessState.ENABLED).allowed, true);
});

test("structural: the gate decides quarantine first, and only EMERGENCY_DISABLED is holdable", () => {
  const gate = read("lib/intake/acquisition/gate.ts");
  const fn = gate.slice(gate.indexOf("export async function sourceGate("), gate.indexOf("export const HOLD_RECHECK_MS"));
  assert.ok(fn.indexOf("assertBusinessAcceptsWrites(businessId)") < fn.indexOf("if (!access.allowed)"), "quarantine before the feature");
  assert.match(fn, /reason: "business_inactive", holdable: false/);
  assert.match(fn, /holdable: access\.reasonCode === "EMERGENCY_DISABLED"/);
});

test("structural: ingest refuses (records nothing) unless the refusal is holdable", () => {
  const ingest = read("lib/intake/acquisition/ingest.ts");
  assert.match(ingest, /if \(!gate\.ok && !gate\.holdable\) \{\s*logIntake\("refused"/);
  // A holdable refusal falls through to the durable receipt write.
  assert.ok(ingest.indexOf("if (!gate.ok && !gate.holdable)") < ingest.indexOf("const accepted = await acceptIntake("));
});

test("structural: every connection adapter re-checks the gate after the revoked check and before provider work", () => {
  for (const f of ["lib/intake/acquisition/adapter.ts", "lib/intake/calls/adapter.ts", "lib/intake/commerce/adapter.ts"]) {
    const src = read(f);
    const revoked = src.indexOf('return { kind: "ignored", code: "connection_revoked" };');
    const hold = src.indexOf("const hold = await holdUnlessAllowed(ctx.businessId, input.sourceKey, ctx.now);");
    const provider = src.indexOf("return input.hydrate ? input.hydrate(ctx, event)");
    assert.ok(revoked > 0 && hold > revoked && provider > hold, `${f}: revoked → gate → provider`);
    assert.match(src, /if \(hold\) return hold;/);
  }
});

test("structural: a hold is a deferral — the processor does not count it and deletes nothing", () => {
  const gate = read("lib/intake/acquisition/gate.ts");
  assert.match(gate, /return \{ kind: "deferred", until: new Date\(now\.getTime\(\) \+ HOLD_RECHECK_MS\), code \};/);
  const processor = read("lib/intake/core/processor.ts");
  // hydrate → deferred → markDeferred (attempt not counted, payload kept); never markIgnored / purge.
  assert.match(processor, /if \(h\.kind === "deferred"\) \{\s*await markDeferred\(businessId, event, h\.until, h\.code\);/);
  const store = read("lib/intake/intake-event.store.ts");
  const from = store.indexOf("export async function markDeferred(");
  const deferred = store.slice(from, store.indexOf("\n}\n", from) + 2);
  assert.match(deferred, /attempts: \{ decrement: 1 \}/);
  assert.doesNotMatch(deferred, /payload/);
});

test("hold codes are bounded, non-personal and namespaced; the re-check is the sweep cadence", () => {
  for (const c of Object.values(HOLD_CODES)) assert.match(c, /^held:[a-z_]{1,40}$/);
  assert.equal(HOLD_RECHECK_MS, 10 * 60 * 1000);
});

test("held receipts are a visible count, not a red run by themselves", () => {
  const r: IntakeSweepReport = {
    businesses: 1, quarantinedSkipped: 0, businessErrors: 0, events: emptyTally(), payloadsPurged: 0,
    commerce: { receipts: 0, webhooksReactivated: 0, failures: 0 },
    revenueSources: { receipts: 0, unreadable: 0, failures: 0, calls: 0 },
    backlog: { deadLettersNew: 0, deadLettersOpen: 0, pendingStale: 0, pendingStaleNew: 0, held: 7, businessesNeedingAttention: 0 },
    capacity: emptyCapacity(),
    budget: { businessesNotReached: 0, releaseRounds: 0, releaseBusinesses: 0 },
  };
  assert.deepEqual(sweepHealth(r), { ok: true, job: [], events: [] });
  const store = read("lib/intake/intake-event.store.ts");
  assert.match(store, /lastErrorCode: \{ startsWith: "held:" \}/);
});

console.log(`\nALL L1.5-a HOLD-GATE TESTS PASSED — ${checks} checks\n`);
