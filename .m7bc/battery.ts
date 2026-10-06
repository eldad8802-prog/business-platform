/**
 * M7-B / M7-C — WooCommerce, Wix, CloudTalk and Voicenter end to end on PostgreSQL 17 with the REAL M6 + M7-A
 * migrations, Production's RLS (replayed from the migrations) and a NOBYPASSRLS runtime, through the REAL
 * routes (owner API, connect flows, provider webhooks) and the REAL registered adapters + intake sweeper.
 *
 * The providers are in-process STAND-INS built from their official contracts (a WooCommerce store's REST API +
 * webhooks, Wix's OAuth / instance / orders search + JWT webhooks with a lab key pair, CloudTalk's Svix webhooks
 * + call history, Voicenter's CDR push). LAB-PROVEN — never REAL-PROVIDER-PROVEN (E17: a real business with
 * a real store / phone account).
 *
 * env: DATABASE_URL / DIRECT_URL = runtime, RUNTIME_URL, OWNER_URL, AUTH_TOKEN_SECRET,
 *      ACQUISITION_CREDENTIAL_ENCRYPTION_KEY. Synthetic credentials only; zero network.
 */
import { createHmac, createSign, generateKeyPairSync } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { signAuthToken } from "../lib/auth-token";
import { runIntakeSweep } from "../lib/intake/intake-sweeper";
import { setWooFetchForTests } from "../lib/intake/commerce/woocommerce";
import { setWixFetchForTests } from "../lib/intake/commerce/wix";
import { setCloudTalkFetchForTests } from "../lib/intake/calls/cloudtalk";
import { GET as ownerGET, POST as ownerPOST } from "../app/api/integrations/acquisition/route";
import { POST as ownerIdPOST } from "../app/api/integrations/acquisition/[id]/route";
import { POST as wooStartPOST } from "../app/api/integrations/commerce/woocommerce/route";
import { POST as wooCallbackPOST } from "../app/api/integrations/commerce/woocommerce/callback/route";
import { POST as wixConnectPOST } from "../app/api/integrations/commerce/wix/route";
import { POST as wooDeliveryPOST } from "../app/api/intake/commerce/woocommerce/[publicId]/route";
import { POST as wixDeliveryPOST } from "../app/api/intake/commerce/wix/route";
import { POST as ctDeliveryPOST } from "../app/api/intake/telephony/cloudtalk/[publicId]/route";
import { POST as vcDeliveryPOST } from "../app/api/intake/telephony/voicenter/[publicId]/[key]/route";
import { runWithTenantContext } from "../lib/tenant/context";
import { withTenantTransaction } from "../lib/tenant/transaction";
import { getLeadBriefing } from "../lib/services/crm/lead-briefing";
import { getCustomerCard } from "../lib/services/crm/customer-card.read-model";

const RUN = `m7bc-${Date.now()}`;
const ORIGIN = "https://lab.dubiz.test";
// Provider-side ids unique per run: other batteries may share the database, and a store / installation / account
// is live on ONE business at a time.
const U = String(Date.now()).slice(-7);
/** Fixture clock: the same order / call re-sent must be byte-identical (a real redelivery is). */
const T0 = Date.now();
const SHOP_A = `shop-a-${U}.lab.test`;
const INST_A = `inst-a-${U}`;
const INST_X = `inst-x-${U}`;
const CT_CO = Number(`7${U}`);
const CT_CO2 = CT_CO + 1;
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const o = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

// ── the Dubiz Wix app (lab key pair + secret) ─────────────────────────────────────────────────────
const wixKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const foreignKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.WIX_APP_ID = "lab-wix-app-id";
process.env.WIX_APP_SECRET = "lab-wix-app-secret-synthetic";
process.env.WIX_APP_PUBLIC_KEY = wixKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
process.env.WIX_APP_INSTALL_URL = "https://www.wix.com/installer/install?appId=lab-wix-app-id";

const b64u = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
function wixJwt(inner: Record<string, unknown>, instanceId: string, key = wixKeys.privateKey) {
  const h = b64u({ alg: "RS256", typ: "JWT" });
  const p = b64u({ data: JSON.stringify({ eventType: "wix.ecom.v1.order_updated", instanceId, data: JSON.stringify(inner) }), iat: Math.floor(Date.now() / 1000) });
  return `${h}.${p}.${createSign("RSA-SHA256").update(`${h}.${p}`).sign(key).toString("base64url")}`;
}
function signedInstance(instanceId: string, secret = process.env.WIX_APP_SECRET!) {
  const payload = b64u({ instanceId, signDate: new Date().toISOString() });
  return `${createHmac("sha256", secret).update(payload).digest("base64url")}.${payload}`;
}

// ── WooCommerce store stand-in ────────────────────────────────────────────────────────────────────
type Hook = { topic: string; delivery_url: string; secret: string; status: string };
type Store = { host: string; mode: "ok" | "unauthorized" | "down"; hooks: Map<string, Hook>; orders: Record<string, unknown>[]; deleted: string[] };
const stores = new Map<string, Store>();
let hookSeq = 100;
function store(host: string): Store {
  const s: Store = { host, mode: "ok", hooks: new Map(), orders: [], deleted: [] };
  stores.set(host, s);
  return s;
}
setWooFetchForTests(async (url, init) => {
  const u = new URL(url);
  const s = stores.get(u.host);
  if (!s || s.mode === "down") throw new Error("ECONNREFUSED");
  if (s.mode === "unauthorized") return { status: 401, json: { code: "woocommerce_rest_cannot_view" }, headers: {} };
  const path = u.pathname.replace(/^\/wp-json\/wc\/v3/, "");
  const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  if (path === "/webhooks" && init.method === "POST") {
    const id = String(++hookSeq);
    s.hooks.set(id, { topic: String(body.topic), delivery_url: String(body.delivery_url), secret: String(body.secret), status: "active" });
    return { status: 201, json: { id: Number(id) }, headers: {} };
  }
  const m = /^\/webhooks\/(\d+)$/.exec(path);
  if (m) {
    const h = s.hooks.get(m[1]);
    if (init.method === "DELETE") { if (h) { s.hooks.delete(m[1]); s.deleted.push(m[1]); } return { status: h ? 200 : 404, json: {}, headers: {} }; }
    if (!h) return { status: 404, json: { code: "woocommerce_rest_webhook_invalid_id" }, headers: {} };
    if (init.method === "PUT") h.status = String(body.status ?? h.status);
    return { status: 200, json: { id: Number(m[1]), status: h.status }, headers: {} };
  }
  if (path === "/orders" && init.method === "GET") {
    const after = new Date(`${u.searchParams.get("modified_after")}Z`).getTime();
    const rows = s.orders.filter((x) => new Date(`${x.date_modified_gmt}Z`).getTime() > after)
      .sort((a, b) => String(a.date_modified_gmt).localeCompare(String(b.date_modified_gmt)));
    const per = Number(u.searchParams.get("per_page") ?? "10");
    const page = Number(u.searchParams.get("page") ?? "1");
    return { status: 200, json: rows.slice((page - 1) * per, page * per), headers: { "x-wp-totalpages": String(Math.max(1, Math.ceil(rows.length / per))) } };
  }
  return { status: 404, json: {}, headers: {} };
});
const gmt = (offsetSec: number) => new Date(T0 + offsetSec * 1000).toISOString().slice(0, 19);
const wooOrder = (id: number, over: Record<string, unknown> = {}) => ({
  id, number: String(id), status: "processing", currency: "ILS", total: "259.00",
  date_created_gmt: gmt(-60), date_modified_gmt: gmt(-30), customer_id: 0,
  billing: { first_name: "Dana", last_name: "Buyer", phone: "052-710-0001", email: `buyer-${id}@lab.test` },
  line_items: [{ id: 1, product_id: 9, variation_id: 0, sku: "SKU-1", name: "Lamp", quantity: 1, total: "259.00" }],
  refunds: [], meta_data: [{ key: "_wc_order_attribution_utm_source", value: "google" }],
  ...over,
});

