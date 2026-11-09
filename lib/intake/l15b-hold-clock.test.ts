/**
 * Leads L1.5-b · A2 — the hold clock (PREPARED, OFF). Pure suite. Run with:
 *   npx tsx lib/intake/l15b-hold-clock.test.ts
 *
 * Pins (owner decisions 2026-11-09):
 *   - OFF unless INTAKE_HOLD_CLOCK_ENABLED is exactly "true"; OFF = the processor's existing hold path, byte for byte
 *   - 14 days of COUNTED hold time, cumulative; a change of reason never resets it; the clock never backdates
 *   - the Dubiz emergency hold is never counted and never expires; ≥ 48 h grace after it ends
 *   - no expiry before the warning (day 12) was written ≥ 48 h earlier
 *   - an expiry is A1's "expired:<reason>" through the processor's terminal path; nothing deletes a payload
 *   - one SQL definition of the look for the probe and its siblings; RLS-bound (tenant transactions)
 * The clock arithmetic itself (accumulation, reason changes, emergency + grace, warning lead, racing sweeps, RLS,
 * load) runs on PostgreSQL in .m6/hold-clock-battery.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  COUNTING_HOLDS,
  expiredCodeFor,
  HOLD_CLOCK_EMERGENCY,
  HOLD_CLOCK_MAX_GAP_MS,
  HOLD_EXPIRY_MS,
  HOLD_GRACE_MS,
  HOLD_WARN_LEAD_MS,
  HOLD_WARN_MS,
  holdClockApplies,
  holdClockEnabled,
  keepHoldClock,
} from "./core/hold-clock";
import { HOLD_CODES, HOLD_RECHECK_MS } from "./acquisition/gate";
import { isExpiredCode } from "./core/expired";

let checks = 0;
function test(name: string, fn: () => void) {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
}
const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

console.log("\nLeads L1.5-b · A2 — the hold clock — pure suite\n");

test("the owner's numbers", () => {
  assert.equal(HOLD_EXPIRY_MS, 14 * DAY);
  assert.equal(HOLD_WARN_MS, 12 * DAY);
  assert.ok(HOLD_WARN_LEAD_MS >= 48 * HOUR, "warning ≥ 48 h before expiry");
  assert.ok(HOLD_GRACE_MS >= 48 * HOUR, "grace ≥ 48 h after an emergency");
  assert.ok(HOLD_EXPIRY_MS - HOLD_WARN_MS >= HOLD_WARN_LEAD_MS, "counted time cannot outrun the warning lead");
  assert.equal(HOLD_CLOCK_MAX_GAP_MS, 6 * HOUR, "a look counts at most 6 h (owner decision 2026-11-09)");
  assert.ok(HOLD_CLOCK_MAX_GAP_MS > HOLD_RECHECK_MS);
});

test("OFF unless exactly \"true\"; ON only for holds", () => {
  for (const v of [undefined, "", "1", "TRUE", "yes", "true "]) assert.equal(holdClockEnabled({ INTAKE_HOLD_CLOCK_ENABLED: v }), false, String(v));
  assert.equal(holdClockEnabled({ INTAKE_HOLD_CLOCK_ENABLED: "true" }), true);
  assert.equal(holdClockEnabled({}), false);
  const on = { INTAKE_HOLD_CLOCK_ENABLED: "true" };
  for (const c of Object.values(HOLD_CODES)) assert.equal(holdClockApplies(c, on), true, c);
  for (const c of ["rate_limited", "provider:retry", "connection_revoked"]) assert.equal(holdClockApplies(c, on), false, c);
  for (const c of Object.values(HOLD_CODES)) assert.equal(holdClockApplies(c, {}), false, c);
});

test("what counts: paused / withdrawn / erased — never the emergency switch", () => {
  assert.deepEqual([...COUNTING_HOLDS].sort(), [HOLD_CODES.businessInactive, HOLD_CODES.connectionPaused, HOLD_CODES.sourceDisabled].sort());
  assert.equal(HOLD_CLOCK_EMERGENCY, HOLD_CODES.emergency);
  assert.ok(!COUNTING_HOLDS.includes(HOLD_CODES.emergency));
  for (const c of COUNTING_HOLDS) {
    assert.equal(expiredCodeFor(c), "expired:" + c.slice(5));
    assert.ok(isExpiredCode(expiredCodeFor(c)), "A1 classifies it as expired");
  }
});

test("a running clock survives a hydrated receipt's new metadata; nothing else changes", () => {
  const clock = { v: 1, ms: 5 * DAY, at: "2026-11-09T10:00:00.000Z", code: "held:connection_paused", grace: null, warnedAt: null };
  assert.deepEqual(keepHoldClock({ isTest: false, holdClock: clock }, { v: 1, hydrated: true }), { v: 1, hydrated: true, holdClock: clock });
  assert.deepEqual(keepHoldClock({ isTest: false }, { v: 1 }), { v: 1 }, "no clock → the new metadata, untouched");
  assert.deepEqual(keepHoldClock(null, { v: 1 }), { v: 1 });
  assert.equal(keepHoldClock({ holdClock: clock }, undefined), undefined, "no new metadata → nothing written");
});

const processor = read("lib/intake/core/processor.ts");
const store = read("lib/intake/intake-event.store.ts");
const clockSrc = read("lib/intake/core/hold-clock.ts");

test("structural: OFF keeps the existing hold path exactly; ON settles an expiry through A1's terminal path", () => {
  const on = processor.indexOf('if (h.kind === "deferred" && holdClockApplies(h.code)) {');
  const off = processor.indexOf('if (h.kind === "deferred") {\n        await markDeferred(businessId, event, h.until, h.code);');
  assert.ok(on > 0 && off > on, "the clock branch is a separate branch before the unchanged one");
  const branch = processor.slice(on, off);
  assert.match(branch, /const look = await markDeferredWithClock\(businessId, event, h\.until, h\.code, now\);\s*if \(look\.expire\) throw new IntakeTerminalError\(expiredCodeFor\(h\.code\)\);/);
  assert.doesNotMatch(branch, /markDeadLetter\(|replacePayload\(|\.payload\b|DbNull/, "the branch neither settles nor touches a payload itself");
  // The terminal path (A1) settles an expired code as "expired", never "failed".
  assert.match(processor, /if \(isExpiredCode\(error\.code\)\) \{\s*logIntake\("expired"/);
});

test("structural: one SQL look for the probe and the siblings; tenant transactions; siblings due to expire are left for their own look", () => {
  for (const fn of ["export async function markDeferredWithClock(", "export async function deferHeldSiblingsWithClock("]) {
    const from = store.indexOf(fn);
    const body = store.slice(from, store.indexOf("\n}\n", from));
    assert.ok(from > 0, fn);
    assert.match(body, /withTenantTransaction\(/, `${fn} runs under the business's RLS`);
    assert.match(body, /calc AS MATERIALIZED \(\$\{holdClockCalcSql\(code, now\)\}\)/, `${fn} uses the one definition, computed once per receipt`);
    assert.match(body, /"metadata" = \$\{withClockSql\(/, `${fn} merges the clock into the metadata`);
    assert.doesNotMatch(body, /"payload"|payloadPurgedAt/, `${fn} never touches a payload`);
  }
  const sib = store.slice(store.indexOf("export async function deferHeldSiblingsWithClock("));
  assert.match(sib.slice(0, sib.indexOf("\n}\n")), /waits AS MATERIALIZED \(SELECT "id", clock, warned FROM calc WHERE NOT expire\)/, "expiring siblings are left for their own look");
  assert.match(sib.slice(0, sib.indexOf("\n}\n")), /FOR UPDATE SKIP LOCKED/);
  assert.match(sib.slice(0, sib.indexOf("\n}\n")), /LIMIT \$\{SIBLING_BATCH\}::int/);
});

test("structural: the clock merges (never replaces) metadata; counted time only grows; expiry needs the warning lead", () => {
  assert.match(clockSrc, /COALESCE\(\$\{metadataCol\}, '\{\}'::jsonb\) \|\| jsonb_build_object\('holdClock'/);
  assert.match(clockSrc, /SELECT a\.ms0 \+ b\.add AS ms1/);
  assert.match(clockSrc, /THEN GREATEST\(0, floor\(/, "a look never subtracts");
  assert.match(clockSrc, /a\.warned0 IS NOT NULL AND a\.warned0 <= \$\{n\} - make_interval\(secs => \$\{HOLD_WARN_LEAD_MS \/ 1000\}::int\)/);
  assert.doesNotMatch(clockSrc, /receivedAt/, "never backdated from arrival");
  assert.doesNotMatch(clockSrc, /Prisma\.DbNull|"payload"/, "the clock never writes a payload");
});

console.log(`\nALL L1.5-b HOLD-CLOCK TESTS PASSED — ${checks} checks\n`);
