/**
 * Leads L1 · G-01 — identity-policy@2 (contact assurance), pure suite. Run with:
 *   npx tsx lib/intake/identity/contact-assurance.test.ts
 *
 * No database: resolveIdentity runs against an in-memory tenant transaction. Pins:
 *   - a website form (self-asserted contact) never resolves through an email link alone — it asks
 *     the owner (candidate) instead; a provider-verified source resolves as before (policy@1 rules)
 *   - G-01b: a self-asserted phone is a CANDIDATE too (never resolved); verified sources resolve as before
 *   - a self-asserted phone + someone else's linked email is AMBIGUOUS, never a silent pick
 *   - every read stays inside its business (the same phone / email in another business is invisible)
 *   - only the website form is self-asserted; the lead destination never links for it
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { TenantTx } from "@/lib/tenant/transaction";
import type { ClaimedIntakeEvent } from "@/lib/intake/core/contract";
import { hashIdentifier, identifiersFromHints } from "./identifiers";
import { IDENTITY_POLICY_VERSION, resolveIdentity } from "./resolve";
import { SELF_ASSERTED_CONTACT_SOURCES, acquisitionReceipt, canonicalLead, normalizeAcquisitionLead } from "../acquisition/canonical";

let checks = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  checks++;
  console.log(`  ok  ${name}`);
}

type Link = { businessId: number; customerId: number; kind: string; scope: string; valueHash: string; status: string };
type Cust = { id: number; businessId: number; phone: string | null; email: string | null };

/** The three reads resolveIdentity makes, nothing else — any other call fails the suite. */
function fakeTx(customers: Cust[], links: Link[]): TenantTx {
  return {
    identityLink: {
      findFirst: async ({ where }: { where: Omit<Link, "customerId"> }) =>
        links.find((l) => l.businessId === where.businessId && l.kind === where.kind && l.scope === where.scope
          && l.valueHash === where.valueHash && l.status === where.status) ?? null,
    },
    customer: {
      findFirst: async ({ where }: { where: { businessId: number; phone: string } }) =>
        customers.find((c) => c.businessId === where.businessId && c.phone === where.phone) ?? null,
    },
    $queryRaw: async (_s: TemplateStringsArray, businessId: number, email: string, limit: number) =>
      customers.filter((c) => c.businessId === businessId && c.email?.trim().toLowerCase() === email).slice(0, limit).map((c) => ({ id: c.id })),
  } as unknown as TenantTx;
}

const ids = (hints: { phone?: string; email?: string }) => identifiersFromHints(hints, { sourceKey: "web.form", accountRef: null });
const emailLink = (businessId: number, customerId: number, email: string): Link => {
  const h = hashIdentifier(ids({ email })[0]);
  return { businessId, customerId, kind: h.kind, scope: h.scope, valueHash: h.valueHash, status: "active" };
};

const BIZ = 1, OTHER = 2;
const victim: Cust = { id: 10, businessId: BIZ, phone: "972501110000", email: null };
const another: Cust = { id: 11, businessId: BIZ, phone: "972502220000", email: null };
const elsewhere: Cust = { id: 20, businessId: OTHER, phone: "972501110000", email: "victim@example.test" };
const links = [emailLink(BIZ, victim.id, "victim@example.test"), emailLink(OTHER, elsewhere.id, "stranger@example.test")];
const tx = fakeTx([victim, another, elsewhere], links);

