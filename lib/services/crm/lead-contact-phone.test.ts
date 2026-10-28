/**
 * Leads L1 · G-01b — the claimed phone (Lead.claimedPhone): reachable, never identity. Pure suite. Run with:
 *   npx tsx lib/services/crm/lead-contact-phone.test.ts
 *
 * Pins:
 *   - the contact-phone contract: the number to reach a lead on and WHERE it comes from — "lead_phone" (Lead.phone,
 *     not re-verified) or "claimed_in_enquiry" (Lead.claimedPhone); no verification flag exists to be wrong
 *   - no identity, routing-match or customer path reads claimedPhone (it can never become evidence of who someone is)
 *   - the owner API cannot write it; only the intake lead destination does, for a self-asserted event
 *   - it is erased with the account (manifest + store + disposition) and exported in its own, non-importable column
 *   - the card / row show it labelled as given-in-the-enquiry, not verified
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { leadContactPhone } from "./lead-core";

let checks = 0;
function test(name: string, fn: () => void) {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
}
const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

console.log("\nLeads L1 · G-01b claimed phone — pure suite\n");

test("contact phone: Lead.phone first (source lead_phone), else the claimed one (claimed_in_enquiry), else none", () => {
  assert.deepEqual(leadContactPhone({ phone: "972501111111", claimedPhone: null }), { value: "972501111111", source: "lead_phone" });
  assert.deepEqual(leadContactPhone({ phone: null, claimedPhone: "972502222222" }), { value: "972502222222", source: "claimed_in_enquiry" });
  assert.deepEqual(leadContactPhone({ phone: "972501111111", claimedPhone: "972502222222" }), { value: "972501111111", source: "lead_phone" });
  assert.equal(leadContactPhone({ phone: null, claimedPhone: null }), null);
  assert.equal(leadContactPhone({ phone: null }), null);
});

test("the contract carries a SOURCE, never a verification claim", () => {
  const core = code("lib/services/crm/lead-core.ts");
  const fn = core.slice(core.indexOf("export type LeadContactPhoneSource"), core.indexOf("export function leadNeedsAttention"));
  assert.doesNotMatch(fn, /verified/i);
  for (const f of ["app/api/leads/route.ts", "lib/services/crm/lead-card.read-model.ts", "lib/api/leads.ts"]) {
    assert.doesNotMatch(code(f), /contactPhoneVerified|phoneVerified/, f);
    assert.match(code(f), /contactPhone/, f);
  }
});

test("no identity / routing-match / customer path reads claimedPhone", () => {
  const dirs = ["lib/intake/identity", "lib/intake/calls", "lib/intake/whatsapp"];
  for (const d of dirs) for (const f of readdirSync(path.join(process.cwd(), d)).filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts"))) {
    assert.doesNotMatch(code(`${d}/${f}`), /claimedPhone/, `${d}/${f}`);
  }
  for (const f of ["lib/intake/routing/call-destination.ts", "lib/intake/routing/commerce-destination.ts", "lib/services/crm/customer.service.ts",
    "lib/services/crm/lead-auto-capture.service.ts", "lib/services/conversation/inbound-customer-message.service.ts"]) {
    assert.doesNotMatch(code(f), /claimedPhone/, f);
  }
  const dest = code("lib/intake/routing/lead-destination.ts");
  assert.equal((dest.match(/claimedPhone/g) ?? []).length, 1, "the lead destination only WRITES it, once");
  const svc = code("lib/services/crm/lead.service.ts");
  assert.doesNotMatch(svc.slice(svc.indexOf("async function findOpenLeadByPhone"), svc.indexOf("async function findOpenLeadByPhone") + 600), /claimedPhone/,
    "one-open-lead-per-phone never looks at a claim");
});

test("the owner API cannot write it (POST /api/leads builds its input field by field)", () => {
  const route = code("app/api/leads/route.ts");
  const post = route.slice(route.indexOf("export async function POST"));
  assert.doesNotMatch(post, /claimedPhone/);
  assert.doesNotMatch(post, /\.\.\.body\b/);
});

test("erased with the account: manifest, store and disposition all name it", () => {
  assert.match(read("lib/services/account/account-erasure-manifest.ts"), /claimedPhone: "null"/);
  assert.match(read("lib/services/account/account-deletion.prisma-store.ts"), /claimedPhone: null,/);
  assert.match(read("lib/services/account/erasure-dispositions.ts"), /claimedPhone: \{ disposition: "ERASE" \}/);
});

test("exported in its own column, never importable", () => {
  const exp = read("lib/data-transfer/export/domains/leads.export.ts");
  assert.match(exp, /header: "טלפון שנמסר בפנייה \(לא אומת\)", type: "text", width: 22, exportable: true, importable: false/);
  assert.match(exp, /text\(formatPhoneForDisplay\(r\.claimedPhone\)\),\n\s*\]\),/, "the last cell, matching the appended header");
});

test("the card and the row label it as given in the enquiry — not verified", () => {
  assert.match(read("lib/i18n/messages/areas/customers.ts"), /claimedPhone: "מספר שנמסר בפנייה — לא אומת"/);
  assert.match(read("components/leads/LeadCard.tsx"), /t\("customers\.leads\.card\.fields\.claimedPhone"\)/);
  assert.match(read("components/leads/LeadCard.tsx"), /const reachPhone = lead\.contactPhone\?\.value \?\? null;/);
  assert.match(read("components/leads/LeadRow.tsx"), /customers\.leads\.common\.claimedPhoneShort/);
});

console.log(`\nALL L1 CLAIMED-PHONE TESTS PASSED — ${checks} checks\n`);
