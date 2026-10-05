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
import { HANDLE_TTL_MS, openConnectHandle, sealConnectHandle } from "./connect-handle";
import { WEB_FORM_SCRIPT, webFormSnippet } from "./web-form-snippet";
import vm from "node:vm";

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
  assert.deepEqual(normalizeOrigins(["https://a.example", "https://a.example/", "http://localhost:3000"]), ["https://a.example", "https://www.a.example", "http://localhost:3000"]);
  // the www / bare twin of an https site comes with it, both ways; never for localhost or an IP
  assert.deepEqual(normalizeOrigins(["https://www.shop.co.il"]), ["https://www.shop.co.il", "https://shop.co.il"]);
  assert.deepEqual(normalizeOrigins(["https://10.0.0.5"]), ["https://10.0.0.5"]);
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

t("web form without submission_id: same enquiry the same day = one receipt; the next day = a new one", () => {
  const at = (iso: string, extra: Record<string, string> = {}) => {
    const p = parseWebForm(flattenFields({ name: "Noa", phone: "050-1234567", message: "quote please", ...extra })!);
    assert.ok(p.ok);
    if (!p.ok) throw new Error("parse");
    return acquisitionReceipt({ ...p.lead, submittedAt: iso }, "pub1").externalEventId;
  };
  const first = at("2026-10-05T09:00:00.120Z");
  assert.equal(at("2026-10-05T09:00:00.987Z"), first, "a double-click (ms apart) collapses");
  assert.equal(at("2026-10-05T17:30:00.000Z"), first, "a resubmit later that day collapses");
  assert.notEqual(at("2026-10-06T09:00:00.120Z"), first, "the same enquiry the next day is new");
  assert.notEqual(at("2026-10-05T09:00:00.120Z", { message: "a different question" }), first, "different content is new");
  assert.notEqual(at("2026-10-05T09:00:00.120Z", { submission_id: "s-42" }), first, "a form-supplied submission id wins");
});

t("ready-made form: the real script gives ONE submission id per page load; a restored value is kept", () => {
  const snippet = webFormSnippet("https://promaxgroup.co.il/api/intake/acquisition/web/abc");
  assert.ok(snippet.includes(`<input type="hidden" name="submission_id">`) && snippet.includes("data-dubiz-form") && snippet.includes(WEB_FORM_SCRIPT));
  // A page = one form with its hidden inputs; running the script = loading the page.
  const page = (restoredId = "") => {
    const inputs: Record<string, { value: string }> = { submission_id: { value: restoredId }, page_url: { value: "" } };
    const form = { querySelector: (sel: string) => inputs[/name="([^"]+)"/.exec(sel)![1]] ?? null };
    return { inputs, ctx: vm.createContext({
      document: { querySelectorAll: () => [form] },
      location: { href: "https://www.site.example/contact?utm_source=google" },
      self: { crypto: { randomUUID: () => crypto.randomUUID() } },
      crypto: { randomUUID: () => crypto.randomUUID() },
      Date, Math,
    }) };
  };
  const load = (p: ReturnType<typeof page>) => { vm.runInContext(WEB_FORM_SCRIPT, p.ctx); return p.inputs; };
  const first = load(page());
  assert.match(first.submission_id.value, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(first.page_url.value, "https://www.site.example/contact?utm_source=google");
  // Double-click / retry / back + resubmit: the same page, the script ran again on a restored field.
  const restored = page(first.submission_id.value);
  assert.equal(load(restored).submission_id.value, first.submission_id.value, "a restored id is never replaced");
  // A new page load (a new enquiry) gets a new id.
  assert.notEqual(load(page()).submission_id.value, first.submission_id.value);
});

t("receipt key: the submission id decides — same id = one receipt whatever the time; two ids = two, even for identical text", () => {
  const lead = (extra: Record<string, string>, iso: string) => {
    const p = parseWebForm(flattenFields({ name: "Noa Levi", phone: "050-1234567", email: "noa@example.test", message: "quote please", ...extra })!);
    assert.ok(p.ok);
    if (!p.ok) throw new Error("parse");
    return acquisitionReceipt({ ...p.lead, submittedAt: iso }, "pub1");
  };
  const idA = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b", idB = "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";
  const a1 = lead({ submission_id: idA }, "2026-10-05T09:00:00.000Z");
  assert.equal(lead({ submission_id: idA }, "2026-10-05T09:00:00.400Z").externalEventId, a1.externalEventId, "double-click");
  assert.equal(lead({ submission_id: idA }, "2026-10-06T00:00:01.000Z").externalEventId, a1.externalEventId, "a retry after midnight UTC");
  assert.notEqual(lead({ submission_id: idB }, "2026-10-05T09:00:00.000Z").externalEventId, a1.externalEventId, "identical text, new page load");
  assert.equal(a1.dedupeBasis, "provider_event_id");
  const fallback = lead({}, "2026-10-05T09:00:00.000Z");
  assert.equal(fallback.dedupeBasis, "content_fingerprint", "no id: the documented fallback");
  for (const r of [a1, fallback]) {
    assert.match(r.externalEventId, /^sha256:[0-9a-f]{64}$/);
    for (const pii of ["Noa", "Levi", "0501234567", "050-1234567", "noa@example.test", "quote", idA]) assert.ok(!r.externalEventId.includes(pii), `no ${pii} in the key`);
  }
});

t("Meta connect handle: opens only for the same business, unexpired and untampered; never shows the token", () => {
  process.env.ACQUISITION_CREDENTIAL_ENCRYPTION_KEY ||= "ab".repeat(32);
  const now = Date.now();
  const h = sealConnectHandle(7, "USER-TOKEN-1", now);
  assert.ok(!h.includes("USER-TOKEN-1") && !Buffer.from(h, "base64url").toString("utf8").includes("USER-TOKEN-1"));
  assert.equal(openConnectHandle(7, h, now + 1000), "USER-TOKEN-1");
  assert.equal(openConnectHandle(8, h, now + 1000), null);
  assert.equal(openConnectHandle(7, h, now + HANDLE_TTL_MS + 1), null);
  const j = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  assert.equal(openConnectHandle(7, Buffer.from(JSON.stringify({ ...j, x: j.x + 60_000 })).toString("base64url"), now), null);
  assert.equal(openConnectHandle(7, Buffer.from(JSON.stringify({ ...j, c: Buffer.from("x").toString("base64") })).toString("base64url"), now), null);
  assert.equal(openConnectHandle(7, 42, now), null);
  assert.equal(openConnectHandle(7, "not-a-handle", now), null);
});

console.log(`\nALL M6 ACQUISITION CORE TESTS PASSED — ${n} checks`);
