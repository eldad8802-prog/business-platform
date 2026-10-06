/**
 * M7-B / M7-C — provider adapters, no database: WooCommerce / Wix order parsing (status, money, attribution,
 * receipt identity), Wix JWT (RS256 only) and its signed `instance`, CloudTalk call.ended + the call-history
 * hydrate (the outcome is never guessed), Voicenter CDR mapping, exact money, the sealed connect state.
 * Synthetic data only; providers stubbed in-process. Run: npx tsx lib/intake/m7bc-core.test.ts
 */
import assert from "node:assert/strict";
import { createHmac, createSign, generateKeyPairSync } from "node:crypto";

process.env.ACQUISITION_CREDENTIAL_ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { minorExponent, toMinor } from "./commerce/money";
import { isWooPing, normalizeStoreUrl, parseWooOrder, storeHostOf, wooStatus } from "./commerce/woocommerce";
import { parseWixOrder, verifyRs256, verifyWixWebhook, wixStatus } from "./commerce/wix";
import { instanceIdFrom } from "./commerce/wix-connect";
import { startWooConnect } from "./commerce/woocommerce-connect";
import { hydrateCloudTalkCall, parseCloudTalkWebhook, setCloudTalkFetchForTests } from "./calls/cloudtalk";
import { parseVoicenterCdr, readVoicenterCdr } from "./calls/voicenter";
import { normalizeCall } from "./calls/canonical";
import { openState, sealState, STATE_TTL_MS } from "./acquisition/sealed-state";
import { verifySvix } from "./acquisition/signatures";
import type { ClaimedIntakeEvent, IntakeReceiptDraft } from "./core/contract";

let n = 0;
const queue: Array<[string, () => void | Promise<void>]> = [];
const t = (name: string, fn: () => void | Promise<void>) => queue.push([name, fn]);

const claimed = (sourceKey: string, r: IntakeReceiptDraft, accountRef = "acct", receivedAt = new Date()): ClaimedIntakeEvent => ({
  id: 1, businessId: 1, sourceKey, family: r.family, eventType: r.eventType, externalEventId: r.externalEventId,
  providerAccountRef: accountRef, occurredAt: r.occurredAt, receivedAt, status: "RECEIVED", attempts: 1,
  payload: r.payload as never, metadata: r.metadata as never,
});

// ── money ──────────────────────────────────────────────────────────────────────────────────────────

t("money: exact minor units, negatives as absolute, excess non-zero digits refused, ISO exponents", () => {
  assert.equal(toMinor("259.00", "ILS"), 25900);
  assert.equal(toMinor("-40.5", "ILS"), 4050);
  assert.equal(toMinor(40.56, "USD"), 4056);
  assert.equal(toMinor("0.1", "ILS"), 10);
  assert.equal(toMinor("19.990", "ILS"), 1999);
  assert.equal(toMinor("19.995", "ILS"), null);
  assert.equal(toMinor("1000", "JPY"), 1000);
  assert.equal(toMinor("1.5", "JPY"), null);
  assert.equal(toMinor("1.234", "KWD"), 1234);
  assert.equal(toMinor("abc", "ILS"), null);
  assert.equal(toMinor("1e3", "ILS"), null);
  assert.equal(toMinor(undefined, "ILS"), null);
  assert.equal(minorExponent("ILS"), 2);
});

// ── WooCommerce ────────────────────────────────────────────────────────────────────────────────────

const wooOrder = (over: Record<string, unknown> = {}) => ({
  id: 727, number: "727", status: "processing", currency: "ILS", total: "259.00",
  date_created_gmt: "2026-10-01T09:00:00", date_modified_gmt: "2026-10-01T09:05:00", customer_id: 12,
  billing: { first_name: "Noa", last_name: "Test", phone: "050-0000000", email: "noa@example.test" },
  line_items: [{ id: 1, product_id: 93, variation_id: 0, sku: "MUG-1", name: "Mug", quantity: 2, total: "200.00", price: 100 }],
  refunds: [],
  meta_data: [
    { key: "_wc_order_attribution_utm_source", value: "google" },
    { key: "_wc_order_attribution_utm_campaign", value: "autumn" },
    { key: "_wc_order_attribution_session_entry", value: "https://shop.example.test/sale" },
    { key: "_billing_secret_note", value: "never read" },
  ],
  ...over,
});