// ── Wix stand-in ──────────────────────────────────────────────────────────────────────────────────
type Install = { installed: boolean; siteName: string; orders: Record<string, unknown>[] };
const installs = new Map<string, Install>();
setWixFetchForTests(async (url, init) => {
  const u = new URL(url);
  if (u.pathname === "/oauth2/token") {
    const b = JSON.parse(init.body ?? "{}") as Record<string, string>;
    if (b.client_id !== process.env.WIX_APP_ID || b.client_secret !== process.env.WIX_APP_SECRET) return { status: 401, json: {} };
    const inst = installs.get(b.instance_id);
    if (!inst?.installed) return { status: 400, json: { error: "invalid_instance" } };
    return { status: 200, json: { access_token: `tok_${b.instance_id}`, expires_in: 14400 } };
  }
  const id = (init.headers.authorization ?? "").replace(/^tok_/, "");
  const inst = installs.get(id);
  if (!inst?.installed) return { status: 401, json: {} };
  if (u.pathname === "/apps/v1/instance") return { status: 200, json: { instance: { instanceId: id }, site: { siteDisplayName: inst.siteName } } };
  if (u.pathname === "/ecom/v1/orders/search") {
    const gt = (JSON.parse(init.body ?? "{}") as { search: { filter: { updatedDate: { $gt: string } } } }).search.filter.updatedDate.$gt;
    return { status: 200, json: { orders: inst.orders.filter((x) => String(x.updatedDate) > gt), metadata: { hasNext: false } } };
  }
  return { status: 404, json: {} };
});
const wixOrder = (id: string, over: Record<string, unknown> = {}) => ({
  id, number: "10001", status: "APPROVED", paymentStatus: "NOT_PAID", fulfillmentStatus: "NOT_FULFILLED", currency: "ILS",
  createdDate: new Date(T0 - 60_000).toISOString(), updatedDate: new Date(T0 - 30_000).toISOString(),
  priceSummary: { total: { amount: "120.00" } }, balanceSummary: { refunded: { amount: "0" } },
  buyerInfo: { email: `wix-${id}@lab.test`, contactId: `c-${id}` },
  billingInfo: { contactDetails: { firstName: "Wix", lastName: "Buyer", phone: "052-720-0001" } },
  lineItems: [{ id: "li-1", quantity: 1, price: { amount: "120.00" }, totalPriceAfterTax: { amount: "120.00" }, productName: { original: "Box" } }],
  ...over,
});

// ── CloudTalk stand-in (call history) ─────────────────────────────────────────────────────────────
const ctHistory = new Map<string, string>(); // call id → answered_at ("" = not answered)
const ctAuthSeen: string[] = [];
setCloudTalkFetchForTests(async (url, auth) => {
  ctAuthSeen.push(auth);
  const id = new URL(url).searchParams.get("call_id") ?? "";
  if (auth !== Buffer.from("LABKEYID1:LABKEYSECRET1").toString("base64")) return { status: 401, json: null };
  if (!ctHistory.has(id)) return { status: 200, json: { responseData: { data: [] } } };
  return { status: 200, json: { responseData: { data: [{ Cdr: { id, answered_at: ctHistory.get(id) } }] } } };
});

// ── request helpers ───────────────────────────────────────────────────────────────────────────────
const json = async (r: Response) => (await r.json().catch(() => ({}))) as Record<string, unknown>;
const owner = (userId: number) => ({ authorization: `Bearer ${signAuthToken(userId)}`, "content-type": "application/json" });
const req = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
  new NextRequest(`${ORIGIN}${path}`, { method: init.method ?? "POST", headers: init.headers, body: init.body });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

