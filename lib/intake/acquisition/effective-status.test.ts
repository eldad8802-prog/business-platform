/**
 * Leads L1 · B2 — the effective connection status (computed, never stored). Pure suite. Run with:
 *   npx tsx lib/intake/acquisition/effective-status.test.ts
 *
 * Pins:
 *   - a platform flag OFF shows a live connection (ACTIVE / ERROR / PAUSED) as PLATFORM_DISABLED; REVOKED stays REVOKED
 *   - with the flag ON the stored status is shown as is
 *   - the server computes it on the owner GET; nothing writes it (no status change because of a flag)
 *   - both panels show it, explain it per kind (leads / calls lost meanwhile, store orders recovered), and stop
 *     calling an already-connected source "coming soon"; no control can turn a platform flag on
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { effectiveConnectionStatus } from "./owner-api";

let checks = 0;
function test(name: string, fn: () => void) {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
}
const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");

console.log("\nLeads L1 · B2 effective connection status — pure suite\n");

test("flag OFF: ACTIVE, ERROR and PAUSED all read PLATFORM_DISABLED; REVOKED stays REVOKED", () => {
  for (const s of ["ACTIVE", "ERROR", "PAUSED"]) assert.equal(effectiveConnectionStatus(s, false), "PLATFORM_DISABLED", s);
  assert.equal(effectiveConnectionStatus("REVOKED", false), "REVOKED");
});

test("flag ON: the stored status, unchanged", () => {
  for (const s of ["ACTIVE", "ERROR", "PAUSED", "REVOKED"]) assert.equal(effectiveConnectionStatus(s, true), s);
});

test("computed on the owner GET from the business's flags; never written", () => {
  const route = read("app/api/integrations/acquisition/route.ts");
  assert.match(route, /effectiveStatus: effectiveConnectionStatus\(c\.status, !!sources\[c\.sourceKey as keyof typeof sources\]\)/);
  const writers = [read("lib/intake/acquisition/connection.service.ts"), read("lib/intake/acquisition/owner-api.ts")].join("\n");
  assert.doesNotMatch(writers, /status: "PLATFORM_DISABLED"/, "PLATFORM_DISABLED is never stored");
  assert.doesNotMatch(read("prisma/schema.prisma"), /PLATFORM_DISABLED/, "not a stored enum value");
});

test("both panels show it, explain it by kind, and no longer call a connected source 'coming soon'", () => {
  const leads = read("components/settings/LeadSourcesPanel.tsx");
  const stores = read("components/settings/StoresAndCallsPanel.tsx");
  for (const p of [leads, stores]) {
    assert.match(p, /PLATFORM_DISABLED: \{ label: "account\.settings\.connections\.common\.platformDisabled"/);
    assert.match(p, /STATUS\[c\.effectiveStatus \?\? c\.status\]/);
    assert.match(p, /!enabled && live\.length/);
    assert.doesNotMatch(p, /featureAccess|feature-access|platform-admin/i, "no control to turn a platform flag on");
  }
  assert.match(leads, /platformDisabledLeadsNote/);
  assert.match(stores, /platformDisabledStoresNote/);
  assert.match(stores, /platformDisabledCallsNote/);
  const he = read("lib/i18n/messages/areas/account.ts");
  assert.match(he, /platformDisabled: "מושבת על ידי הפלטפורמה"/);
});

console.log(`\nALL L1 EFFECTIVE-STATUS TESTS PASSED — ${checks} checks\n`);