t("woo: statuses map to the canonical lifecycle; drafts / trash are not an order state", () => {
  assert.equal(wooStatus("processing", 0, 100), "paid");
  assert.equal(wooStatus("processing", 10, 100), "partially_refunded");
  assert.equal(wooStatus("completed", 0, 100), "fulfilled");
  assert.equal(wooStatus("completed", 100, 100), "fulfilled");
  assert.equal(wooStatus("refunded", 100, 100), "refunded");
  assert.equal(wooStatus("cancelled", 0, 100), "cancelled");
  assert.equal(wooStatus("failed", 0, 100), "cancelled");
  assert.equal(wooStatus("on-hold", 0, 100), "placed");
  assert.equal(wooStatus("pending", 0, 100), "placed");
  assert.equal(wooStatus("trash", 0, 100), "ignore");
  assert.equal(wooStatus("checkout-draft", 0, 100), "ignore");
});

t("woo: an order → ONE commerce receipt (family COMMERCE, never LEAD), money exact, attribution from order meta only", () => {
  const p = parseWooOrder(wooOrder(), "order.updated", "pub_1");
  assert.ok(p.ok && "receipt" in p);
  if (!(p.ok && "receipt" in p)) return;
  assert.equal(p.receipt.family, "COMMERCE");
  const o = p.receipt.payload as Record<string, unknown>;
  assert.equal(o.totalMinor, 25900);
  assert.equal(o.status, "paid");
  const lines = o.lines as Array<Record<string, unknown>>;
  assert.equal(lines[0].unitMinor, 10000);
  assert.equal(lines[0].sku, "MUG-1");
  const attr = o.attribution as Record<string, unknown>;
  assert.equal(attr.source, "google");
  assert.equal(attr.campaign, "autumn");
  assert.ok(!JSON.stringify(o).includes("never read"));
  assert.equal(p.modifiedAt, "2026-10-01T09:05:00.000Z");
});

t("woo: identity = order + modification time + status — webhook and poller agree; a later change is new", () => {
  const a = parseWooOrder(wooOrder(), "order.updated", "pub_1");
  const b = parseWooOrder(wooOrder(), "order.created", "pub_1");
  const c = parseWooOrder(wooOrder({ date_modified_gmt: "2026-10-01T10:00:00", status: "completed" }), "order.updated", "pub_1");
  const other = parseWooOrder(wooOrder(), "order.updated", "pub_2");
  const id = (x: ReturnType<typeof parseWooOrder>) => (x.ok && "receipt" in x ? x.receipt.externalEventId : "");
  assert.equal(id(a), id(b));
  assert.notEqual(id(a), id(c));
  assert.notEqual(id(a), id(other), "a store's ids are scoped to its connection");
});

t("woo: refunds (negative strings) are summed, capped at the total; deleted / drafts are acknowledged, never written", () => {
  const p = parseWooOrder(wooOrder({ refunds: [{ total: "-40.50" }, { total: "-9.50" }] }), "order.updated", "pub_1");
  assert.ok(p.ok && "receipt" in p);
  if (p.ok && "receipt" in p) {
    assert.equal((p.receipt.payload as Record<string, unknown>).refundedMinor, 5000);
    assert.equal((p.receipt.payload as Record<string, unknown>).status, "partially_refunded");
  }
  assert.deepEqual(parseWooOrder({ id: 727 }, "order.deleted", "pub_1"), { ok: true, ignored: "trashed" });
  assert.deepEqual(parseWooOrder(wooOrder({ status: "checkout-draft" }), "order.updated", "pub_1"), { ok: true, ignored: "not_an_order_state" });
  assert.deepEqual(parseWooOrder(wooOrder({ total: "12.345" }), "order.updated", "pub_1"), { ok: false, code: "total" });
  assert.deepEqual(parseWooOrder(wooOrder({ currency: "shekel" }), "order.updated", "pub_1"), { ok: false, code: "currency" });
  assert.deepEqual(parseWooOrder({ id: "1; drop" }, "order.updated", "pub_1"), { ok: false, code: "order_id" });
});