function sendWoo(st: Store, order: unknown, topic = "order.updated", opts: { secret?: string; source?: string; publicId?: string } = {}) {
  const hook = [...st.hooks.values()].find((h) => h.topic === topic) ?? [...st.hooks.values()][0];
  const publicId = opts.publicId ?? hook.delivery_url.split("/").pop()!;
  const raw = JSON.stringify(order);
  return wooDeliveryPOST(req(`/api/intake/commerce/woocommerce/${publicId}`, {
    headers: {
      "content-type": "application/json",
      "x-wc-webhook-topic": topic,
      "x-wc-webhook-source": opts.source ?? `https://${st.host}/`,
      "x-wc-webhook-signature": createHmac("sha256", opts.secret ?? hook.secret).update(raw).digest("base64"),
    },
    body: raw,
  }), params({ publicId }));
}
let svixSeq = 0;
function sendCloudTalk(publicId: string, secret: string, body: unknown, opts: { msgId?: string } = {}) {
  const raw = JSON.stringify(body);
  const id = opts.msgId ?? `msg_${RUN}_${++svixSeq}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = `v1,${createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64")}`;
  return ctDeliveryPOST(req(`/api/intake/telephony/cloudtalk/${publicId}`, {
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": ts, "svix-signature": sig }, body: raw,
  }), params({ publicId }));
}
const ctCall = (callId: string, company: number, over: Record<string, unknown> = {}) => ({
  event_id: `e-${callId}`, type: "call.ended", occurred_at: new Date(T0).toISOString(), company_id: company,
  data: {
    call_id: callId, direction: "incoming", external_number: "+972547300001",
    internal_number: { number_e164: "+97235550000", internal_name: "Sales line" },
    started_at: new Date(T0 - 120_000).toISOString(), ended_at: new Date(T0 - 60_000).toISOString(),
    duration: 60, talking_time: 41, is_voicemail: false, recording_url: "https://rec.lab.test/never",
    ...over,
  },
});
function sendVoicenter(publicId: string, key: string, cdr: Record<string, unknown>, form = false) {
  const body = form ? new URLSearchParams(Object.entries(cdr).map(([k, v]) => [k, String(v)])).toString() : JSON.stringify(cdr);
  return vcDeliveryPOST(req(`/api/intake/telephony/voicenter/${publicId}/${key}`, {
    headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" }, body,
  }), params({ publicId, key }));
}
const sweep = (offsetMs = 0) => runIntakeSweep({ now: new Date(Date.now() + offsetMs) });

async function enable(businessId: number, featureKey: string) {
  await o.businessFeatureAccess.upsert({
    where: { businessId_featureKey: { businessId, featureKey } },
    create: { businessId, featureKey, state: "ENABLED" },
    update: { state: "ENABLED" },
  });
}

async function main() {
  const A = await o.business.create({ data: { name: `${RUN}-A` } });
  const B = await o.business.create({ data: { name: `${RUN}-B` } });
  const C = await o.business.create({ data: { name: `${RUN}-C` } }); // nothing enabled
  for (const b of [A.id, B.id]) for (const f of ["commerce_woocommerce", "commerce_wix", "telephony_cloudtalk", "telephony_voicenter"]) await enable(b, f);
  const uA = await o.user.create({ data: { email: `${RUN}-a@lab.test`, password: "x", businessId: A.id, role: "USER" } });
  const uB = await o.user.create({ data: { email: `${RUN}-b@lab.test`, password: "x", businessId: B.id, role: "USER" } });
  const uC = await o.user.create({ data: { email: `${RUN}-c@lab.test`, password: "x", businessId: C.id, role: "USER" } });
  let leadsCreatedBySetup = 0;
  const baseline = {
    leads: await o.lead.count(), deals: await o.deal.count(), financial: await o.financialEvent.count(),
    billing: await o.billingDocument.count(), invSales: await o.inventorySale.count(), invExternal: await o.inventoryExternalSale.count(),
  };

  // ════════════════════════════════════════ WooCommerce ════════════════════════════════════════
  console.log("\n-- WooCommerce: owner connects with only the store address (start → store approval → callback) --");
  const shopA = store(SHOP_A);
  const start = await wooStartPOST(req("/api/integrations/commerce/woocommerce", { headers: owner(uA.id), body: JSON.stringify({ storeUrl: SHOP_A }) }));
  const startBody = await json(start);
  const authUrl = new URL(String(startBody.authorizeUrl));
  ok("start → the store's own approval page, scope read_write, our HTTPS callback", start.status === 200
    && authUrl.origin === `https://${SHOP_A}` && authUrl.pathname === "/wc-auth/v1/authorize" && authUrl.searchParams.get("scope") === "read_write"
    && authUrl.searchParams.get("callback_url") === `${ORIGIN}/api/integrations/commerce/woocommerce/callback`);
  const stateA = authUrl.searchParams.get("user_id")!;
  const sealedBody = Buffer.from(stateA.split(".")[1] ?? "", "base64url").toString("utf8");
  ok("the state is sealed: its payload (store, Dubiz origin) is not readable in the URL", !sealedBody.includes(SHOP_A) && !sealedBody.includes("lab.dubiz.test"));
  const keys = { consumer_key: `ck_${"a".repeat(40)}`, consumer_secret: `cs_${"b".repeat(40)}` };
  const forged = await wooCallbackPOST(req("/api/integrations/commerce/woocommerce/callback", { headers: { "content-type": "application/json" },
    body: JSON.stringify({ key_id: 1, user_id: stateA.replace(/^\d+\./, `${B.id}.`), ...keys, key_permissions: "read_write" }) }));
  ok("a state re-labelled for another business → 403 (sealed: AAD-bound)", forged.status === 403);
  const readOnly = await wooCallbackPOST(req("/api/integrations/commerce/woocommerce/callback", { headers: { "content-type": "application/json" },
    body: JSON.stringify({ key_id: 1, user_id: stateA, ...keys, key_permissions: "read" }) }));
  ok("keys with read-only permission → refused", readOnly.status === 403);
  const cb = await wooCallbackPOST(req("/api/integrations/commerce/woocommerce/callback", { headers: { "content-type": "application/json" },
    body: JSON.stringify({ key_id: 1, user_id: stateA, ...keys, key_permissions: "read_write" }) }));
  ok("the store's callback → exactly 200 (WooCommerce deletes the keys otherwise)", cb.status === 200, String(cb.status));
  const wooConnA = await o.acquisitionConnection.findFirst({ where: { businessId: A.id, sourceKey: "commerce.woocommerce", status: "ACTIVE" } });
  ok("one ACTIVE store connection in A, bound to the store host", !!wooConnA && wooConnA.externalResourceId === SHOP_A);
  ok("the store now has Dubiz's 3 order webhooks, each pointing at this connection's endpoint with a secret",
    shopA.hooks.size === 3 && [...shopA.hooks.values()].every((h) => h.delivery_url === `${ORIGIN}/api/intake/commerce/woocommerce/${wooConnA?.publicId}` && h.secret.length >= 16)
    && new Set([...shopA.hooks.values()].map((h) => h.topic)).size === 3);
  const listing = await json(await ownerGET(req("/api/integrations/acquisition", { method: "GET", headers: owner(uA.id) })));
  const listingText = JSON.stringify(listing);
  ok("the owner's listing shows the store, never its keys or the webhook secret",
    listingText.includes(SHOP_A) && !listingText.includes(keys.consumer_secret) && !listingText.includes(keys.consumer_key)
    && ![...shopA.hooks.values()].some((h) => listingText.includes(h.secret)));
  ok("the ciphertext at rest holds no plain key", !JSON.stringify(wooConnA).includes(keys.consumer_secret));

  const startB = await json(await wooStartPOST(req("/api/integrations/commerce/woocommerce", { headers: owner(uB.id), body: JSON.stringify({ storeUrl: `https://${SHOP_A}` }) })));
  const stealB = await wooCallbackPOST(req("/api/integrations/commerce/woocommerce/callback", { headers: { "content-type": "application/json" },
    body: JSON.stringify({ key_id: 2, user_id: new URL(String(startB.authorizeUrl)).searchParams.get("user_id"), consumer_key: `ck_${"c".repeat(40)}`, consumer_secret: `cs_${"d".repeat(40)}`, key_permissions: "read_write" }) }));
  ok("the SAME store connected by business B → 409 (one live mapping per store); A keeps it", stealB.status === 409
    && (await o.acquisitionConnection.count({ where: { businessId: B.id, sourceKey: "commerce.woocommerce", status: { not: "REVOKED" } } })) === 0);
  ok("business C (WooCommerce not enabled) cannot even start → 403",
    (await wooStartPOST(req("/api/integrations/commerce/woocommerce", { headers: owner(uC.id), body: JSON.stringify({ storeUrl: "shop-c.lab.test" }) }))).status === 403);
  ok("a non-HTTPS store address → 400",
    (await wooStartPOST(req("/api/integrations/commerce/woocommerce", { headers: owner(uA.id), body: JSON.stringify({ storeUrl: "http://shop-a.lab.test" }) }))).status === 400);

  console.log("\n-- WooCommerce: deliveries — ping, signature, store identity, duplicates, parallel, out of order --");
  const wooPub = wooConnA!.publicId;
  const ping = await wooDeliveryPOST(req(`/api/intake/commerce/woocommerce/${wooPub}`, { headers: { "content-type": "application/x-www-form-urlencoded" }, body: "webhook_id=101" }), params({ publicId: wooPub }));
  ok("the creation ping → exactly 200", ping.status === 200);
  const pingUnknown = await wooDeliveryPOST(req(`/api/intake/commerce/woocommerce/${"z".repeat(32)}`, { body: "webhook_id=101" }), params({ publicId: "z".repeat(32) }));
  ok("a ping to an endpoint that does not exist → 401", pingUnknown.status === 401);
  const d1 = await sendWoo(shopA, wooOrder(5001), "order.created");
  const o1 = await o.commerceOrder.findFirst({ where: { businessId: A.id, externalOrderId: "5001" }, include: { lines: true, events: true } });
  ok("order.created → 200 → ONE CommerceOrder in A (paid, ₪259.00 exact, its line, attribution kept)", d1.status === 200 && !!o1 && o1.status === "paid"
    && o1.totalMinor === 25_900 && o1.lines.length === 1 && (o1.attribution as { source?: string } | null)?.source === "google", JSON.stringify(o1?.attribution));
  ok("…its buyer is a Customer of A only", !!o1?.customerId && (await o.customer.findUnique({ where: { id: o1.customerId } }))?.businessId === A.id);
  await sendWoo(shopA, wooOrder(5001), "order.updated");
  await Promise.all(Array.from({ length: 6 }, () => sendWoo(shopA, wooOrder(5001), "order.updated")));
  ok("the same store state redelivered (and 6× in parallel) → one receipt, one order, one history row",
    (await o.intakeEvent.count({ where: { businessId: A.id, sourceKey: "commerce.woocommerce" } })) === 1
    && (await o.commerceOrderEvent.count({ where: { orderId: o1!.id } })) === 1);
  const later = wooOrder(5001, { status: "completed", date_modified_gmt: gmt(-5) });
  await sendWoo(shopA, later, "order.updated");
  await sendWoo(shopA, wooOrder(5001, { status: "processing", date_modified_gmt: gmt(-20) }), "order.updated");
  const o1b = await o.commerceOrder.findFirst({ where: { id: o1!.id }, include: { events: { orderBy: { id: "asc" } } } });
  ok("out of order: completed (newer) then a stale processing → stays fulfilled; the stale one is history, not applied",
    o1b?.status === "fulfilled" && o1b.events.length === 3 && o1b.events[2].applied === false, `${o1b?.status} ${o1b?.events.map((e) => `${e.kind}:${e.applied}`).join(",")}`);
  const refunded = await sendWoo(shopA, wooOrder(5001, { status: "completed", date_modified_gmt: gmt(-1), refunds: [{ id: 1, total: "-59.00" }] }), "order.updated");
  ok("a partial refund (negative string) → partially_refunded, refundedMinor exact", refunded.status === 200
    && (await o.commerceOrder.findFirst({ where: { id: o1!.id } }))?.refundedMinor === 5_900);

  console.log("\n-- Secretary + customer card: exceptions only, order history on the card --");
  const asA = <T,>(fn: (tx: Parameters<Parameters<typeof withTenantTransaction>[0]>[0]) => Promise<T>) =>
    runWithTenantContext({ businessId: A.id }, () => withTenantTransaction(fn));
  const b0 = await asA((tx) => getLeadBriefing(tx, A.id));
  ok("orders alone raise NO Secretary item (business as usual)", b0.commerce?.reversals.total === 0 && b0.commerce.connections.length === 0, JSON.stringify(b0.commerce));
  // The owner's own lead for this buyer (setup, not intake): the refund above now concerns an open deal.
  const ownerLead = await o.lead.create({ data: { businessId: A.id, customerName: "Dana Buyer", customerId: o1!.customerId!, status: "OPEN" } });
  leadsCreatedBySetup += 1;
  const b1 = await asA((tx) => getLeadBriefing(tx, A.id));
  ok("a refund on a customer with an OPEN lead → one exception naming that lead (kind + time, no amount, no name)",
    b1.commerce?.reversals.total === 1 && b1.commerce.reversals.items[0]?.leadId === ownerLead.id && b1.commerce.reversals.items[0]?.kind === "refunded"
    && !/Dana|25900|5900|052/.test(JSON.stringify(b1.commerce)), JSON.stringify(b1.commerce));
  const card = await asA((tx) => getCustomerCard({ businessId: A.id, customerId: o1!.customerId! }, { tx }));
  ok("the customer card shows the store order history (status, total, refund) — and counts it as activity",
    card.orders.total >= 1 && card.orders.items[0]?.status === "partially_refunded" && card.orders.items[0]?.refundedMinor === 5_900 && card.activity.hasAnyActivity);
  ok("B cannot read A's customer card", await runWithTenantContext({ businessId: B.id }, () => withTenantTransaction((tx) =>
    getCustomerCard({ businessId: B.id, customerId: o1!.customerId! }, { tx }))).then(() => false, () => true));

  const before = await o.intakeEvent.count();
  const hook = [...shopA.hooks.values()][0];
  ok("a delivery signed with the wrong secret → 401", (await sendWoo(shopA, wooOrder(5002), "order.created", { secret: "not-the-secret-0123456789" })).status === 401);
  ok("a correctly signed delivery from ANOTHER store host → 401", (await sendWoo(shopA, wooOrder(5002), "order.created", { source: "https://evil.lab.test/" })).status === 401);
  ok("a delivery to an unknown endpoint → 401", (await sendWoo(shopA, wooOrder(5002), "order.created", { publicId: "y".repeat(32), secret: hook.secret })).status === 401);
  ok("order.deleted (trash, {id} only) → 200, nothing written", (await sendWoo(shopA, { id: 5001 }, "order.deleted")).status === 200);
  ok("a checkout draft → 200, nothing written", (await sendWoo(shopA, wooOrder(5003, { status: "checkout-draft" }), "order.created")).status === 200);
  ok("authenticated but not an order → 400", (await sendWoo(shopA, wooOrder(5004, { currency: "nope" }), "order.created")).status === 400);
  ok("none of the above recorded a receipt", (await o.intakeEvent.count()) === before);
  ok("a body naming another business changes nothing: the tenant is the endpoint",
    (await sendWoo(shopA, wooOrder(5005, { businessId: B.id }), "order.created")).status === 200
    && (await o.commerceOrder.count({ where: { businessId: B.id } })) === 0 && (await o.commerceOrder.count({ where: { businessId: A.id, externalOrderId: "5005" } })) === 1);

  console.log("\n-- WooCommerce: reconciliation (no retries) — missed orders, disabled / deleted webhooks, revoked keys --");
  shopA.orders.push(wooOrder(5010, { date_modified_gmt: gmt(60) }), wooOrder(5011, { status: "checkout-draft", date_modified_gmt: gmt(70) }));
  const disabledId = [...shopA.hooks.keys()][0];
  shopA.hooks.get(disabledId)!.status = "disabled";
  const s1 = await sweep();
  ok("the sweep recovers an order no webhook delivered (5010), skips the draft", (await o.commerceOrder.count({ where: { businessId: A.id, externalOrderId: "5010" } })) === 1
    && (await o.commerceOrder.count({ where: { businessId: A.id, externalOrderId: "5011" } })) === 0, JSON.stringify(s1.commerce));
  ok("…and re-activates the webhook WooCommerce disabled", shopA.hooks.get(disabledId)?.status === "active" && s1.commerce.webhooksReactivated >= 1);
  const s2 = await sweep();
  ok("a second sweep finds nothing new (the poller and the webhook are the same receipts)", s2.commerce.receipts === 0
    && (await o.intakeEvent.count({ where: { businessId: A.id, sourceKey: "commerce.woocommerce", externalEventId: { not: "" } } })) === (await o.intakeEvent.count({ where: { businessId: A.id, sourceKey: "commerce.woocommerce" } })));
  ok("the webhook-delivered order seen again by the poller is NOT a second receipt", (await o.commerceOrder.count({ where: { businessId: A.id, externalOrderId: "5010" } })) === 1);
  const goneId = [...shopA.hooks.keys()][1];
  shopA.hooks.delete(goneId);
  await sweep();
  ok("a webhook deleted in the store → the set is replaced (exactly 3 again, the survivors removed — no double delivery)",
    shopA.hooks.size === 3 && !shopA.hooks.has(goneId) && [...shopA.hooks.keys()].every((k) => Number(k) > Number(goneId)), [...shopA.hooks.keys()].join(","));
  shopA.mode = "down";
  await sweep();
  ok("a store that is merely DOWN stays ACTIVE (its webhooks must keep delivering)", (await o.acquisitionConnection.findFirst({ where: { id: wooConnA!.id } }))?.status === "ACTIVE");
  shopA.mode = "unauthorized";
  await sweep();
  const revokedKeys = await o.acquisitionConnection.findFirst({ where: { id: wooConnA!.id } });
  ok("keys revoked in the store → ERROR + WOO_KEYS_REVOKED for the owner", revokedKeys?.status === "ERROR" && revokedKeys.lastErrorCode === "WOO_KEYS_REVOKED");
  const bRev = await runWithTenantContext({ businessId: A.id }, () => withTenantTransaction((tx) => getLeadBriefing(tx, A.id)));
  ok("…and the Secretary surfaces the connection to fix (with its code)",
    bRev.commerce?.connections.length === 1 && bRev.commerce.connections[0].code === "WOO_KEYS_REVOKED", JSON.stringify(bRev.commerce?.connections));
  shopA.mode = "ok";
  shopA.orders.push(wooOrder(5012, { date_modified_gmt: gmt(90) }));
  const s5 = await sweep();
  ok("the store answering again → ACTIVE again, and the order changed meanwhile is recovered",
    (await o.acquisitionConnection.findFirst({ where: { id: wooConnA!.id } }))?.status === "ACTIVE" && (await o.commerceOrder.count({ where: { businessId: A.id, externalOrderId: "5012" } })) === 1, JSON.stringify(s5));

  console.log("\n-- WooCommerce: owner disconnects --");
  const oldHooks = [...shopA.hooks.keys()];
  const rev = await ownerIdPOST(req(`/api/integrations/acquisition/${wooConnA!.id}`, { headers: owner(uA.id), body: JSON.stringify({ action: "revoke" }) }), params({ id: String(wooConnA!.id) }));
  ok("revoke → 200; Dubiz's webhooks are removed from the store", rev.status === 200 && shopA.hooks.size === 0 && oldHooks.every((k) => shopA.deleted.includes(k)));
  ok("a delivery to the revoked endpoint → 401", (await wooDeliveryPOST(req(`/api/intake/commerce/woocommerce/${wooPub}`, {
    headers: { "x-wc-webhook-topic": "order.updated", "x-wc-webhook-source": `https://${SHOP_A}/`, "x-wc-webhook-signature": "x" }, body: JSON.stringify(wooOrder(5013)) }), params({ publicId: wooPub }))).status === 401);
  ok("the orders already recorded stay (an order is history, never deleted by a disconnect)", (await o.commerceOrder.count({ where: { businessId: A.id } })) >= 4);
  ok("another business's owner cannot act on A's connection (404)",
    (await ownerIdPOST(req(`/api/integrations/acquisition/${wooConnA!.id}`, { headers: owner(uB.id), body: JSON.stringify({ action: "resume" }) }), params({ id: String(wooConnA!.id) }))).status === 404);

  // ════════════════════════════════════════ Wix ════════════════════════════════════════
  console.log("\n-- Wix: the owner installs the Dubiz app and confirms (signed instance only) --");
  installs.set(INST_A, { installed: true, siteName: "Shop A on Wix", orders: [] });
  installs.set(INST_X, { installed: false, siteName: "Not installed", orders: [] });
  const wixListing = await json(await ownerGET(req("/api/integrations/acquisition", { method: "GET", headers: owner(uA.id) })));
  ok("the owner sees Wix as connectable, with the app's install link", (wixListing.wix as { available?: boolean })?.available === true);
  const bare = await wixConnectPOST(req("/api/integrations/commerce/wix", { headers: owner(uA.id), body: JSON.stringify({ instance: INST_A }) }));
  ok("a bare instance id (not signed by Wix) → 400, nothing bound", bare.status === 400 && (await o.acquisitionConnection.count({ where: { sourceKey: "commerce.wix" } })) === 0);
  const forgedSig = await wixConnectPOST(req("/api/integrations/commerce/wix", { headers: owner(uA.id), body: JSON.stringify({ instance: signedInstance(INST_A, "another-app-secret") }) }));
  ok("an instance signed with another secret → 400", forgedSig.status === 400);
  const notInst = await wixConnectPOST(req("/api/integrations/commerce/wix", { headers: owner(uA.id), body: JSON.stringify({ instance: signedInstance(INST_X) }) }));
  ok("a signed instance whose app is not installed → 400 app_not_installed", notInst.status === 400 && (await json(notInst)).error === "app_not_installed");
  const wixOk = await wixConnectPOST(req("/api/integrations/commerce/wix", { headers: owner(uA.id), body: JSON.stringify({ instance: signedInstance(INST_A) }) }));
  const wixConnA = await o.acquisitionConnection.findFirst({ where: { businessId: A.id, sourceKey: "commerce.wix", status: "ACTIVE" } });
  ok("the signed, installed instance → 201, bound to A (instance id + site name)", wixOk.status === 201 && wixConnA?.externalResourceId === INST_A && wixConnA.label === "Shop A on Wix");
  ok("the same installation claimed by B → 409", (await wixConnectPOST(req("/api/integrations/commerce/wix", { headers: owner(uB.id), body: JSON.stringify({ instance: signedInstance(INST_A) }) }))).status === 409);
  ok("C (Wix not enabled) → 403", (await wixConnectPOST(req("/api/integrations/commerce/wix", { headers: owner(uC.id), body: JSON.stringify({ instance: signedInstance(INST_A) }) }))).status === 403);

  console.log("\n-- Wix: webhook JWTs — signature, unknown installation, duplicates, retries out of order --");
  const wixSend = (inner: Record<string, unknown>, instance = INST_A, key = wixKeys.privateKey) =>
    wixDeliveryPOST(req("/api/intake/commerce/wix", { headers: { "content-type": "text/plain" }, body: wixJwt(inner, instance, key) }));
  const w1 = await wixSend({ id: "evt-1", entityFqdn: "wix.ecom.v1.order", slug: "created", entityEventSequence: 1, createdEvent: { entity: wixOrder("w-1") } });
  const ow1 = await o.commerceOrder.findFirst({ where: { businessId: A.id, sourceKey: "commerce.wix", externalOrderId: "w-1" } });
  ok("order_created → 200 → one CommerceOrder in A (placed, ₪120.00)", w1.status === 200 && ow1?.status === "placed" && ow1.totalMinor === 12_000);
  await Promise.all(Array.from({ length: 4 }, () => wixSend({ id: "evt-1", entityFqdn: "wix.ecom.v1.order", slug: "created", entityEventSequence: 1, createdEvent: { entity: wixOrder("w-1") } })));
  ok("Wix's retries of the same event (4× in parallel) → one receipt", (await o.intakeEvent.count({ where: { businessId: A.id, sourceKey: "commerce.wix" } })) === 1);
  await wixSend({ id: "evt-3", entityFqdn: "wix.ecom.v1.order", slug: "updated", entityEventSequence: 3, updatedEvent: { currentEntity: wixOrder("w-1", { paymentStatus: "PAID", fulfillmentStatus: "FULFILLED", updatedDate: new Date(T0 - 5_000).toISOString() }) } });
  await wixSend({ id: "evt-2", entityFqdn: "wix.ecom.v1.order", slug: "updated", entityEventSequence: 2, updatedEvent: { currentEntity: wixOrder("w-1", { paymentStatus: "PAID", updatedDate: new Date(T0 - 10_000).toISOString() }) } });
  const ow1b = await o.commerceOrder.findFirst({ where: { id: ow1!.id }, include: { events: { orderBy: { id: "asc" } } } });
  ok("sequence 3 (fulfilled) then a late sequence 2 (paid) → stays fulfilled; the late one kept, not applied",
    ow1b?.status === "fulfilled" && ow1b.events.length === 3 && ow1b.events[2].applied === false, `${ow1b?.status} ${ow1b?.events.map((e) => e.applied).join(",")}`);
  const wBefore = await o.intakeEvent.count();
  ok("a JWT signed with another key → 401", (await wixSend({ id: "evt-9", entityFqdn: "wix.ecom.v1.order", slug: "created", createdEvent: { entity: wixOrder("w-9") } }, INST_A, foreignKeys.privateKey)).status === 401);
  ok("an installation nobody connected → 200, skipped", (await wixSend({ id: "evt-8", entityFqdn: "wix.ecom.v1.order", slug: "created", createdEvent: { entity: wixOrder("w-8") } }, "inst-unknown-77")).status === 200);
  ok("a non-order event → 200, skipped", (await wixSend({ id: "evt-7", entityFqdn: "wix.stores.v1.product", slug: "updated" })).status === 200);
  ok("an INITIALIZED (not yet placed) order → 200, skipped", (await wixSend({ id: "evt-6", entityFqdn: "wix.ecom.v1.order", slug: "created", createdEvent: { entity: wixOrder("w-6", { status: "INITIALIZED" }) } })).status === 200);
  ok("none of those recorded anything", (await o.intakeEvent.count()) === wBefore);

  console.log("\n-- Wix: reconciliation and uninstall --");
  installs.get(INST_A)!.orders.push(wixOrder("w-2", { updatedDate: new Date(Date.now() + 60_000).toISOString() }));
  await sweep();
  ok("an order Wix never delivered is recovered by the periodic search", (await o.commerceOrder.count({ where: { businessId: A.id, sourceKey: "commerce.wix", externalOrderId: "w-2" } })) === 1);
  installs.get(INST_A)!.installed = false;
  await sweep();
  const wixGone = await o.acquisitionConnection.findFirst({ where: { id: wixConnA!.id } });
  ok("the app uninstalled → ERROR + WIX_APP_UNINSTALLED for the owner", wixGone?.status === "ERROR" && wixGone.lastErrorCode === "WIX_APP_UNINSTALLED");
  ok("…a delivery for it is still recorded (in ERROR, Wix's own retries are not lost)",
    (await wixSend({ id: "evt-10", entityFqdn: "wix.ecom.v1.order", slug: "created", createdEvent: { entity: wixOrder("w-10") } })).status === 200
    && (await o.commerceOrder.count({ where: { businessId: A.id, externalOrderId: "w-10" } })) === 1);
  const savedKey = process.env.WIX_APP_PUBLIC_KEY;
  delete process.env.WIX_APP_PUBLIC_KEY;
  ok("the Wix app not configured → webhook 503 (Wix retries) and the owner sees Wix unavailable",
    (await wixSend({ id: "evt-11", entityFqdn: "wix.ecom.v1.order", slug: "created" })).status === 503
    && ((await json(await ownerGET(req("/api/integrations/acquisition", { method: "GET", headers: owner(uA.id) })))).wix as { available?: boolean })?.available === false);
  process.env.WIX_APP_PUBLIC_KEY = savedKey;

  // ════════════════════════════════════════ CloudTalk ════════════════════════════════════════
  console.log("\n-- CloudTalk: owner creates the endpoint, then saves CloudTalk's signing secret + API key --");
  const ctCreate = await ownerPOST(req("/api/integrations/acquisition", { headers: owner(uA.id), body: JSON.stringify({ sourceKey: "telephony.cloudtalk" }) }));
  const ctConn = (await json(ctCreate)).connection as { id: number; publicId: string; endpointUrl: string };
  ok("create → 201 with the endpoint address to paste into CloudTalk", ctCreate.status === 201 && ctConn.endpointUrl === `${ORIGIN}/api/intake/telephony/cloudtalk/${ctConn.publicId}`);
  const whsec = `whsec_${Buffer.from(`${RUN}-cloudtalk-secret-0123456789`).toString("base64")}`;
  ok("before the secret is saved, deliveries are refused (fail closed) → 401", (await sendCloudTalk(ctConn.publicId, whsec, ctCall("c-1", CT_CO))).status === 401);
  const setBad = await ownerIdPOST(req(`/api/integrations/acquisition/${ctConn.id}`, { headers: owner(uA.id), body: JSON.stringify({ action: "set_credentials", signingSecret: "not-a-whsec" }) }), params({ id: String(ctConn.id) }));
  ok("a malformed signing secret → 400", setBad.status === 400);
  const setSec = await ownerIdPOST(req(`/api/integrations/acquisition/${ctConn.id}`, { headers: owner(uA.id), body: JSON.stringify({ action: "set_credentials", signingSecret: whsec }) }), params({ id: String(ctConn.id) }));
  const setSecBody = await json(setSec);
  ok("the secret saved → only flags come back (signing secret ✓, API key ✗), never the value", setSec.status === 200
    && JSON.stringify(setSecBody.setup) === JSON.stringify({ signingSecret: true, apiKey: false }) && !JSON.stringify(setSecBody).includes(whsec));
  ok("another business's owner cannot set A's credentials (404)",
    (await ownerIdPOST(req(`/api/integrations/acquisition/${ctConn.id}`, { headers: owner(uB.id), body: JSON.stringify({ action: "set_credentials", signingSecret: whsec }) }), params({ id: String(ctConn.id) }))).status === 404);

  console.log("\n-- CloudTalk: call.ended → a reference; the outcome from call history (never guessed) --");
  const c1 = await sendCloudTalk(ctConn.publicId, whsec, ctCall("c-1", CT_CO));
  ok("a signed call.ended → 200, the CloudTalk account is bound to the connection", c1.status === 200
    && (await o.acquisitionConnection.findFirst({ where: { id: ctConn.id } }))?.externalResourceId === String(CT_CO));
  ok("without the API key the call WAITS — no CallActivity with a guessed outcome", (await o.callActivity.count({ where: { businessId: A.id, sourceKey: "telephony.cloudtalk" } })) === 0);
  await sendCloudTalk(ctConn.publicId, whsec, ctCall("c-1", CT_CO));
  await Promise.all(Array.from({ length: 5 }, () => sendCloudTalk(ctConn.publicId, whsec, ctCall("c-1", CT_CO))));
  ok("Svix retries of the same call (new message ids, 5× in parallel) → one receipt", (await o.intakeEvent.count({ where: { businessId: A.id, sourceKey: "telephony.cloudtalk" } })) === 1);
  ok("a delivery from ANOTHER CloudTalk account on this endpoint → 401", (await sendCloudTalk(ctConn.publicId, whsec, ctCall("c-2", CT_CO2))).status === 401);
  ok("a stale / tampered signature → 401", (await ctDeliveryPOST(req(`/api/intake/telephony/cloudtalk/${ctConn.publicId}`, {
    headers: { "svix-id": "msg_x", "svix-timestamp": String(Math.floor(Date.now() / 1000) - 3600), "svix-signature": "v1,AAAA" }, body: JSON.stringify(ctCall("c-3", CT_CO)) }), params({ publicId: ctConn.publicId }))).status === 401);
  ok("an internal call / another event type → 200, nothing recorded",
    (await sendCloudTalk(ctConn.publicId, whsec, ctCall("c-4", CT_CO, { direction: "internal" }))).status === 200
    && (await sendCloudTalk(ctConn.publicId, whsec, { ...ctCall("c-5", CT_CO), type: "call.started" })).status === 200
    && (await o.intakeEvent.count({ where: { businessId: A.id, sourceKey: "telephony.cloudtalk" } })) === 1);
  const ctB = (await json(await ownerPOST(req("/api/integrations/acquisition", { headers: owner(uB.id), body: JSON.stringify({ sourceKey: "telephony.cloudtalk" }) })))).connection as { id: number; publicId: string };
  const whsecB = `whsec_${Buffer.from(`${RUN}-cloudtalk-B-0123456789`).toString("base64")}`;
  await ownerIdPOST(req(`/api/integrations/acquisition/${ctB.id}`, { headers: owner(uB.id), body: JSON.stringify({ action: "set_credentials", signingSecret: whsecB }) }), params({ id: String(ctB.id) }));
  ok("B's endpoint receiving A's CloudTalk account (live on A) → 401, nothing in B",
    (await sendCloudTalk(ctB.publicId, whsecB, ctCall("c-6", CT_CO))).status === 401 && (await o.intakeEvent.count({ where: { businessId: B.id, sourceKey: "telephony.cloudtalk" } })) === 0);

  ctHistory.set("c-1", "");
  await ownerIdPOST(req(`/api/integrations/acquisition/${ctConn.id}`, { headers: owner(uA.id), body: JSON.stringify({ action: "set_credentials", apiKeyId: "WRONGKEY1", apiKeySecret: "WRONGSECRET1" }) }), params({ id: String(ctConn.id) }));
  await sweep(7 * 3_600_000);
  ok("a WRONG API key → still waiting (deferred), still no guessed call", (await o.callActivity.count({ where: { businessId: A.id, sourceKey: "telephony.cloudtalk" } })) === 0);
  await ownerIdPOST(req(`/api/integrations/acquisition/${ctConn.id}`, { headers: owner(uA.id), body: JSON.stringify({ action: "set_credentials", apiKeyId: "LABKEYID1", apiKeySecret: "LABKEYSECRET1" }) }), params({ id: String(ctConn.id) }));
  await sweep(14 * 3_600_000);
  const ca1 = await o.callActivity.findFirst({ where: { businessId: A.id, sourceKey: "telephony.cloudtalk", providerCallId: "c-1" } });
  ok("with the right key → the call is recorded MISSED (no answered_at in CloudTalk's history), 0 s", ca1?.outcome === "missed" && ca1.durationSec === 0, ca1?.outcome);
  ok("…an unknown caller: callerState unknown, a hash, NO Customer, NO Lead", ca1?.callerState === "unknown" && !!ca1.callerHash && ca1.customerId === null && ca1.leadId === null);
  ok("…the business line kept; the recording URL never stored", ca1?.businessLine === "97235550000"
    && !JSON.stringify(await o.intakeEvent.findMany({ where: { businessId: A.id, sourceKey: "telephony.cloudtalk" } })).includes("rec.lab.test"));
  const norm = await o.intakeNormalizedEvent.findFirst({ where: { businessId: A.id, intakeEvent: { sourceKey: "telephony.cloudtalk" } } });
  ok("…routed by R9 (CALL), and labelled by its line name for attribution", norm?.routingRule === "R9_CALL"
    && JSON.stringify(norm?.attribution ?? {}).includes("line:Sales line"), `${norm?.routingRule} ${JSON.stringify(norm?.attribution)}`);
  ok("the API key went in the Authorization header (Basic), never a URL", ctAuthSeen.includes(Buffer.from("LABKEYID1:LABKEYSECRET1").toString("base64")));
  ctHistory.set("c-7", "2026-10-06 09:00:05");
  await sendCloudTalk(ctConn.publicId, whsec, ctCall("c-7", CT_CO));
  const ca7 = await o.callActivity.findFirst({ where: { businessId: A.id, providerCallId: "c-7" } });
  ok("an answered call (answered_at present) → answered, talking time as duration", ca7?.outcome === "answered" && ca7.durationSec === 41, `${ca7?.outcome} ${ca7?.durationSec}`);
  const ctListing = JSON.stringify(await json(await ownerGET(req("/api/integrations/acquisition", { method: "GET", headers: owner(uA.id) }))));
  ok("the owner's listing shows CloudTalk as fully set up, with no secret or key in it",
    ctListing.includes('"setup":{"signingSecret":true,"apiKey":true}') && !ctListing.includes(whsec) && !ctListing.includes("LABKEYSECRET1"));

  // ════════════════════════════════════════ Voicenter ════════════════════════════════════════
  console.log("\n-- Voicenter: keyed CDR address (no documented signature) --");
  const vcCreate = await ownerPOST(req("/api/integrations/acquisition", { headers: owner(uA.id), body: JSON.stringify({ sourceKey: "telephony.voicenter" }) }));
  const vcBody = await json(vcCreate);
  const vcUrl = String((vcBody.connection as { endpointUrl: string }).endpointUrl);
  const [, vcPub, vcKey] = /\/voicenter\/([^/]+)\/([^/]+)$/.exec(vcUrl) ?? [];
  ok("create → 201, the full CDR address (with its key) shown ONCE", vcCreate.status === 201 && !!vcKey && vcKey === vcBody.key && !vcUrl.includes("<key>"));
  const vcStored = await o.acquisitionConnection.findFirst({ where: { publicId: vcPub } });
  ok("only the key's hash is stored", !!vcStored && vcStored.keyHash !== vcKey && !JSON.stringify(vcStored).includes(vcKey));
  const cdr = (id: string, over: Record<string, unknown> = {}) => ({
    ivruniqueid: id, direction: "incoming", type: "incoming", status: "NOANSWER", isAnswer: 0, time: Math.floor(T0 / 1000) - 300,
    duration: 0, did: "035550001", caller: "0547300002", callerPhone: "0547300002", target: "201", record: "https://rec.lab.test/v.mp3", ...over,
  });
  const v1 = await sendVoicenter(vcPub, vcKey, cdr("v-1"));
  ok("a CDR → 200 {Err:0} → a MISSED inbound call in A", v1.status === 200 && (await json(v1)).Err === 0
    && (await o.callActivity.findFirst({ where: { businessId: A.id, sourceKey: "telephony.voicenter", providerCallId: "v-1" } }))?.outcome === "missed");
  await sendVoicenter(vcPub, vcKey, cdr("v-1"), true);
  await Promise.all(Array.from({ length: 4 }, () => sendVoicenter(vcPub, vcKey, cdr("v-1"))));
  ok("the same CDR re-sent (JSON and form, 4× in parallel) → one receipt, one call", (await o.intakeEvent.count({ where: { businessId: A.id, sourceKey: "telephony.voicenter" } })) === 1
    && (await o.callActivity.count({ where: { businessId: A.id, sourceKey: "telephony.voicenter" } })) === 1);
  await sendVoicenter(vcPub, vcKey, cdr("v-2", { direction: "outgoing", type: "outgoing", caller: "035550001", target: "0547300002", status: "ANSWER", isAnswer: 1, actualCallDuration: 33, time: Math.floor(T0 / 1000) - 60 }));
  const v1r = await o.callActivity.findFirst({ where: { businessId: A.id, providerCallId: "v-1" } });
  ok("the business calling the number back (answered) → the missed call is RETURNED (outbound_call)", !!v1r?.returnedAt && v1r.returnedVia === "outbound_call");
  const wrongKey = await sendVoicenter(vcPub, "dvk_" + "0".repeat(43), cdr("v-3"));
  ok("a wrong key → 401 {Err:2}", wrongKey.status === 401 && (await json(wrongKey)).Err === 2);
  await ownerIdPOST(req(`/api/integrations/acquisition/${vcStored!.id}`, { headers: owner(uA.id), body: JSON.stringify({ action: "pause" }) }), params({ id: String(vcStored!.id) }));
  ok("paused by the owner → 401", (await sendVoicenter(vcPub, vcKey, cdr("v-4"))).status === 401);
  ok("C (Voicenter not enabled) cannot create an endpoint → 403",
    (await ownerPOST(req("/api/integrations/acquisition", { headers: owner(uC.id), body: JSON.stringify({ sourceKey: "telephony.voicenter" }) }))).status === 403);

  // ════════════════════════════════════════ invariants ════════════════════════════════════════
  console.log("\n-- invariants: Order ≠ Lead, Call ≠ Lead; no money, documents or stock; tenancy --");
  ok("ZERO Leads (beyond the owner's one setup lead), Deals, FinancialEvents, BillingDocuments, inventory sales created by any of the above",
    (await o.lead.count()) === baseline.leads + leadsCreatedBySetup && (await o.deal.count()) === baseline.deals && (await o.financialEvent.count()) === baseline.financial
    && (await o.billingDocument.count()) === baseline.billing && (await o.inventorySale.count()) === baseline.invSales && (await o.inventoryExternalSale.count()) === baseline.invExternal);
  ok("B holds no order, no call, no receipt of A's providers", (await o.commerceOrder.count({ where: { businessId: B.id } })) === 0
    && (await o.callActivity.count({ where: { businessId: B.id } })) === 0 && (await o.intakeEvent.count({ where: { businessId: B.id } })) === 0);
  ok("C (nothing enabled) holds nothing", (await o.intakeEvent.count({ where: { businessId: C.id } })) === 0 && (await o.acquisitionConnection.count({ where: { businessId: C.id } })) === 0);
  const sensors = await o.learningEvent.findMany({ where: { businessId: A.id }, select: { eventType: true, payload: true } });
  ok("A learned from its orders and calls (M7 sensors written)", ["COMMERCE_ORDER_RECORDED", "CALL_RECORDED", "MISSED_CALL_RETURNED"].every((k) => sensors.some((x) => x.eventType === k)), [...new Set(sensors.map((x) => x.eventType))].join(","));
  ok("no phone, email, name or product title in any learning signal of A", !/7100001|7200001|7300001|7300002|@lab\.test|Dana|Buyer|Lamp|Box/.test(JSON.stringify(sensors)));

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("M7-B/C BATTERY: FAILED\n  " + failures.join("\n  "));
    process.exitCode = 1;
  } else {
    console.log("M7-B/C BATTERY: ALL PASS (LAB-PROVEN; providers simulated — not REAL-PROVIDER-PROVEN)");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await o.$disconnect();
  });
