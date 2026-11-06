/**
 * Leads L1.5-a · decision 3 — a PAUSED connection holds verified deliveries (PR-2 of migration 20261110100000).
 * Pure suite. Run with:
 *   npx tsx lib/intake/l15a-paused-hold.test.ts
 *
 * Pins:
 *   - every route and adapter of the seven intake sources resolves through the v2 lookups (which answer for PAUSED and
 *     say so); only Rivhit (its own track) keeps v1 — and v1 itself is untouched
 *   - the status the lookup found reaches the ingest path, and PAUSED records + holds (never refused, never processed)
 *   - signed endpoints still VERIFY when paused (their secrets are read for PAUSED too)
 *   - before every attempt: revoked → IGNORED, then paused → held (no attempt), then the source gate, then provider work
 *   - resuming re-arms that connection's paused receipts in the same transaction
 * The DB halves (per source, release once, revoked, emergency, entitlement, concurrency, interrupted release,
 * quarantine, isolation) run in the .m6 / .m7a / .m7bc batteries on a lab with the migration applied.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { HOLD_CODES } from "./acquisition/gate";

let checks = 0;
function test(name: string, fn: () => void) {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
}
const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");

console.log("\nLeads L1.5-a · decision 3 — PAUSED holds — pure suite\n");

const ROUTES = [
  "app/api/intake/acquisition/web/[publicId]/route.ts",
  "app/api/intake/acquisition/google/[publicId]/route.ts",
  "app/api/intake/acquisition/meta/route.ts",
  "app/api/intake/commerce/wix/route.ts",
  "app/api/intake/commerce/woocommerce/[publicId]/route.ts",
  "app/api/intake/telephony/cloudtalk/[publicId]/route.ts",
  "lib/intake/acquisition/receive.ts",
];
const ADAPTER_RESOLVERS = [
  "lib/intake/acquisition/providers/google-lead-form.ts",
  "lib/intake/acquisition/providers/meta-lead-ads.ts",
  "lib/intake/acquisition/providers/web-form.ts",
  "lib/intake/calls/providers.ts",
  "lib/intake/commerce/providers.ts",
];
const V1 = /\bresolve(Keyed|Public|Resource)Connection\(/;

test("the seven sources' routes and adapters use only the v2 lookups; Rivhit keeps v1", () => {
  for (const f of [...ROUTES, ...ADAPTER_RESOLVERS]) {
    const src = read(f);
    assert.doesNotMatch(src, V1, `${f} still calls a v1 resolver`);
    assert.match(src, /resolve(Keyed|Public|Resource)ConnectionV2\(/, f);
  }
  assert.match(read("lib/revenue-sources/rivhit/adapter.ts"), V1);
  const resolve = read("lib/intake/acquisition/resolve.ts");
  for (const fn of ["m6_acquisition_resolve_keyed_v2", "m6_acquisition_resolve_public_v2", "m6_acquisition_resolve_resource_v2"]) assert.ok(resolve.includes(fn), fn);
  // v1 is still there, unchanged, for Rivhit.
  for (const fn of ["m6_acquisition_resolve_keyed(", "m6_acquisition_resolve_public(", "m6_acquisition_resolve_resource("]) assert.ok(resolve.includes(fn), fn);
});

test("the status reaches the ingest path from every route; PAUSED records and holds", () => {
  for (const f of ROUTES.filter((r) => !r.includes("woocommerce"))) {
    assert.match(read(f), /connectionStatus: conn\.status/, f);
  }
  const ingest = read("lib/intake/acquisition/ingest.ts");
  assert.ok(ingest.includes('const paused = input.connectionStatus === "PAUSED";'));
  assert.ok(ingest.includes("const held = !gate.ok || paused;"));
  // A non-holdable refusal (entitlement withdrawn, quarantine) still records nothing — checked BEFORE the pause.
  assert.ok(ingest.indexOf("if (!gate.ok && !gate.holdable)") < ingest.indexOf("const paused = "));
});

test("signed endpoints still verify when paused (secrets read for PAUSED too)", () => {
  assert.ok(read("lib/intake/acquisition/receive.ts").includes('readConnectionSecrets(conn.businessId, conn.connectionId, { anyLiveStatus: conn.status === "PAUSED" })'));
  assert.ok(read("app/api/intake/telephony/cloudtalk/[publicId]/route.ts").includes('readConnectionSecrets(businessId, connectionId, { anyLiveStatus: conn.status === "PAUSED" })'));
});

test("before every attempt: revoked → paused → the source gate → provider work, in all three adapters", () => {
  for (const f of ["lib/intake/acquisition/adapter.ts", "lib/intake/calls/adapter.ts", "lib/intake/commerce/adapter.ts"]) {
    const src = read(f);
    const i = (s: string) => { const at = src.indexOf(s); assert.ok(at > 0, `${f}: ${s}`); return at; };
    const order = [
      i('if (connectionState === "revoked")'),
      i('if (connectionState === "paused")'),
      i("const hold = await holdUnlessAllowed("),
      i("return input.hydrate ? input.hydrate(ctx, event)"),
    ];
    assert.deepEqual(order, [...order].sort((a, b) => a - b), f);
    assert.ok(src.includes("code: HOLD_CODES.connectionPaused"), f);
  }
  assert.equal(HOLD_CODES.connectionPaused, "held:connection_paused");
  const svc = read("lib/intake/acquisition/connection.service.ts");
  assert.ok(svc.includes('return rows.every((r) => r.status === "PAUSED") ? "paused" : "live";'));
});

test("resuming re-arms that connection's paused receipts in the same transaction (and only those)", () => {
  const svc = read("lib/intake/acquisition/connection.service.ts");
  const fn = svc.slice(svc.indexOf("export async function setPaused("), svc.indexOf("export async function setAllowedOrigins("));
  for (const pin of ["if (!paused) {", 'lastErrorCode: "held:connection_paused"', "providerAccountRef: ref", "payloadPurgedAt: null", "data: { nextAttemptAt: now }"]) {
    assert.ok(fn.includes(pin), pin);
  }
  assert.ok(fn.indexOf("tx.acquisitionConnection.update(") < fn.indexOf("tx.intakeEvent.updateMany("), "the status changes first, in the same transaction");
});

console.log(`\nALL L1.5-a PAUSED-HOLD TESTS PASSED — ${checks} checks\n`);