t("woo: ping, store URL normalisation (https only, no credentials / query), host binding", () => {
  assert.ok(isWooPing("webhook_id=17"));
  assert.ok(!isWooPing('{"id":1}'));
  assert.equal(normalizeStoreUrl("shop.example.test/"), "https://shop.example.test");
  assert.equal(normalizeStoreUrl("https://Shop.Example.test/store/"), "https://shop.example.test/store");
  assert.equal(normalizeStoreUrl("http://shop.example.test"), null);
  assert.equal(normalizeStoreUrl("https://u:p@shop.example.test"), null);
  assert.equal(normalizeStoreUrl("https://shop.example.test/?a=1"), null);
  assert.equal(storeHostOf("https://shop.example.test/"), "shop.example.test");
  assert.equal(storeHostOf("http://shop.example.test/"), null);
});

t("woo connect: the authorize URL carries a SEALED state for this business only (expiry, kind, tamper)", () => {
  const r = startWooConnect(42, "https://app.example.test", "shop.example.test");
  assert.ok("authorizeUrl" in r);
  if (!("authorizeUrl" in r)) return;
  const u = new URL(r.authorizeUrl);
  assert.equal(u.origin + u.pathname, "https://shop.example.test/wc-auth/v1/authorize");
  assert.equal(u.searchParams.get("scope"), "read_write");
  assert.equal(u.searchParams.get("callback_url"), "https://app.example.test/api/integrations/commerce/woocommerce/callback");
  const state = u.searchParams.get("user_id")!;
  const opened = openState("woocommerce.connect", state);
  assert.equal(opened?.businessId, 42);
  assert.equal(opened?.payload.storeUrl, "https://shop.example.test");
  // Another business id in front of the same sealed body fails the AAD.
  assert.equal(openState("woocommerce.connect", state.replace(/^42\./, "43.")), null);
  assert.equal(openState("wix.connect", state), null);
  assert.equal(openState("woocommerce.connect", state, Date.now() + STATE_TTL_MS + 1000), null);
  assert.equal(openState("woocommerce.connect", `${state.slice(0, -2)}AA`), null);
  assert.deepEqual(startWooConnect(42, "https://app.example.test", "http://shop.example.test"), { error: "invalid_store_url" });
});

t("sealed state: a forged far-future expiry is refused", () => {
  const s = sealState("woocommerce.connect", 7, { a: "b" }, Date.now() + 10 * STATE_TTL_MS);
  assert.equal(openState("woocommerce.connect", s), null);
});

// ── Wix ────────────────────────────────────────────────────────────────────────────────────────────

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64u = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
function jwt(claims: Record<string, unknown>, alg = "RS256", key = privateKey) {
  const h = b64u({ alg, typ: "JWT" });
  const p = b64u(claims);
  const s = createSign("RSA-SHA256").update(`${h}.${p}`).sign(key).toString("base64url");
  return `${h}.${p}.${s}`;
}
const wixOrder = (over: Record<string, unknown> = {}) => ({
  id: "0b6a-order-1", number: "10001", status: "APPROVED", paymentStatus: "PAID", fulfillmentStatus: "NOT_FULFILLED",
  currency: "ILS", createdDate: "2026-10-01T09:00:00.000Z", updatedDate: "2026-10-01T09:01:00.000Z",
  priceSummary: { total: { amount: "120.00" } }, balanceSummary: { refunded: { amount: "0" } },
  buyerInfo: { email: "buyer@example.test", contactId: "c-1" },
  billingInfo: { contactDetails: { firstName: "Dan", lastName: "Test", phone: "+972500000000" } },
  lineItems: [{ id: "li-1", quantity: 1, price: { amount: "120.00" }, productName: { original: "Box" }, catalogReference: { catalogItemId: "p-1" } }],
  ...over,
});
const wixBody = (inner: Record<string, unknown>, instanceId = "inst-1234-abcd") =>
  jwt({ data: JSON.stringify({ eventType: "wix.ecom.v1.order_updated", instanceId, data: JSON.stringify(inner) }), iat: Math.floor(Date.now() / 1000) });

