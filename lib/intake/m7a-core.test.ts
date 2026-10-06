/**
 * M7-A — commerce + telephony core, no database: the canonical order / call, receipt identity, the
 * normalizers, routing (R0 / R5 / R9), stale-delivery ordering, the provider signature schemes, the
 * learning buckets, the Secretary's CUSTOMER_CALLED reason, and the Meta token-lifetime exchange.
 * Run: npx tsx lib/intake/m7a-core.test.ts
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { ClaimedIntakeEvent, IntakeReceiptDraft } from "@/lib/intake/core/contract";
import { canonicalOrder, commerceReceipt, CommerceOrderInvalid, normalizeCommerceOrder } from "@/lib/intake/commerce/canonical";
import { callerHash, callReceipt, canonicalCall, CallInvalid, durationBucket, normalizeCall } from "@/lib/intake/calls/canonical";
import { decideRoute } from "@/lib/intake/routing/rules";
import { CORE_DESTINATION_HANDLERS } from "@/lib/intake/routing/core-destinations";
import { isNewerOrderState, totalBucket } from "@/lib/intake/routing/commerce-destination";
import { latencyBucket } from "@/lib/intake/routing/call-destination";
import { verifyHmacSha256Base64, verifySvix } from "@/lib/intake/acquisition/signatures";
import { evaluateLeadAttention } from "@/lib/services/crm/lead-attention";
import { isMetaPermissionCode, exchangeLoginCode, MetaGraphError, setMetaCodeExchangeForTests } from "@/lib/intake/acquisition/providers/meta-graph";
import { CONNECTION_SOURCE_KEYS, SOURCE_FEATURE } from "@/lib/intake/acquisition/gate";
import { isRouteTarget } from "@/lib/intake/core/normalized-store";
import { makeCommerceAdapter } from "@/lib/intake/commerce/adapter";
import { makeCallAdapter } from "@/lib/intake/calls/adapter";

let n = 0;
async function t(name: string, fn: () => void | Promise<void>) {
  await fn();
  n++;
  console.log(`  ok ${name}`);
}
const claimed = (r: IntakeReceiptDraft, sourceKey: string): ClaimedIntakeEvent => ({
  id: 1, businessId: 1, sourceKey, family: r.family, eventType: r.eventType, externalEventId: r.externalEventId,
  providerAccountRef: "pub", occurredAt: r.occurredAt, receivedAt: new Date(), status: "RECEIVED", attempts: 1,
  payload: r.payload as never, metadata: r.metadata as never,
});
const baseOrder = {
  providerOrderId: "1042", orderNumber: "#1042", eventKind: "created", status: "placed", currency: "ils",
  totalMinor: 25_900, placedAt: "2026-10-06T10:00:00Z", providerUpdatedAt: "2026-10-06T10:00:00Z",
  buyer: { phone: "052-555-0101", email: "Buyer@Example.co.il", name: "Dana Levi", providerCustomerId: "77" },
  lines: [{ lineKey: "1", externalProductId: "p9", sku: "SKU-1", title: "Lamp", quantity: 2, unitMinor: 12_950, totalMinor: 25_900 }],
  attribution: { landingUrl: "https://shop.example/p/lamp?utm_source=ig&utm_campaign=fall&email=a@b.c", clickId: "fbclid1" },
};

async function main() {
  console.log("-- commerce: canonical order");
  await t("a valid order is bounded and normalized (currency upper-cased, buyer kept only as hints)", () => {
    const o = canonicalOrder(baseOrder);
    assert.equal(o.currency, "ILS");
    assert.equal(o.refundedMinor, 0);
    assert.equal(o.lines?.length, 1);
    assert.equal(o.buyer.providerCustomerId, "77");
  });
  await t("invalid orders are refused, never guessed (bad id, status, currency, amounts, refunded > total, lines)", () => {
    for (const [patch, code] of [
      [{ providerOrderId: "has space" }, "order_id"], [{ status: "shipped" }, "status"], [{ eventKind: "x" }, "event_kind"],
      [{ currency: "₪" }, "currency"], [{ totalMinor: 1.5 }, "total"], [{ totalMinor: -1 }, "total"],
      [{ refundedMinor: 30_000 }, "refunded"], [{ placedAt: "yesterday" }, "time"],
      [{ lines: [{ lineKey: "a", quantity: 0, unitMinor: 1, totalMinor: 1 }] }, "line"],
      [{ lines: [{ lineKey: "a", quantity: 1, unitMinor: 1, totalMinor: 1 }, { lineKey: "a", quantity: 1, unitMinor: 1, totalMinor: 1 }] }, "duplicate_line"],
    ] as const) {
      assert.throws(() => canonicalOrder({ ...baseOrder, ...patch }), (e: unknown) => e instanceof CommerceOrderInvalid && e.code === code, code);
    }
  });
  await t("WooCommerce guest checkout (customer id 0) is not a provider identity", () => {
    assert.equal(canonicalOrder({ ...baseOrder, buyer: { providerCustomerId: 0 } }).buyer.providerCustomerId, undefined);
  });
  await t("receipt identity: the same store change twice = one key; a later change = a new key; scoped per connection", () => {
    const a = commerceReceipt(canonicalOrder(baseOrder), "pubA");
    const b = commerceReceipt(canonicalOrder(baseOrder), "pubA");
    const later = commerceReceipt(canonicalOrder({ ...baseOrder, eventKind: "paid", status: "paid", providerUpdatedAt: "2026-10-06T10:05:00Z" }), "pubA");
    const other = commerceReceipt(canonicalOrder(baseOrder), "pubB");
    assert.equal(a.externalEventId, b.externalEventId);
    assert.notEqual(a.externalEventId, later.externalEventId);
    assert.notEqual(a.externalEventId, other.externalEventId);
    assert.equal(a.dedupeBasis, "content_fingerprint");
    assert.equal(commerceReceipt(canonicalOrder({ ...baseOrder, providerEventId: "evt-1" }), "pubA").dedupeBasis, "provider_event_id");
    assert.equal(a.family, "COMMERCE");
    assert.equal(a.eventType, "order.created");
  });
  await t("receipt metadata is non-personal (no name, phone, email, product title, URL)", () => {
    const meta = JSON.stringify(commerceReceipt(canonicalOrder(baseOrder), "p").metadata);
    assert.ok(!/Dana|555|example|Lamp|shop/i.test(meta), meta);
  });
  await t("the commerce normalizer: target commerce (never lead); buyer → M4 hints; attribution sanitized", () => {
    const n = normalizeCommerceOrder(claimed(commerceReceipt(canonicalOrder(baseOrder), "p"), "commerce.woocommerce"));
    assert.ok(n.ok);
    if (!n.ok) return;
    assert.equal(n.normalized.target, "commerce");
    assert.equal(n.normalized.contactHints?.phone, "972525550101");
    assert.equal(n.normalized.contactHints?.email, "buyer@example.co.il");
    assert.equal(n.normalized.contactHints?.providerUserId, "77");
    assert.equal(n.normalized.attribution?.landingPage, "https://shop.example/p/lamp");
    assert.equal(n.normalized.attribution?.utm?.source, "ig");
    assert.ok(!JSON.stringify(n.normalized.attribution).includes("a@b.c"));
  });

  console.log("-- telephony: canonical call");
  await t("a call keeps only business facts; recordings / transcripts / agent names never enter", () => {
    const c = canonicalCall({
      providerCallId: "ivr-123", direction: "inbound", outcome: "missed", durationSec: 0, startedAt: "2026-10-06T09:00:00Z",
      businessLine: "03-555-1234", counterpartNumber: "054-777-8888",
      ...({ record: "https://rec/1.mp3", transcript: "hello", agent: "Moshe" } as object),
    } as Parameters<typeof canonicalCall>[0]);
    const s = JSON.stringify(c);
    for (const leaked of ['"record"', "1.mp3", "transcript", "hello", "Moshe", '"agent"']) assert.ok(!s.includes(leaked), `${leaked} in ${s}`);
    assert.equal(c.businessLine, "035551234");
    assert.equal(c.counterpartHidden, false);
  });
  await t("hidden / anonymous caller ids are hidden, never a number", () => {
    for (const v of ["anonymous", "Private", "", "0000", undefined, "restricted"]) {
      const c = canonicalCall({ providerCallId: "x1", direction: "inbound", outcome: "missed", startedAt: "2026-10-06T09:00:00Z", counterpartNumber: v });
      assert.equal(c.counterpartHidden, true, String(v));
      assert.equal(c.counterpartNumber, undefined);
    }
  });
  await t("invalid calls are refused (id, direction, outcome, time)", () => {
    for (const [patch, code] of [[{ providerCallId: "a b" }, "call_id"], [{ direction: "internal" }, "direction"], [{ outcome: "ok" }, "outcome"], [{ startedAt: "?" }, "time"]] as const) {
      assert.throws(() => canonicalCall({ providerCallId: "c1", direction: "inbound", outcome: "missed", startedAt: "2026-10-06T09:00:00Z", ...patch }),
        (e: unknown) => e instanceof CallInvalid && e.code === code, code);
    }
  });
  await t("call receipt: family CALL; missed inbound = call.missed; metadata non-personal; same event twice = one key", () => {
    const c = canonicalCall({ providerCallId: "c2", direction: "inbound", outcome: "missed", startedAt: "2026-10-06T09:00:00Z", counterpartNumber: "0547778888" });
    const r = callReceipt(c, "pub");
    assert.equal(r.family, "CALL");
    assert.equal(r.eventType, "call.missed");
    assert.equal(r.externalEventId, callReceipt(c, "pub").externalEventId);
    assert.ok(!/777|8888/.test(JSON.stringify(r.metadata)));
  });
  await t("the call normalizer: target call; the number is only an M4 phone hint; a hidden caller has no hints", () => {
    const c = canonicalCall({ providerCallId: "c3", direction: "inbound", outcome: "missed", startedAt: "2026-10-06T09:00:00Z", counterpartNumber: "0547778888" });
    const n1 = normalizeCall(claimed(callReceipt(c, "p"), "telephony.cloudtalk"));
    assert.ok(n1.ok && n1.normalized.target === "call" && n1.normalized.contactHints?.phone === "972547778888");
    const h = canonicalCall({ providerCallId: "c4", direction: "inbound", outcome: "missed", startedAt: "2026-10-06T09:00:00Z" });
    const n2 = normalizeCall(claimed(callReceipt(h, "p"), "telephony.cloudtalk"));
    assert.ok(n2.ok && n2.normalized.contactHints === null && n2.normalized.identity === "none");
  });
  await t("callerHash is per business: same number, another business → another hash; never the number", () => {
    const a = callerHash(1, "972547778888");
    assert.match(a, /^sha256:[0-9a-f]{64}$/);
    assert.notEqual(a, callerHash(2, "972547778888"));
    assert.ok(!a.includes("7778888"));
  });

  console.log("-- routing (frozen invariants)");
  const coreAll = ["lead", "commerce", "call"] as const;
  await t("R0: an order or a call aimed at 'lead' is FORBIDDEN (dead-lettered, never a Lead)", () => {
    for (const family of ["COMMERCE", "CALL"] as const) {
      const d = decideRoute({ family, eventType: "x", target: "lead", identityState: "resolved", coreDestinations: coreAll });
      assert.equal(d.rule, "R0_FORBIDDEN_LEAD");
      assert.equal(d.executor, "forbidden");
    }
  });
  await t("R5: COMMERCE → commerce, core when the adapter opted in, unavailable otherwise", () => {
    assert.equal(decideRoute({ family: "COMMERCE", eventType: "order.created", target: "commerce", identityState: "unresolved", coreDestinations: coreAll }).executor, "core");
    assert.equal(decideRoute({ family: "COMMERCE", eventType: "order.created", target: "commerce", identityState: "unresolved", coreDestinations: [] }).executor, "unavailable");
  });
  await t("R9: CALL → call (core); a conflict asks the owner; a CALL never reaches R8 attention", () => {
    const d = decideRoute({ family: "CALL", eventType: "call.missed", target: "call", identityState: "conflict", coreDestinations: coreAll });
    assert.deepEqual([d.rule, d.destination, d.executor, d.ownerReviewRequired], ["R9_CALL", "call", "core", true]);
    assert.equal(decideRoute({ family: "CALL", eventType: "call.missed", target: "call", identityState: "unresolved", coreDestinations: [] }).executor, "unavailable");
  });
  await t("the core handles lead, commerce and call; 'call' is a valid route target", () => {
    assert.ok(CORE_DESTINATION_HANDLERS.commerce && CORE_DESTINATION_HANDLERS.call && CORE_DESTINATION_HANDLERS.lead);
    assert.ok(isRouteTarget("call"));
  });
  await t("adapters opt into exactly their core destination and family", () => {
    const ca = makeCommerceAdapter({ sourceKey: "commerce.woocommerce", resolveTenant: async () => null });
    const cl = makeCallAdapter({ sourceKey: "telephony.cloudtalk", resolveTenant: async () => null });
    assert.deepEqual([ca.families, ca.coreDestinations, cl.families, cl.coreDestinations], [["COMMERCE"], ["commerce"], ["CALL"], ["call"]]);
  });
  await t("every connection source has its own feature (seven sources, seven features)", () => {
    assert.equal(CONNECTION_SOURCE_KEYS.length, 7);
    assert.equal(new Set(CONNECTION_SOURCE_KEYS.map((s) => SOURCE_FEATURE[s])).size, 7);
  });

  console.log("-- ordering, buckets");
  await t("a stale delivery is never newer (sequence first, else provider time)", () => {
    const cur = { providerUpdatedAt: new Date("2026-10-06T10:05:00Z"), providerSequence: null };
    assert.equal(isNewerOrderState(cur, { providerUpdatedAt: new Date("2026-10-06T10:00:00Z"), providerSequence: null }), false);
    assert.equal(isNewerOrderState(cur, { providerUpdatedAt: new Date("2026-10-06T10:05:00Z"), providerSequence: null }), false);
    assert.equal(isNewerOrderState(cur, { providerUpdatedAt: new Date("2026-10-06T10:06:00Z"), providerSequence: null }), true);
    assert.equal(isNewerOrderState({ ...cur, providerSequence: 5 }, { providerUpdatedAt: new Date("2026-10-06T11:00:00Z"), providerSequence: 4 }), false);
  });
  await t("learning buckets are coarse and name nobody", () => {
    assert.deepEqual([totalBucket(0), totalBucket(9_999), totalBucket(10_000), totalBucket(250_000)], ["0", "<100", "100-499", "2000+"]);
    assert.deepEqual([durationBucket(0), durationBucket(45), durationBucket(900)], ["0", "31-120s", "10m+"]);
    assert.deepEqual([latencyBucket(5 * 60_000), latencyBucket(3 * 3_600_000), latencyBucket(2 * 86_400_000)], ["<15m", "1-4h", "1d+"]);
  });

  console.log("-- provider signatures (raw body, constant time)");
  await t("HMAC-SHA256 base64 (WooCommerce / Shopify): exact body + secret only", () => {
    const raw = '{"id":1042}';
    const sig = createHmac("sha256", "s3cret-s3cret-s3cret").update(raw).digest("base64");
    assert.ok(verifyHmacSha256Base64(raw, sig, "s3cret-s3cret-s3cret"));
    assert.ok(!verifyHmacSha256Base64(raw + " ", sig, "s3cret-s3cret-s3cret"));
    assert.ok(!verifyHmacSha256Base64(raw, sig, "other-secret-other"));
    assert.ok(!verifyHmacSha256Base64(raw, null, "s3cret-s3cret-s3cret"));
    assert.ok(!verifyHmacSha256Base64(raw, "not-base64", "s3cret-s3cret-s3cret"));
  });
  await t("Svix (CloudTalk): valid; wrong secret; tampered body; stale timestamp (replay) all refused", () => {
    const key = Buffer.from("0123456789abcdef0123456789abcdef");
    const secret = `whsec_${key.toString("base64")}`;
    const now = new Date("2026-10-06T12:00:00Z");
    const ts = String(Math.floor(now.getTime() / 1000));
    const raw = '{"call_id":"c1"}';
    const sig = createHmac("sha256", key).update(`msg_1.${ts}.${raw}`).digest("base64");
    const h = { id: "msg_1", timestamp: ts, signature: `v1,${sig}` };
    assert.ok(verifySvix(raw, h, secret, now));
    assert.ok(verifySvix(raw, { ...h, signature: `v1,AAAA v1,${sig}` }, secret, now), "any listed v1 signature");
    assert.ok(!verifySvix(raw, h, `whsec_${Buffer.from("ffffffffffffffffffffffffffffffff").toString("base64")}`, now));
    assert.ok(!verifySvix(raw + "x", h, secret, now));
    assert.ok(!verifySvix(raw, h, secret, new Date(now.getTime() + 10 * 60_000)));
    assert.ok(!verifySvix(raw, { ...h, id: "msg_2" }, secret, now));
  });

  console.log("-- Secretary");
  const NOW = new Date("2026-10-06T12:00:00Z");
  await t("CUSTOMER_CALLED: a missed call nobody returned outranks a message, sits below an overdue follow-up", () => {
    const base = { status: "OPEN" as const, nextFollowUpAt: null, createdAt: new Date("2026-10-01T09:00:00Z"), lastActivityAt: new Date("2026-10-05T09:00:00Z") };
    const called = evaluateLeadAttention({ ...base, lastUnreturnedCallAt: new Date("2026-10-06T08:00:00Z"), lastCustomerInboundAt: new Date("2026-10-06T08:30:00Z") }, NOW);
    assert.equal(called.reason, "CUSTOMER_CALLED");
    assert.equal(called.evidenceClass, "fact");
    assert.equal(called.nextAction.kind, "call_back");
    const overdue = evaluateLeadAttention({ ...base, nextFollowUpAt: new Date("2026-10-04T09:00:00Z"), lastUnreturnedCallAt: new Date("2026-10-06T08:00:00Z") }, NOW);
    assert.equal(overdue.reason, "FOLLOWUP_OVERDUE");
    assert.ok(overdue.priority > called.priority);
  });
  await t("lead activity recorded AFTER the missed call counts as handled; a call before the lead existed does not ask", () => {
    const base = { status: "OPEN" as const, nextFollowUpAt: null, createdAt: new Date("2026-10-01T09:00:00Z") };
    assert.notEqual(evaluateLeadAttention({ ...base, lastActivityAt: new Date("2026-10-06T09:00:00Z"), lastUnreturnedCallAt: new Date("2026-10-06T08:00:00Z") }, NOW).reason, "CUSTOMER_CALLED");
    assert.notEqual(evaluateLeadAttention({ ...base, createdAt: new Date("2026-10-06T10:00:00Z"), lastActivityAt: null, lastUnreturnedCallAt: new Date("2026-10-06T08:00:00Z") }, NOW).reason, "CUSTOMER_CALLED");
  });

  console.log("-- Meta hardening");
  await t("Meta permission errors: 10 and the whole 200–299 range", () => {
    assert.ok(isMetaPermissionCode(10) && isMetaPermissionCode(200) && isMetaPermissionCode(299));
    assert.ok(!isMetaPermissionCode(100) && !isMetaPermissionCode(190) && !isMetaPermissionCode(300));
  });
  await t("a SHORT-lived login token is exchanged for a long-lived one before any Page is read", async () => {
    process.env.META_APP_ID = "123";
    process.env.META_LEAD_ADS_APP_SECRET = "app-secret";
    const urls: string[] = [];
    setMetaCodeExchangeForTests(async (url) => {
      urls.push(url);
      return url.includes("grant_type=fb_exchange_token")
        ? { status: 200, json: { access_token: "LONG", expires_in: 5_184_000 } }
        : { status: 200, json: { access_token: "SHORT", expires_in: 3600 } };
    });
    assert.equal(await exchangeLoginCode("code-1"), "LONG");
    assert.equal(urls.length, 2);
    assert.ok(urls[1].includes("fb_exchange_token=SHORT"));
  });
  await t("a token without an expiry (system user) is used as is; a failed long-lived exchange REFUSES the connect", async () => {
    setMetaCodeExchangeForTests(async () => ({ status: 200, json: { access_token: "SYSTEM" } }));
    assert.equal(await exchangeLoginCode("code-2"), "SYSTEM");
    setMetaCodeExchangeForTests(async (url) =>
      url.includes("grant_type=fb_exchange_token") ? { status: 400, json: { error: { code: 1 } } } : { status: 200, json: { access_token: "SHORT", expires_in: 3600 } });
    await assert.rejects(exchangeLoginCode("code-3"), (e: unknown) => e instanceof MetaGraphError && e.code === "token_short_lived");
    setMetaCodeExchangeForTests(null);
  });

  console.log(`\nALL M7-A CORE TESTS PASSED — ${n} checks`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