async function main() {
  console.log("\nLeads L1 · G-01 contact assurance — pure suite\n");

  await test("policy version is identity-policy@2 and evidence names the assurance", async () => {
    const r = await resolveIdentity(tx, BIZ, ids({ email: "victim@example.test" }));
    assert.equal(IDENTITY_POLICY_VERSION, "identity-policy@2");
    assert.equal(r.policyVersion, "identity-policy@2");
    assert.equal(r.evidence.assurance, "verified");
  });

  await test("verified source: an active email link resolves (policy@1 behaviour unchanged)", async () => {
    const r = await resolveIdentity(tx, BIZ, ids({ email: "victim@example.test" }));
    assert.deepEqual([r.state, r.customerId], ["resolved", victim.id]);
    assert.deepEqual(r.evidence.strongBases, ["email_link"]);
  });

  await test("self-asserted: someone's linked email + an unknown phone → candidate for the owner, never resolved", async () => {
    const r = await resolveIdentity(tx, BIZ, ids({ phone: "972509990000", email: "victim@example.test" }), { assurance: "self_asserted" });
    assert.equal(r.state, "candidate");
    assert.equal(r.customerId, null);
    assert.deepEqual(r.candidates, [{ customerId: victim.id, bases: ["email_link"] }]);
    assert.deepEqual([r.evidence.strongBases, r.evidence.weakBases, r.evidence.assurance], [[], ["email_link"], "self_asserted"]);
  });

  await test("G-01b: a self-asserted phone of an existing customer is a CANDIDATE, never resolved (a typed phone is a claim)", async () => {
    const r = await resolveIdentity(tx, BIZ, ids({ phone: victim.phone!, email: "new-address@example.test" }), { assurance: "self_asserted" });
    assert.deepEqual([r.state, r.customerId], ["candidate", null]);
    assert.deepEqual([r.evidence.strongBases, r.evidence.weakBases], [[], ["customer_phone"]]);
    assert.deepEqual(r.candidates, [{ customerId: victim.id, bases: ["customer_phone"] }]);
  });

  await test("verified: the same phone still resolves to its customer (Google / Meta / WhatsApp unchanged)", async () => {
    const r = await resolveIdentity(tx, BIZ, ids({ phone: victim.phone! }));
    assert.deepEqual([r.state, r.customerId, r.evidence.strongBases], ["resolved", victim.id, ["customer_phone"]]);
  });

  await test("self-asserted: one customer's phone + ANOTHER customer's linked email → ambiguous, nothing picked", async () => {
    const r = await resolveIdentity(tx, BIZ, ids({ phone: another.phone!, email: "victim@example.test" }), { assurance: "self_asserted" });
    assert.equal(r.state, "ambiguous");
    assert.equal(r.customerId, null);
    assert.deepEqual(r.candidates.map((c) => c.customerId), [victim.id, another.id]);
  });

  await test("tenant isolation: another business's phone, email and links are invisible", async () => {
    const r1 = await resolveIdentity(tx, BIZ, ids({ email: "stranger@example.test" }), { assurance: "self_asserted" });
    assert.equal(r1.state, "unresolved");
    const r2 = await resolveIdentity(tx, OTHER, ids({ email: "victim@example.test" }));
    assert.deepEqual([r2.state, r2.candidates], ["candidate", [{ customerId: elsewhere.id, bases: ["customer_email"] }]]);
    const r3 = await resolveIdentity(tx, OTHER, ids({ phone: victim.phone! }), { assurance: "self_asserted" });
    assert.deepEqual([r3.state, r3.candidates], ["candidate", [{ customerId: elsewhere.id, bases: ["customer_phone"] }]]);
  });

  await test("only the website form is self-asserted; authenticated lead sources stay verified", () => {
    assert.deepEqual([...SELF_ASSERTED_CONTACT_SOURCES], ["web.form"]);
    const lead = canonicalLead({ provider: "web", contact: { phone: "050-1110000", email: "victim@example.test" } });
    const claimed = (sourceKey: string): ClaimedIntakeEvent => {
      const r = acquisitionReceipt(lead, "c");
      return { id: 1, businessId: BIZ, sourceKey, family: r.family, eventType: r.eventType, externalEventId: r.externalEventId,
        providerAccountRef: "c", occurredAt: r.occurredAt, receivedAt: new Date(), status: "RECEIVED", attempts: 1,
        payload: r.payload as never, metadata: r.metadata as never };
    };
    const web = normalizeAcquisitionLead(claimed("web.form"));
    const google = normalizeAcquisitionLead(claimed("google.lead_form"));
    assert.ok(web.ok && google.ok);
    if (!web.ok || !google.ok) return;
    assert.equal(web.normalized.contactAssurance, "self_asserted");
    assert.equal(google.normalized.contactAssurance, undefined);
  });

  await test("structural: the lead destination links identity only for verified contact, and resolves with the event's assurance", () => {
    const code = readFileSync(path.join(process.cwd(), "lib/intake/routing/lead-destination.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.match(code, /resolveIdentity\(tx, businessId, identifiers, \{ assurance \}\)/);
    assert.match(code, /if \(customerId !== null && assurance === "verified"\) \{\s*await ensureLinks\(/);
    assert.equal((code.match(/ensureLinks\(/g) ?? []).length, 1, "exactly one ensureLinks call, the guarded one");
    // G-01b — no Customer from an anonymous form; an existing open lead is never attached to by one.
    assert.match(code, /identity\.state === "unresolved" && assurance === "verified"\) \{/);
    assert.equal((code.match(/customerService\.createCustomer\(/g) ?? []).length, 1);
    assert.match(code, /const attachedToOpenLead = openLeadId !== null && assurance === "verified";/);
    assert.match(code, /phone: heldBesideLeadId !== null \? null : phone,/);
    const proc = readFileSync(path.join(process.cwd(), "lib/intake/core/processor.ts"), "utf8");
    assert.match(proc, /preResolveIdentity\(businessId, identifiers, \{ assurance: n\.contactAssurance \}\)/);
  });

  console.log(`\nALL L1 CONTACT-ASSURANCE TESTS PASSED — ${checks} checks\n`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