t("wix: RS256 with the app's public key only — another key, alg none / HS256, or an expired token is refused", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.ok(verifyRs256(jwt({ a: 1 }), pem, now));
  assert.equal(verifyRs256(jwt({ a: 1 }, "RS256", other.privateKey), pem, now), null);
  assert.equal(verifyRs256(`${b64u({ alg: "none" })}.${b64u({ a: 1 })}.`, pem, now), null);
  const hs = `${b64u({ alg: "HS256" })}.${b64u({ a: 1 })}`;
  assert.equal(verifyRs256(`${hs}.${createHmac("sha256", pem).update(hs).digest("base64url")}`, pem, now), null);
  assert.equal(verifyRs256(jwt({ a: 1, exp: now - 3600 }), pem, now), null);
});

t("wix: webhook envelope → instance, event id, slug, sequence and the order entity (created / updated / action)", async () => {
  const env = await verifyWixWebhook(wixBody({ id: "evt-1", entityFqdn: "wix.ecom.v1.order", slug: "updated", entityEventSequence: "7", updatedEvent: { currentEntity: wixOrder() } }), pem);
  assert.equal(env?.instanceId, "inst-1234-abcd");
  assert.equal(env?.eventId, "evt-1");
  assert.equal(env?.sequence, 7);
  assert.equal((env?.order as { id: string }).id, "0b6a-order-1");
  const action = await verifyWixWebhook(wixBody({ id: "evt-2", entityFqdn: "wix.ecom.v1.order", slug: "approved", actionEvent: { body: { order: wixOrder() } } }), pem);
  assert.equal((action?.order as { id: string }).id, "0b6a-order-1");
  assert.equal(await verifyWixWebhook("not-a-jwt", pem), null);
  assert.equal(await verifyWixWebhook(wixBody({ id: "evt-1" }, "bad id with spaces"), pem), null);
});

t("wix: status × payment × fulfilment; INITIALIZED is not yet an order; event id is the identity; refunds", () => {
  assert.equal(wixStatus({ status: "CANCELED" }), "cancelled");
  assert.equal(wixStatus({ status: "APPROVED", paymentStatus: "FULLY_REFUNDED" }), "refunded");
  assert.equal(wixStatus({ status: "APPROVED", paymentStatus: "PAID", fulfillmentStatus: "FULFILLED" }), "fulfilled");
  assert.equal(wixStatus({ status: "APPROVED", paymentStatus: "PAID" }), "paid");
  assert.equal(wixStatus({ status: "APPROVED", paymentStatus: "NOT_PAID" }), "placed");
  assert.deepEqual(parseWixOrder(wixOrder({ status: "INITIALIZED" }), { slug: "created", sequence: 1 }, "inst"), { ok: true, ignored: "not_yet_an_order" });
  const a = parseWixOrder(wixOrder(), { slug: "updated", eventId: "evt-1", sequence: 3 }, "inst");
  const b = parseWixOrder(wixOrder(), { slug: "updated", eventId: "evt-1", sequence: 3 }, "inst");
  const c = parseWixOrder(wixOrder(), { slug: "updated", eventId: "evt-2", sequence: 4 }, "inst");
  assert.ok(a.ok && "receipt" in a && b.ok && "receipt" in b && c.ok && "receipt" in c);
  if (!(a.ok && "receipt" in a && b.ok && "receipt" in b && c.ok && "receipt" in c)) return;
  assert.equal(a.receipt.family, "COMMERCE");
  assert.equal(a.receipt.externalEventId, b.receipt.externalEventId);
  assert.notEqual(a.receipt.externalEventId, c.receipt.externalEventId);
  assert.equal((a.receipt.payload as Record<string, unknown>).totalMinor, 12000);
  const r = parseWixOrder(wixOrder({ paymentStatus: "PARTIALLY_REFUNDED", balanceSummary: { refunded: { amount: "20.00" } } }), { slug: "updated", sequence: null }, "inst");
  assert.ok(r.ok && "receipt" in r && (r.receipt.payload as Record<string, unknown>).refundedMinor === 2000);
});

