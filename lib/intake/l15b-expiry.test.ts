/**
 * Leads L1.5-b · PR-6 — expiry of held receipts, PREPARED and OFF.
 * Pure suite. Run with:
 *   npx tsx lib/intake/l15b-expiry.test.ts
 *
 * Pins:
 *   - OFF unless INTAKE_HELD_EXPIRY_ENABLED is exactly "true": the hold always stands
 *   - ON: a paused / not-included / inactive-business hold past 14 days from ARRIVAL is settled terminally as
 *     "expired:<reason>"; younger ones wait; the Dubiz emergency hold never expires
 *   - every adapter's two hold branches go through holdOrExpire (revoked still first)
 *   - the dead-letter retention NEVER purges an expired payload (expiry must not delete data)
 * The DB halves (15 days → expired, payload kept, never processed — not even after resume; 13 days → waits; the
 * emergency hold → waits; the 30-day retention skips expired; racing sweeps; OFF changes nothing) run in
 * .m6/expiry-battery.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { EXPIRING_HOLDS, HELD_EXPIRY_MS, HELD_EXPIRY_WARN_MS, HOLD_CODES, holdOrExpire, heldExpiryEnabled } from "./acquisition/gate";
import { IntakeTerminalError } from "./core/contract";

let checks = 0;
function test(name: string, fn: () => void) {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
}
const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
const DAY = 86_400_000;
const NOW = new Date("2026-11-20T12:00:00Z");
const ON = { INTAKE_HELD_EXPIRY_ENABLED: "true" };
const hold = (code: string) => ({ kind: "deferred" as const, until: new Date(NOW.getTime() + 600_000), code });
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const expires = (code: string, days: number, env: Record<string, string | undefined>) => {
  try { holdOrExpire(hold(code), ago(days), NOW, env); return null; }
  catch (e) { assert.ok(e instanceof IntakeTerminalError); return (e as IntakeTerminalError).code; }
};

console.log("\nLeads L1.5-b · PR-6 — held expiry (OFF) — pure suite\n");

test("constants: 14 days, warning day 12, the emergency hold does not expire", () => {
  assert.equal(HELD_EXPIRY_MS, 14 * DAY);
  assert.equal(HELD_EXPIRY_WARN_MS, 12 * DAY);
  assert.ok(EXPIRING_HOLDS.has(HOLD_CODES.connectionPaused) && EXPIRING_HOLDS.has(HOLD_CODES.sourceDisabled) && EXPIRING_HOLDS.has(HOLD_CODES.businessInactive));
  assert.ok(!EXPIRING_HOLDS.has(HOLD_CODES.emergency));
});

test("OFF (the default): the hold always stands", () => {
  assert.equal(heldExpiryEnabled({}), false);
  assert.equal(heldExpiryEnabled({ INTAKE_HELD_EXPIRY_ENABLED: "1" }), false);
  for (const code of Object.values(HOLD_CODES)) assert.equal(expires(code, 400, {}), null, code);
});

test("ON: past 14 days from arrival → expired:<reason>; younger waits; emergency never", () => {
  assert.equal(expires(HOLD_CODES.connectionPaused, 15, ON), "expired:connection_paused");
  assert.equal(expires(HOLD_CODES.sourceDisabled, 14, ON), "expired:source_disabled", "exactly 14 days");
  assert.equal(expires(HOLD_CODES.businessInactive, 30, ON), "expired:business_inactive");
  assert.equal(expires(HOLD_CODES.connectionPaused, 13.9, ON), null);
  assert.equal(expires(HOLD_CODES.emergency, 90, ON), null, "the Dubiz switch needs its own policy");
});

test("every adapter's hold branches go through holdOrExpire, revoked first", () => {
  for (const f of ["lib/intake/acquisition/adapter.ts", "lib/intake/calls/adapter.ts", "lib/intake/commerce/adapter.ts"]) {
    const src = read(f);
    assert.match(src, /return holdOrExpire\(\{ kind: "deferred", until: new Date\(ctx\.now\.getTime\(\) \+ HOLD_RECHECK_MS\), code: HOLD_CODES\.connectionPaused \}, event\.receivedAt, ctx\.now\);/, f);
    assert.match(src, /if \(hold\) return holdOrExpire\(hold, event\.receivedAt, ctx\.now\);/, f);
    assert.ok(src.indexOf('if (connectionState === "revoked")') < src.indexOf("holdOrExpire("), `${f}: revoked is still checked first`);
  }
});

test("the dead-letter retention never purges an expired payload", () => {
  const store = read("lib/intake/intake-event.store.ts");
  const purge = store.slice(store.indexOf("export async function purgeExpiredFailedPayloads("), store.indexOf("export function laneReserve("));
  assert.match(purge, /OR: \[\{ lastErrorCode: null \}, \{ NOT: \{ lastErrorCode: \{ startsWith: "expired:" \} \} \}\],/);
});

console.log(`\nALL L1.5-b EXPIRY TESTS PASSED — ${checks} checks\n`);
