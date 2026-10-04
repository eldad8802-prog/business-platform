/**
 * M6 — acquisition core, no database: each provider's parse → the ONE canonical lead → the ONE
 * normalizer; fact status (supplied / not_supplied / not_applicable); receipt identity; webhook
 * signature verification; origins; the Secretary's arrivals. Run: npx tsx <this file>.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { acquisitionReceipt, canonicalLead, factStatus, leadIntentOf, normalizeAcquisitionLead } from "./canonical";
import { flattenFields, parseWebForm } from "./providers/web-form";
import { parseGoogleLead } from "./providers/google-lead-form";
import { metaReferenceReceipt, parseMetaLeadgenWebhook, verifyMetaSignature } from "./providers/meta-lead-ads";
import { normalizeOrigins } from "./connection.service";
import { hashKey, newPublicId, newSharedKey, PUBLIC_ID_PATTERN, safeEqual } from "./keys";
import { deriveLeadArrivals, leadSourceGroup } from "@/lib/services/crm/lead-briefing";
import type { ClaimedIntakeEvent } from "@/lib/intake/core/contract";

let n = 0;
function t(name: string, fn: () => void) {
  fn();
  n++;
  console.log(`  ok ${name}`);
}
const claimed = (r: ReturnType<typeof acquisitionReceipt>, accountRef = "acct"): ClaimedIntakeEvent => ({
  id: 1, businessId: 1, sourceKey: "web.form", family: r.family, eventType: r.eventType, externalEventId: r.externalEventId,
  providerAccountRef: accountRef, occurredAt: r.occurredAt, receivedAt: new Date(), status: "RECEIVED", attempts: 1,
  payload: r.payload as never, metadata: r.metadata as never,
});

t("web form: contact, answers, consent, UTM and click id are mapped; extra fields become answers", () => {
  const f = flattenFields({ name: "Noa", phone: "050-1234567", email: "N@Example.test", message: "quote", budget: 5, consent: "yes",
    utm_source: "fb", gclid: "abc", nested: { x: 1 }, submission_id: "s-1" })!;
  const p = parseWebForm(f);
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.equal(p.lead.contact.fullName, "Noa");
  assert.equal(p.lead.providerLeadId, "s-1");
  assert.deepEqual(p.lead.answers.map((a) => a.key), ["message", "budget"]);
  assert.deepEqual(p.lead.consent, [{ label: "consent", given: true }]);
  assert.equal(p.lead.context.utm?.source, "fb");
  assert.equal(p.lead.context.clickId, "abc");
  assert.ok(!("nested" in f));
});
t("web form: the honeypot is detected; no phone and no email is refused", () => {
  const hp = parseWebForm({ email: "a@b.test", _hp: "x" });
  assert.ok(hp.ok && hp.honeypot);
  assert.deepEqual(parseWebForm({ name: "x", message: "y" }), { ok: false, code: "no_contact" });
});
t("google: contact columns → contact, the rest → answers; ids and gclid → context; is_test kept", () => {
  const g = parseGoogleLead({ lead_id: "L1", google_key: "k", form_id: 9, campaign_id: 8, adgroup_id: 7, creative_id: 6, gcl_id: "G",
    is_test: true, user_column_data: [{ column_id: "FULL_NAME", string_value: "Dana" }, { column_id: "PHONE_NUMBER", string_value: "052" },
      { column_id: "SERVICE", column_name: "Which?", string_value: "Kitchen" }] });
  assert.ok(g.ok);
  if (!g.ok) return;
  assert.equal(g.googleKey, "k");
  assert.equal(g.lead.contact.fullName, "Dana");
  assert.deepEqual(g.lead.answers, [{ key: "SERVICE", label: "Which?", value: "Kitchen" }]);
  assert.deepEqual([g.lead.context.formId, g.lead.context.campaignId, g.lead.context.adSetId, g.lead.context.adId, g.lead.context.clickId], ["9", "8", "7", "6", "G"]);
  assert.equal(g.lead.isTest, true);
  assert.deepEqual(parseGoogleLead({ lead_id: "x" }), { ok: false, code: "missing_key" });
  assert.deepEqual(parseGoogleLead({ google_key: "k" }), { ok: false, code: "missing_lead_id" });
});
t("meta: a leadgen webhook groups references by Page; non-leadgen and malformed entries are ignored", () => {
  const p = parseMetaLeadgenWebhook({ object: "page", entry: [
    { id: "111", changes: [{ field: "leadgen", value: { leadgen_id: "9", page_id: "111", form_id: "7", created_time: 1700000000 } },
                            { field: "feed", value: {} }, { field: "leadgen", value: { leadgen_id: "x-not-digits", page_id: "111" } }] },
    { id: "222", changes: [{ field: "leadgen", value: { leadgen_id: "10", page_id: "222" } }] } ] });
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.deepEqual([...p.byPage.keys()].sort(), ["111", "222"]);
  assert.equal(p.byPage.get("111")!.length, 1);
  const r = metaReferenceReceipt(p.byPage.get("111")![0]);
  assert.equal(r.family, "LEAD");
  assert.deepEqual(parseMetaLeadgenWebhook({ object: "user", entry: [] }), { ok: false, code: "not_page_object" });
});
t("meta: X-Hub-Signature-256 verified in constant time against the raw body", () => {
  const raw = '{"object":"page"}';
  const sig = "sha256=" + createHmac("sha256", "s3cret").update(raw).digest("hex");
  assert.ok(verifyMetaSignature(raw, sig, "s3cret"));
  assert.ok(!verifyMetaSignature(raw + " ", sig, "s3cret"));
  assert.ok(!verifyMetaSignature(raw, sig, "other"));
  assert.ok(!verifyMetaSignature(raw, null, "s3cret"));
  assert.ok(!verifyMetaSignature(raw, "sha1=abc", "s3cret"));
});
t("fact status distinguishes supplied / not_supplied / not_applicable per provider", () => {
  const web = canonicalLead({ provider: "web", contact: { email: "a@b.test" } });
  const f = factStatus(web);
  assert.equal(f.email, "supplied");
  assert.equal(f.phone, "not_supplied");
  assert.equal(f.adSet, "not_applicable");
  const meta = factStatus(canonicalLead({ provider: "meta", contact: { phone: "1" } }));
  assert.equal(meta.utm, "not_applicable");
  assert.equal(meta.campaign, "not_supplied");
});
t("receipt identity: provider id per connection scope; same submission ⇒ same key; fingerprint without an id", () => {
  const a = acquisitionReceipt(canonicalLead({ provider: "google", providerLeadId: "L1" }), "conn1");
  const b = acquisitionReceipt(canonicalLead({ provider: "google", providerLeadId: "L1" }), "conn1");
  const c = acquisitionReceipt(canonicalLead({ provider: "google", providerLeadId: "L1" }), "conn2");
  assert.equal(a.externalEventId, b.externalEventId);
  assert.notEqual(a.externalEventId, c.externalEventId);
  assert.equal(a.dedupeBasis, "provider_event_id");
  const fp = acquisitionReceipt(canonicalLead({ provider: "web", submittedAt: "2026-10-04T10:00:00Z", contact: { email: "x@y.test" } }), "conn1");
  assert.equal(fp.dedupeBasis, "content_fingerprint");
});
t("receipt metadata is non-personal: ids, provider, test flag, fact status, answer COUNT — never values", () => {
  const r = acquisitionReceipt(canonicalLead({ provider: "web", contact: { fullName: "Secret Name", phone: "0501234567", email: "s@e.test" },
    answers: [{ key: "q", value: "private answer" }], context: { formId: "F1", landingUrl: "https://x.test/?email=s@e.test" } }), "c");
  const meta = JSON.stringify(r.metadata);
  assert.ok(!/Secret|0501234567|s@e\.test|private answer|x\.test/.test(meta), meta);
  assert.ok(meta.includes('"formId":"F1"') && meta.includes('"answerCount":1'));
});
t("the ONE normalizer: lead target; test → none; attribution sanitized; intent for the owner", () => {
  const lead = canonicalLead({ provider: "web", contact: { phone: "050-1234567", email: "a@b.test" }, answers: [{ key: "need", label: "Need", value: "Roof" }],
    consent: [{ label: "terms", given: false }], context: { landingUrl: "https://x.test/p?utm_source=g&email=a@b.test" } });
  const n1 = normalizeAcquisitionLead(claimed(acquisitionReceipt(lead, "c")));
  assert.ok(n1.ok);
  if (!n1.ok) return;
  assert.equal(n1.normalized.target, "lead");
  assert.equal(n1.normalized.identity, "unresolved");
  assert.equal(n1.normalized.attribution?.landingPage, "https://x.test/p");
  assert.equal(n1.normalized.attribution?.utm?.source, "g");
  assert.equal(n1.normalized.leadIntent, "Need: Roof\nterms: ✗");
  const test = normalizeAcquisitionLead(claimed(acquisitionReceipt(canonicalLead({ provider: "google", isTest: true, contact: { email: "a@b.test" } }), "c")));
  assert.ok(test.ok && test.normalized.target === "none");
  assert.deepEqual(normalizeAcquisitionLead({ ...claimed(acquisitionReceipt(lead, "c")), payload: { v: 2 } as never }), { ok: false, code: "malformed_payload" });
  assert.equal(leadIntentOf(canonicalLead({ provider: "web" })), undefined);
});
t("bounds: at most 30 answers, values cut at 500, control characters removed", () => {
  const l = canonicalLead({ provider: "web", answers: Array.from({ length: 50 }, (_, i) => ({ key: `k${i}`, value: "v\u0000".repeat(400) })) });
  assert.equal(l.answers.length, 30);
  assert.ok(l.answers.every((a) => a.value.length <= 500 && !a.value.includes("\u0000")));
});
t("origins: exact https origins only; paths, queries, http (non-local) and junk refused", () => {
  assert.deepEqual(normalizeOrigins(["https://a.example", "https://a.example/", "http://localhost:3000"]), ["https://a.example", "http://localhost:3000"]);
  for (const bad of [["http://a.example"], ["https://a.example/contact"], ["https://a.example?x=1"], ["javascript:alert(1)"], "x"]) {
    assert.throws(() => normalizeOrigins(bad));
  }
});
t("keys: opaque ids, prefixed keys, only the hash compared; constant-time equality", () => {
  const id = newPublicId();
  assert.ok(PUBLIC_ID_PATTERN.test(id));
  const k = newSharedKey("google.lead_form");
  assert.ok(k.key.startsWith("dgk_") && k.hash === hashKey(k.key) && k.hash.length === 64 && k.key.endsWith(k.hint));
  assert.ok(safeEqual("abc", "abc") && !safeEqual("abc", "abd") && !safeEqual("abc", "abcd"));
});
t("Secretary arrivals: today's new leads grouped by source, labels in Hebrew", () => {
  const a = deriveLeadArrivals([
    { sourceChannel: "intake:meta.lead_ads", n: 3 }, { sourceChannel: "intake:google.lead_form", n: 2 },
    { sourceChannel: "intake:web.form", n: 1 }, { sourceChannel: "WEBSITE", n: 1 }, { sourceChannel: null, n: 0 },
  ]);
  assert.equal(a.today, 7);
  assert.deepEqual(a.bySource.map((s) => [s.group, s.count]), [["meta", 3], ["google", 2], ["web", 2]]);
  assert.equal(leadSourceGroup("intake:meta.lead_ads").label, "פייסבוק/אינסטגרם");
  assert.equal(leadSourceGroup("MANUAL").group, "manual");
});

console.log(`\nALL M6 ACQUISITION CORE TESTS PASSED — ${n} checks`);