t("wix connect: ONLY Wix's signed instance binds — a bare id, a wrong signature or a foreign secret is refused", () => {
  const secret = "wix-app-secret-synthetic";
  const payload = b64u({ instanceId: "inst-1234-abcd", signDate: "2026-10-01T00:00:00Z" });
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  assert.equal(instanceIdFrom(`${sig}.${payload}`, secret), "inst-1234-abcd");
  assert.equal(instanceIdFrom("inst-1234-abcd", secret), null);
  assert.equal(instanceIdFrom(`${sig}.${payload}`, "another-secret"), null);
  assert.equal(instanceIdFrom(`${sig}.${b64u({ instanceId: "inst-9999-zzzz" })}`, secret), null);
  assert.equal(instanceIdFrom(`${sig}.${payload}.x`, secret), null);
});

// ── CloudTalk ──────────────────────────────────────────────────────────────────────────────────────

const ctEvent = (data: Record<string, unknown>, type = "call.ended") =>
  JSON.stringify({ event_id: "e-1", type, occurred_at: "2026-10-01T09:00:00Z", company_id: 555, data });
const ctCall = {
  call_id: 9001, direction: "incoming", external_number: "+972500000001",
  internal_number: { number_e164: "+97230000000", internal_name: "Sales line" },
  started_at: "2026-10-01T09:00:00Z", ended_at: "2026-10-01T09:00:40Z", duration: 40, talking_time: 31, is_voicemail: false,
  recording_url: "https://rec.example.test/should-never-enter",
};

t("cloudtalk: call.ended → a REFERENCE (no outcome guessed), one receipt per call, internal calls / other events ignored", () => {
  const p = parseCloudTalkWebhook(ctEvent(ctCall));
  assert.ok(p.ok && "receipt" in p);
  if (!(p.ok && "receipt" in p)) return;
  assert.equal(p.companyId, "555");
  assert.equal(p.receipt.family, "CALL");
  const ref = p.receipt.payload as Record<string, unknown>;
  assert.equal(ref.kind, "cloudtalk_call_ref");
  assert.equal(ref.outcome, undefined);
  assert.equal(ref.lineName, "Sales line");
  assert.ok(!JSON.stringify(ref).includes("rec.example.test"));
  const again = parseCloudTalkWebhook(JSON.stringify({ event_id: "e-2", type: "call.ended", company_id: 555, data: ctCall }));
  assert.ok(again.ok && "receipt" in again && again.receipt.externalEventId === p.receipt.externalEventId);
  const otherCompany = parseCloudTalkWebhook(JSON.stringify({ type: "call.ended", company_id: 556, data: ctCall }));
  assert.ok(otherCompany.ok && "receipt" in otherCompany && otherCompany.receipt.externalEventId !== p.receipt.externalEventId);
  assert.deepEqual(parseCloudTalkWebhook(ctEvent({ ...ctCall, direction: "internal" })), { ok: true, companyId: "555", ignored: "internal_call" });
  assert.deepEqual(parseCloudTalkWebhook(ctEvent(ctCall, "call.started")), { ok: true, companyId: "555", ignored: "not_call_ended" });
  assert.deepEqual(parseCloudTalkWebhook("{"), { ok: false, code: "malformed" });
  assert.deepEqual(parseCloudTalkWebhook(JSON.stringify({ type: "call.ended", data: ctCall })), { ok: false, code: "company_id" });
});

