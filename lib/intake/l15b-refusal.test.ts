/**
 * Leads L1.5-b · B1 — why a source is refused, told apart: emergency / plan_excluded / blocked / not_entitled.
 * Classification only: nothing is recorded for a refusal, the HTTP answers are unchanged.
 * Pure suite. Run with:
 *   npx tsx lib/intake/l15b-refusal.test.ts
 *
 * Pins:
 *   - only the exact structured marker "plan:excluded" (optionally followed by a space and a note) is plan_excluded;
 *     every other DISABLED override (free text, empty, look-alikes) is "blocked"; no grant at all is "not_entitled"
 *   - the gate reads the override reason only on the refusal path, under the business's own RLS, fail-closed
 *   - ingest still refuses every non-emergency refusal and records nothing; only the log names the refusal
 *   - no hold code, processor behaviour or route answer depends on the classification yet (B2 is a later, off PR)
 * The DB halves (seven sources × every state, real overrides / policy / lifecycle, two routes end to end, RLS) run in
 * .m6/refusal-battery.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { classifySourceRefusal, isPlanExcludedReason, PLAN_EXCLUDED_REASON } from "./acquisition/refusal";

let checks = 0;
function test(name: string, fn: () => void) {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
}
const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");

console.log("\nLeads L1.5-b · B1 — source refusal classification — pure suite\n");

test("the plan marker: exact, case-sensitive, an optional note after a space", () => {
  assert.equal(PLAN_EXCLUDED_REASON, "plan:excluded");
  for (const r of ["plan:excluded", "plan:excluded downgraded to Basic 2026-11"]) assert.equal(isPlanExcludedReason(r), true, r);
  for (const r of [null, undefined, "", " plan:excluded", "Plan:excluded", "PLAN:EXCLUDED", "plan:excluded-x", "plan:excludedx", "plan: excluded", "block:abuse", "the source left the plan", "plan"]) {
    assert.equal(isPlanExcludedReason(r), false, String(r));
  }
});

test("classification matrix", () => {
  assert.equal(classifySourceRefusal("EMERGENCY_DISABLED", null), "emergency");
  assert.equal(classifySourceRefusal("EMERGENCY_DISABLED", "plan:excluded"), "emergency", "the emergency switch wins");
  assert.equal(classifySourceRefusal("BUSINESS_DISABLED", "plan:excluded"), "plan_excluded");
  assert.equal(classifySourceRefusal("BUSINESS_DISABLED", "block:abuse"), "blocked");
  assert.equal(classifySourceRefusal("BUSINESS_DISABLED", "closed the website pilot"), "blocked");
  assert.equal(classifySourceRefusal("BUSINESS_DISABLED", null), "blocked", "unreadable / empty → blocked, never plan_excluded");
  assert.equal(classifySourceRefusal("GLOBAL_DEFAULT", null), "not_entitled");
  assert.equal(classifySourceRefusal("GLOBAL_DEFAULT", "plan:excluded"), "not_entitled", "no DISABLED override → the marker is not consulted");
  assert.equal(classifySourceRefusal("CATALOG_DEFAULT", null), "not_entitled");
});

const gate = read("lib/intake/acquisition/gate.ts");

test("the gate: classifies only when refused, reads the reason only for a DISABLED override, fail-closed", () => {
  const sg = gate.slice(gate.indexOf("export async function sourceGate("), gate.indexOf("async function readOverrideReason("));
  assert.match(sg, /if \(!access\.allowed\) \{\s*const overrideReason = access\.reasonCode === "BUSINESS_DISABLED" \? await readOverrideReason\(businessId, SOURCE_FEATURE\[sourceKey\]\) : null;/);
  assert.match(sg, /holdable: access\.reasonCode === "EMERGENCY_DISABLED", refusal: classifySourceRefusal\(access\.reasonCode, overrideReason\)/, "holdable is unchanged");
  assert.ok(sg.indexOf("assertBusinessAcceptsWrites") < sg.indexOf("if (!access.allowed)"), "a business being erased is refused first");
  const rr = gate.slice(gate.indexOf("async function readOverrideReason("), gate.indexOf("export const HOLD_RECHECK_MS"));
  assert.match(rr, /runWithTenantContext\(\{ businessId \}, \(\) =>\s*withTenantTransaction\(/, "its own row, under its RLS");
  assert.match(rr, /select: \{ reason: true \}/);
  assert.match(rr, /\} catch \{\s*return null;\s*\}/, "unreadable → null → blocked");
});

test("no behaviour change: ingest still refuses (nothing recorded); holds, processor and routes ignore the classification", () => {
  const ingest = read("lib/intake/acquisition/ingest.ts");
  assert.match(ingest, /if \(!gate\.ok && !gate\.holdable\) \{[\s\S]*?return \{ status: "refused", reason: gate\.reason \};\s*\}/);
  assert.match(ingest, /const code = gate\.reason === "source_disabled" \? `\$\{gate\.reason\}:\$\{gate\.refusal\}` : gate\.reason;/);
  const hold = gate.slice(gate.indexOf("export async function holdUnlessAllowed("));
  assert.doesNotMatch(hold.slice(0, hold.indexOf("\n}\n")), /refusal/, "the hold codes do not read it");
  assert.doesNotMatch(gate, /held:plan_excluded/, "no new hold code in B1");
  for (const f of ["lib/intake/core/processor.ts", "lib/intake/acquisition/receive.ts", "app/api/intake/acquisition/web/[publicId]/route.ts", "app/api/intake/acquisition/google/[publicId]/route.ts", "app/api/intake/acquisition/meta/route.ts", "app/api/intake/commerce/wix/route.ts"]) {
    assert.doesNotMatch(read(f), /refusal|plan_excluded/, f);
  }
});

console.log(`\nALL L1.5-b REFUSAL-CLASSIFICATION TESTS PASSED — ${checks} checks\n`);
