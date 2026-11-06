/**
 * Leads L1.5-a — no silent loss on the provider edge. Pure suite. Run with:
 *   npx tsx lib/intake/l15a-silent-refusal.test.ts
 *
 * Pins:
 *   - an email hint is kept whole or dropped: never cut into a different (plausible) address, never longer
 *     than a Lead may hold (which would fail every attempt and dead-letter the lead)
 *   - CloudTalk: failing to READ the endpoint's secrets is an outage (503, redelivered), never "invalid_signature"
 *   - Wix: a signed order Dubiz cannot parse is not acknowledged (400 — Wix resends any non-200)
 * The DB halves (status per provider and state, nothing recorded) run in .m6 / .m7bc batteries.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { normalizeContactHints } from "./core/contact";
import { LEAD_EMAIL_MAX } from "@/lib/services/crm/lead-core";

let checks = 0;
function test(name: string, fn: () => void) {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
}
const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
const emailOf = (local: number) => `${"a".repeat(local)}@example.co.il`;

console.log("\nLeads L1.5-a — no silent refusal — pure suite\n");

test("a long but valid email (> 120 chars, ≤ the Lead limit) is kept whole, not cut", () => {
  const email = emailOf(150);
  assert.ok(email.length > 120 && email.length <= LEAD_EMAIL_MAX);
  const r = normalizeContactHints({ email });
  assert.equal(r.hints?.email, email);
  assert.equal(r.signals.email, "valid");
});

test("an email longer than a Lead may hold is dropped as invalid — never truncated into another address", () => {
  const email = emailOf(LEAD_EMAIL_MAX);
  assert.ok(email.length > LEAD_EMAIL_MAX && email.length <= 254);
  const r = normalizeContactHints({ email, phone: "0521234567" });
  assert.equal(r.hints?.email, undefined);
  assert.equal(r.signals.email, "invalid");
  assert.ok(r.hints?.phone, "the rest of the contact is kept");
});

test("the email limit is exactly the Lead's", () => {
  const atLimit = `${"b".repeat(LEAD_EMAIL_MAX - "@example.co.il".length)}@example.co.il`;
  assert.equal(atLimit.length, LEAD_EMAIL_MAX);
  assert.equal(normalizeContactHints({ email: atLimit }).hints?.email, atLimit);
  assert.equal(normalizeContactHints({ email: `c${atLimit}` }).signals.email, "invalid");
});

test("ordinary emails are unchanged (trimmed, lower-cased)", () => {
  assert.equal(normalizeContactHints({ email: "  Dana@Example.CO.IL " }).hints?.email, "dana@example.co.il");
  assert.equal(normalizeContactHints({ email: "not an email" }).signals.email, "invalid");
});

test("structural: CloudTalk answers 503 when the secrets cannot be read — not 401 invalid_signature", () => {
  const route = read("app/api/intake/telephony/cloudtalk/[publicId]/route.ts");
  assert.doesNotMatch(route, /readConnectionSecrets\([^)]*\)\)\.catch\(\(\) => null\)/);
  const block = route.slice(route.indexOf("let secrets;"), route.indexOf("const headers"));
  // (decision 3 added an optional { anyLiveStatus } for a PAUSED endpoint and a comment line; the 503 contract is the same.)
  assert.match(block, /try \{\s*(\/\/[^\n]*\n\s*)?secrets = await runWithTenantContext\(\{ businessId \}, \(\) => readConnectionSecrets\(businessId, connectionId(, \{ anyLiveStatus: conn\.status === "PAUSED" \})?\)\);\s*\} catch \{\s*return NextResponse\.json\(\{ error: "unavailable" \}, \{ status: 503 \}\);/);
  // A connection with no secret saved yet still fails closed (null → 401), as before.
  assert.match(route, /if \(!secrets \|\| !verifySvix\(/);
});

test("structural: Wix does not acknowledge a signed order it cannot parse", () => {
  const route = read("app/api/intake/commerce/wix/route.ts");
  const block = route.slice(route.indexOf("if (!parsed.ok)"), route.indexOf('if (!("receipt" in parsed))'));
  assert.match(block, /status: 400/);
  assert.doesNotMatch(block, /status: 200/);
});

console.log(`\nALL L1.5-a SILENT-REFUSAL TESTS PASSED — ${checks} checks\n`);