t("cloudtalk: Svix signature with the owner's whsec_ secret, 5-minute window", () => {
  const key = Buffer.from("0123456789abcdef0123456789abcdef");
  const secret = `whsec_${key.toString("base64")}`;
  const raw = ctEvent(ctCall);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", key).update(`msg_1.${ts}.${raw}`).digest("base64");
  assert.ok(verifySvix(raw, { id: "msg_1", timestamp: ts, signature: `v1,${sig}` }, secret, new Date()));
  assert.ok(!verifySvix(raw + " ", { id: "msg_1", timestamp: ts, signature: `v1,${sig}` }, secret, new Date()));
  assert.ok(!verifySvix(raw, { id: "msg_1", timestamp: ts, signature: `v1,${sig}` }, secret, new Date(Date.now() + 10 * 60_000)));
});

t("cloudtalk hydrate: the outcome comes from call history; no key / bad key / not yet visible defer; never guessed", async () => {
  const p = parseCloudTalkWebhook(ctEvent(ctCall));
  assert.ok(p.ok && "receipt" in p);
  if (!(p.ok && "receipt" in p)) return;
  const ev = claimed("telephony.cloudtalk", p.receipt, "pub_ct");
  const ctx = { businessId: 1, now: new Date() };
  const key = async () => ({ apiKeyId: "KEYID123", apiKeySecret: "SECRET123" });

  assert.equal((await hydrateCloudTalkCall(ctx, ev, async () => null)).kind, "deferred");
  setCloudTalkFetchForTests(async () => ({ status: 401, json: null }));
  const bad = await hydrateCloudTalkCall(ctx, ev, key);
  assert.ok(bad.kind === "deferred" && bad.code === "cloudtalk_api_key_invalid");
  setCloudTalkFetchForTests(async () => ({ status: 200, json: { responseData: { data: [] } } }));
  const lag = await hydrateCloudTalkCall(ctx, ev, key);
  assert.ok(lag.kind === "deferred" && lag.code === "cloudtalk_call_not_yet_visible");
  await assert.rejects(hydrateCloudTalkCall(ctx, claimed("telephony.cloudtalk", p.receipt, "pub_ct", new Date(Date.now() - 25 * 3_600_000)), key), /cloudtalk_call_not_found/);

  let seenAuth = "";
  setCloudTalkFetchForTests(async (url, auth) => {
    seenAuth = auth;
    assert.ok(url.includes("call_id=9001"));
    return { status: 200, json: { responseData: { data: [{ Cdr: { answered_at: "" } }] } } };
  });
  const missed = await hydrateCloudTalkCall(ctx, ev, key);
  assert.equal(seenAuth, Buffer.from("KEYID123:SECRET123").toString("base64"));
  assert.ok(missed.kind === "hydrated");
  if (missed.kind === "hydrated") {
    const call = missed.payload as Record<string, unknown>;
    assert.equal(call.outcome, "missed");
    assert.equal(call.durationSec, 0);
    assert.equal(call.lineName, "Sales line");
    // The normalizer turns it into a call — never a lead — labelled by its line.
    const norm = normalizeCall({ ...ev, payload: missed.payload as never, metadata: missed.metadata as never });
    assert.ok(norm.ok);
  }
  setCloudTalkFetchForTests(async () => ({ status: 200, json: { responseData: { data: [{ Cdr: { answered_at: "2026-10-01 09:00:09" } }] } } }));
  const answered = await hydrateCloudTalkCall(ctx, ev, key);
  assert.ok(answered.kind === "hydrated" && (answered.payload as Record<string, unknown>).outcome === "answered");
  assert.ok(answered.kind === "hydrated" && (answered.payload as Record<string, unknown>).durationSec === 31);
  setCloudTalkFetchForTests(null);
});

// ── Voicenter ──────────────────────────────────────────────────────────────────────────────────────

