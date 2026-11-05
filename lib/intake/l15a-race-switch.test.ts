/**
 * Leads L1.5-a — race protection (FG lock + in-transaction gate) and the emergency switch tool. Pure suite. Run with:
 *   npx tsx lib/intake/l15a-race-switch.test.ts
 *
 * Pins:
 *   - one lock key on both sides: the namespace and the seven features here are exactly the migration's
 *   - every intake write (lead / commerce order / call) takes the FG lock + re-reads the gate as the FIRST statement of
 *     its transaction, and a held gate or a busy lock becomes a deferral (no attempt spent), never a failure
 *   - the per-business override takes the FG lock exclusively first; the switch is only the DB function
 *   - the route: identity → FRESH step-up → mutation kill-switch → validation + typed confirmation → attempt audit →
 *     function → failure audit; the control-plane module never imports the tenant client
 * The DB halves (the switch waits / times out; no write commits after the switch returned) run in .pfe and .m6.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FEATURE_GATE_LOCK_NAMESPACE, INTAKE_SOURCE_FEATURES, isGateLockTimeout, isIntakeSourceFeature } from "./acquisition/gate-lock";
import { GATE_BUSY_CODE, HOLD_CODES, SOURCE_FEATURE, SourceGateHeldError, gatedDestination } from "./acquisition/gate";
import { classifyEmergencyError, validateEmergencyInput } from "@/lib/services/control-plane/feature-emergency.service";

let checks = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  checks++;
  console.log(`  ok  ${name}`);
}
const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
const NOW = new Date("2026-11-05T10:00:00Z");

async function main() {
  console.log("\nLeads L1.5-a — race protection + emergency switch — pure suite\n");

  await test("one key on both sides: namespace 17991 ('FG') and the seven features match the migration's function", () => {
    assert.equal(FEATURE_GATE_LOCK_NAMESPACE, 0x4647);
    const mig = read("prisma/migrations/20261113090000_platform_feature_emergency_switch/migration.sql");
    assert.match(mig, /pg_advisory_xact_lock\(17991, hashtext\(p_feature_key\)\)/);
    for (const k of INTAKE_SOURCE_FEATURES) assert.ok(mig.includes(`'${k}'`), k);
    assert.equal(INTAKE_SOURCE_FEATURES.length, 7);
    // …and they are exactly the connection sources' features.
    assert.deepEqual([...new Set(Object.entries(SOURCE_FEATURE).filter(([s]) => s !== "pos.rivhit").map(([, f]) => f))].sort(), [...INTAKE_SOURCE_FEATURES].sort());
    assert.equal(isIntakeSourceFeature("knowledge_derivation"), false);
  });

  await test("every intake write takes the FG lock + re-reads the gate as the FIRST statement of its transaction", () => {
    for (const [f, name] of [["lib/intake/routing/lead-destination.ts", "routeToLead"], ["lib/intake/routing/commerce-destination.ts", "routeToCommerce"], ["lib/intake/routing/call-destination.ts", "routeToCall"]] as const) {
      const src = read(f);
      assert.match(src, /const out = await withTenantTransaction\(async \(tx\) => \{\n\s*\/\/[^\n]*\n\s*if \(isConnectionSourceKey\(event\.sourceKey\)\) await enterSourceGateInTx\(tx, businessId, event\.sourceKey\);/, f);
      assert.match(src, new RegExp(`export const ${name} = gatedDestination\\(${name}Ungated, \\(ctx\\) => ctx\\.now\\);`), f);
    }
    const gate = read("lib/intake/acquisition/gate.ts");
    const fn = gate.slice(gate.indexOf("export async function enterSourceGateInTx("), gate.indexOf("export const GATE_BUSY_CODE"));
    assert.ok(fn.indexOf("takeSharedGateLock(tx, featureKey)") < fn.indexOf("readBusinessLifecycle(") && fn.indexOf("readBusinessLifecycle(") < fn.indexOf("resolveBusinessCapabilitiesWith("));
  });

  await test("a held gate and a busy FG lock become deferrals (no attempt spent); any other error stays an error", async () => {
    const held = gatedDestination(async (_c: { now: Date }) => { throw new SourceGateHeldError(HOLD_CODES.emergency); }, (c) => c.now);
    assert.deepEqual(await held({ now: NOW }), { kind: "deferred", until: new Date(NOW.getTime() + 10 * 60_000), code: "held:emergency_disabled" });
    const busy = gatedDestination(async (_c: { now: Date }) => { throw Object.assign(new Error("x"), { meta: { code: "55P03" } }); }, (c) => c.now);
    assert.equal((await busy({ now: NOW })).kind === "deferred" && (await busy({ now: NOW })) && GATE_BUSY_CODE, "held:gate_busy");
    const other = gatedDestination(async (_c: { now: Date }) => { throw new Error("boom"); }, (c) => c.now);
    await assert.rejects(() => other({ now: NOW }), /boom/);
    assert.equal(isGateLockTimeout({ message: "canceling statement due to lock timeout" }), true);
    assert.equal(isGateLockTimeout(new Error("deadlock detected")), false);
  });

  await test("the per-business override takes the FG lock exclusively, first, for intake features", () => {
    const svc = read("lib/services/platform-admin/update-business-feature-access.service.ts");
    const tx = svc.slice(svc.indexOf("return withControlPlaneTransaction(input.businessId, async (tx) => {"));
    assert.match(tx, /^return withControlPlaneTransaction\(input\.businessId, async \(tx\) => \{\n(\s*\/\/[^\n]*\n)+\s*if \(isIntakeSourceFeature\(featureKey\)\) await takeExclusiveGateLock\(tx, featureKey\);/);
  });

  await test("the switch input: only the seven features, a boolean, a 10–500 character reason", () => {
    assert.deepEqual(validateEmergencyInput({ featureKey: "acquisition_google_lead_forms", on: true, reason: "  provider outage today  " }),
      { featureKey: "acquisition_google_lead_forms", on: true, reason: "provider outage today" });
    assert.throws(() => validateEmergencyInput({ featureKey: "knowledge_derivation", on: true, reason: "provider outage today" }));
    assert.throws(() => validateEmergencyInput({ featureKey: "acquisition_web_forms", on: "yes", reason: "provider outage today" }));
    assert.throws(() => validateEmergencyInput({ featureKey: "acquisition_web_forms", on: true, reason: "short" }));
    assert.throws(() => validateEmergencyInput({ featureKey: "acquisition_web_forms", on: true, reason: "x".repeat(501) }));
  });

  await test("database answers map to refused / busy / unavailable — never echoing the input", () => {
    assert.equal(classifyEmergencyError({ meta: { code: "22023" } }), "refused");
    assert.equal(classifyEmergencyError({ meta: { code: "55P03" } }), "busy");
    assert.equal(classifyEmergencyError({ message: "function public.platform_set_feature_emergency(...) does not exist 42883" }), "unavailable");
    assert.equal(classifyEmergencyError({ meta: { code: "42501" } }), "unavailable");
    assert.equal(classifyEmergencyError(new Error("other")), "error");
  });

  await test("structural: the route order, the typed confirmation, the attempt / failure audit", () => {
    const r = read("app/api/platform-admin/intake-emergency/route.ts");
    const post = r.slice(r.indexOf("export async function POST("));
    const at = (s: string) => { const i = post.indexOf(s); assert.ok(i > 0, s); return i; };
    const order = [
      at("requirePlatformAdminOrResponse(req)"), at("freshStepUpRefusal(req, auth.id)"), at("isFeatureAccessMutationsEnabled()"),
      at("validateEmergencyInput("), at("body?.confirm !== input.featureKey"), at('outcome: "attempted"'), at("setFeatureEmergency("), at('outcome: "failed"'),
    ];
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
  });

  await test("structural: the control-plane module calls only the function and never imports the tenant client", () => {
    const svc = read("lib/services/control-plane/feature-emergency.service.ts");
    assert.doesNotMatch(svc, /from "@\/lib\/prisma"/);
    assert.match(svc, /SELECT \* FROM public\.platform_set_feature_emergency\(/);
    assert.doesNotMatch(svc, /platformFeaturePolicy\.(update|upsert|create)/);
  });

  console.log(`\nALL L1.5-a RACE + SWITCH TESTS PASSED — ${checks} checks\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