const vc = (over: Record<string, unknown> = {}) => ({
  ivruniqueid: "1696150800.123", direction: "incoming", type: "incoming", status: "NOANSWER", isAnswer: 0,
  time: 1_696_150_800, duration: 0, did: "035550000", caller: "0500000002", callerPhone: "0500000002", target: "201",
  record: "https://rec.example.test/x.mp3", aiData: { summary: "never enters" },
  ...over,
});

t("voicenter: CDR → call (direction, outcome from isAnswer / status), recordings and AI data never enter", () => {
  const p = parseVoicenterCdr(vc(), "pub_vc");
  assert.ok(p.ok && "receipt" in p);
  if (!(p.ok && "receipt" in p)) return;
  const call = p.receipt.payload as Record<string, unknown>;
  assert.equal(call.direction, "inbound");
  assert.equal(call.outcome, "missed");
  assert.equal(call.businessLine, "035550000");
  assert.ok(!JSON.stringify(call).includes("rec.example.test"));
  assert.ok(!JSON.stringify(call).includes("never enters"));
  const ans = parseVoicenterCdr(vc({ status: "ANSWER", isAnswer: 1, actualCallDuration: 65 }), "pub_vc");
  assert.ok(ans.ok && "receipt" in ans && (ans.receipt.payload as Record<string, unknown>).outcome === "answered");
  assert.ok(ans.ok && "receipt" in ans && (ans.receipt.payload as Record<string, unknown>).durationSec === 65);
  const busy = parseVoicenterCdr(vc({ status: "BUSY" }), "pub_vc");
  assert.ok(busy.ok && "receipt" in busy && (busy.receipt.payload as Record<string, unknown>).outcome === "busy");
  const vm = parseVoicenterCdr(vc({ status: "VOICEMAIL" }), "pub_vc");
  assert.ok(vm.ok && "receipt" in vm && (vm.receipt.payload as Record<string, unknown>).outcome === "voicemail");
});

t("voicenter: outbound counterpart is the target; an extension is never a person; internal / unknown ignored", () => {
  const out = parseVoicenterCdr(vc({ direction: "outgoing", type: "outgoing", caller: "035550000", target: "0500000003", status: "ANSWER", isAnswer: 1 }), "pub_vc");
  assert.ok(out.ok && "receipt" in out);
  if (out.ok && "receipt" in out) {
    const call = out.receipt.payload as Record<string, unknown>;
    assert.equal(call.direction, "outbound");
    assert.equal(call.counterpartNumber, "0500000003");
  }
  const ext = parseVoicenterCdr(vc({ direction: "outgoing", type: "outgoing", target: "201" }), "pub_vc");
  assert.ok(ext.ok && "receipt" in ext && (ext.receipt.payload as Record<string, unknown>).counterpartNumber === undefined);
  assert.deepEqual(parseVoicenterCdr(vc({ direction: "", type: "extension" }), "pub_vc"), { ok: true, ignored: "internal_or_unknown_direction" });
  assert.deepEqual(parseVoicenterCdr(vc({ ivruniqueid: "" }), "pub_vc"), { ok: false, code: "call_id" });
  assert.deepEqual(parseVoicenterCdr(vc({ time: "x" }), "pub_vc"), { ok: false, code: "time" });
});

t("voicenter: the same CDR re-sent is ONE receipt; JSON and form bodies read the same", () => {
  const a = parseVoicenterCdr(vc(), "pub_vc");
  const b = parseVoicenterCdr(readVoicenterCdr(new URLSearchParams(vc() as never).toString(), "application/x-www-form-urlencoded")!, "pub_vc");
  assert.ok(a.ok && "receipt" in a && b.ok && "receipt" in b);
  if (a.ok && "receipt" in a && b.ok && "receipt" in b) assert.equal(a.receipt.externalEventId, b.receipt.externalEventId);
  assert.equal(readVoicenterCdr("<xml/>", "text/xml"), null);
  assert.equal(readVoicenterCdr("[1]", "application/json"), null);
});

(async () => {
  for (const [name, fn] of queue) {
    await fn();
    n++;
    console.log(`  ok ${name}`);
  }
  console.log(`\nm7bc-core: ${n}/${queue.length} passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
