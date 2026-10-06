/**
 * M7-A — commerce + telephony foundation and the Meta Lead Ads hardening, end to end on PostgreSQL 17
 * with the REAL M6 + M7-A migrations, Production's RLS (replayed from the migrations) and a
 * NOBYPASSRLS runtime (the app code runs as the runtime; the owner only sets up and inspects).
 *
 * The commerce / telephony "providers" here are LAB REFERENCE ADAPTERS (simulators) built with the
 * real factories: they prove the M7-A core — authenticated delivery, durable receipt, M4 identity,
 * the core R5 / R9 destinations, tenancy, idempotency, the Secretary, learning — and NEVER a real
 * provider (that is REAL-PROVIDER-PROVEN, M7-B / M7-C, with a real business).
 *
 * env: DATABASE_URL / DIRECT_URL = runtime, RUNTIME_URL, OWNER_URL, META_LEAD_ADS_APP_SECRET,
 *      META_LEAD_ADS_VERIFY_TOKEN, ACQUISITION_CREDENTIAL_ENCRYPTION_KEY.
 */
import { createHmac } from "node:crypto";
import { PrismaClient, Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { runTenantJob } from "../lib/tenant/job";
import { runWithTenantContext } from "../lib/tenant/context";
import { withTenantTransaction } from "../lib/tenant/transaction";
import { acceptIntake, drainIntake } from "../lib/intake/core/processor";
import { IntakeRegistry } from "../lib/intake/core/registry";
import type { IntakeAdapter } from "../lib/intake/core/contract";
import { intakeRegistry } from "../lib/intake/sources";
import { canonicalOrder, commerceReceipt } from "../lib/intake/commerce/canonical";
import { canonicalCall, callReceipt, normalizeCall } from "../lib/intake/calls/canonical";
import { makeCommerceAdapter } from "../lib/intake/commerce/adapter";
import { makeCallAdapter } from "../lib/intake/calls/adapter";
import { resolvePublicConnection, resolveResourceConnection } from "../lib/intake/acquisition/resolve";
import { receiveKeyedDelivery, receiveSignedDelivery, type ParseResult } from "../lib/intake/acquisition/receive";
import { verifyHmacSha256Base64, verifySvix } from "../lib/intake/acquisition/signatures";
import {
  bindMetaPage, createKeyedConnection, createSignedConnection, markConnectionError, readMetaPageToken, revokeConnection, setPaused,
} from "../lib/intake/acquisition/connection.service";
import { decideProposal } from "../lib/intake/identity/proposals";
import { hashIdentifier } from "../lib/intake/identity/identifiers";
import { getLeadBriefing } from "../lib/services/crm/lead-briefing";
import { setMetaGraphFetchForTests } from "../lib/intake/acquisition/providers/meta-lead-ads";
import { POST as metaPOST } from "../app/api/intake/acquisition/meta/route";
import { SENSORS } from "../lib/sensors/catalogue";

const RUN = `m7a-${Date.now()}`;
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const o = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const rt = new PrismaClient({ datasourceUrl: process.env.RUNTIME_URL! });

// ── lab reference adapters (simulators) ─────────────────────────────────────────
let commerceProviderDown = false;
const labCommerce: IntakeAdapter = makeCommerceAdapter({
  sourceKey: "commerce.woocommerce",
  async resolveTenant(ref) { return (await resolvePublicConnection("commerce.woocommerce", ref))?.businessId ?? null; },
  async hydrate() {
    if (commerceProviderDown) { commerceProviderDown = false; throw new Error("lab_provider_down"); }
    return { kind: "unchanged" };
  },
});
const labCloudtalk = makeCallAdapter({
  sourceKey: "telephony.cloudtalk",
  async resolveTenant(ref) { return (await resolvePublicConnection("telephony.cloudtalk", ref))?.businessId ?? null; },
});
const labVoicenter = makeCallAdapter({
  sourceKey: "telephony.voicenter",
  async resolveTenant(ref) { return (await resolvePublicConnection("telephony.voicenter", ref))?.businessId ?? null; },
});
const labRegistry = new IntakeRegistry();
for (const a of intakeRegistry.list()) labRegistry.register(a);
labRegistry.register(labCommerce).register(labCloudtalk).register(labVoicenter);

// A deliberately WRONG adapter: a call aimed at "lead". R0 must refuse it at runtime.
const r0Registry = new IntakeRegistry();
for (const a of intakeRegistry.list()) r0Registry.register(a);
r0Registry.register({
  ...labVoicenter,
  normalize(e) {
    const n = normalizeCall(e);
    return n.ok ? { ok: true, normalized: { ...n.normalized, target: "lead" } } : n;
  },
});

async function enable(businessId: number, featureKey: string) {
  await o.businessFeatureAccess.upsert({
    where: { businessId_featureKey: { businessId, featureKey } },
    create: { businessId, featureKey, state: "ENABLED" },
    update: { state: "ENABLED" },
  });
}
const drain = (businessId: number, now?: Date, registry = labRegistry) =>
  runTenantJob({ businessId }, () => drainIntake(registry, businessId, now ? { now } : {}));

// Woo-style signed order delivery (body = the lab's canonical input; signature = base64 HMAC).
const orderParse = (publicId: string) => (raw: string): ParseResult => {
  try {
    return { ok: true, receipts: [commerceReceipt(canonicalOrder(JSON.parse(raw)), publicId)] };
  } catch (e) {
    return { ok: false, code: e instanceof Error ? e.message : "malformed" };
  }
};
async function sendOrder(publicId: string, body: unknown, secret: string, opts: { sig?: string; raw?: string } = {}) {
  const raw = opts.raw ?? JSON.stringify(body);
  const sig = opts.sig ?? createHmac("sha256", secret).update(raw).digest("base64");
  return receiveSignedDelivery({
    sourceKey: "commerce.woocommerce", publicId, raw, registry: labRegistry, processInline: true,
    verify: (s) => verifyHmacSha256Base64(raw, sig, s.signingSecret),
    parse: orderParse(publicId),
  });
}
// CloudTalk-style (Svix) signed call delivery.
const callParse = (publicId: string) => (raw: string): ParseResult => {
  try {
    return { ok: true, receipts: [callReceipt(canonicalCall(JSON.parse(raw)), publicId)] };
  } catch (e) {
    return { ok: false, code: e instanceof Error ? e.message : "malformed" };
  }
};
function svixSign(secret: string, id: string, ts: string, raw: string) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64")}`;
}
let svixSeq = 0;
async function sendCall(publicId: string, body: unknown, secret: string, opts: { now?: Date; tamper?: boolean } = {}) {
  const raw = JSON.stringify(body);
  const now = opts.now ?? new Date();
  const id = `msg_${++svixSeq}`;
  const ts = String(Math.floor(now.getTime() / 1000));
  const signature = svixSign(secret, id, ts, raw);
  const sent = opts.tamper ? raw.replace("inbound", "outbound") : raw;
  return receiveSignedDelivery({
    sourceKey: "telephony.cloudtalk", publicId, raw: sent, registry: labRegistry, processInline: true,
    verify: (s) => verifySvix(sent, { id, timestamp: ts, signature }, s.signingSecret, new Date()),
    parse: callParse(publicId),
  });
}
const svixSecret = (who: string) => `whsec_${Buffer.from(`${RUN}-${who}-0123456789abcdef`).toString("base64")}`;

const PHONE_NEW = "052-700-0001";
const PHONE_KNOWN = "052-700-0002";
const PHONE_UNKNOWN = "054-700-0003";
const PHONE_CONFLICT = "054-700-0004";
const PII = [/7000001/, /7000002/, /7000003/, /7000004/, /buyer.*@lab\.test/i, /Dana Buyer/, /Lamp/];
const order = (id: string, over: Record<string, unknown> = {}) => ({
  providerOrderId: id, orderNumber: `#${id}`, eventKind: "created", status: "placed", currency: "ILS", totalMinor: 25_900,
  placedAt: "2026-10-06T10:00:00Z", providerUpdatedAt: "2026-10-06T10:00:00Z",
  buyer: { phone: PHONE_NEW, email: `buyer-${id}@lab.test`, name: "Dana Buyer", providerCustomerId: `c${id}` },
  lines: [{ lineKey: "1", externalProductId: "p9", sku: "SKU-1", title: "Lamp", quantity: 2, unitMinor: 12_950, totalMinor: 25_900 }],
  attribution: { landingUrl: "https://shop.lab.test/p/lamp?utm_source=ig&utm_campaign=fall&email=x@y.z", clickId: "fbclid-1" },
  ...over,
});
const call = (id: string, over: Record<string, unknown> = {}) => ({
  providerCallId: id, direction: "inbound", outcome: "missed", durationSec: 0, startedAt: new Date(Date.now() - 3_600_000).toISOString(),
  businessLine: "035551234", counterpartNumber: PHONE_UNKNOWN, ...over,
});

async function main() {
  const A = await o.business.create({ data: { name: `${RUN}-A` } });
  const B = await o.business.create({ data: { name: `${RUN}-B` } });
  const C = await o.business.create({ data: { name: `${RUN}-C` } }); // features never enabled
  for (const b of [A.id, B.id]) for (const f of ["commerce_woocommerce", "telephony_cloudtalk", "telephony_voicenter", "acquisition_meta_lead_ads"]) await enable(b, f);

  const signed = (businessId: number, sourceKey: "commerce.woocommerce" | "telephony.cloudtalk" | "commerce.wix", extra: { externalResourceId?: string; signingSecret?: string } = {}) =>
    runWithTenantContext({ businessId }, () => createSignedConnection({ businessId, userId: null, sourceKey, ...extra }));
  const wooA = await signed(A.id, "commerce.woocommerce", { externalResourceId: "shop-a.lab.test" });
  const wooB = await signed(B.id, "commerce.woocommerce", { externalResourceId: "shop-b.lab.test" });
  const wooC = await signed(C.id, "commerce.woocommerce", { externalResourceId: "shop-c.lab.test" });
  const ctA = await signed(A.id, "telephony.cloudtalk", { signingSecret: svixSecret("A") });
  const ctB = await signed(B.id, "telephony.cloudtalk", { signingSecret: svixSecret("B") });
  const vcA = await runWithTenantContext({ businessId: A.id }, () => createKeyedConnection({ businessId: A.id, userId: null, sourceKey: "telephony.voicenter" }));

  const baseline = {
    leads: await o.lead.count(), deals: await o.deal.count(), financial: await o.financialEvent.count(),
    billing: await o.billingDocument.count(), invSales: await o.inventorySale.count(), invExternal: await o.inventoryExternalSale.count(),
  };

  console.log("\n-- E2. schema + tenant isolation as the NOBYPASSRLS runtime --");
  const rtRole = await rt.$queryRaw<Array<{ s: boolean; b: boolean }>>`SELECT rolsuper AS s, rolbypassrls AS b FROM pg_roles WHERE rolname = current_user`;
  ok("the runtime login is NOSUPERUSER NOBYPASSRLS", rtRole[0]?.s === false && rtRole[0]?.b === false);
  for (const t of ["CommerceOrder", "CommerceOrderLine", "CommerceOrderEvent", "CallActivity"]) {
    const del = await rt.$executeRawUnsafe(`DELETE FROM "${t}"`).then(() => "allowed", (e: Error) => (/permission denied/.test(e.message) ? "denied" : e.message));
    ok(`${t}: the runtime cannot DELETE (no grant)`, del === "denied", del);
  }
  const upd = await rt.$executeRawUnsafe(`UPDATE "CommerceOrderEvent" SET "applied" = true`).then(() => "allowed", (e: Error) => (/permission denied/.test(e.message) ? "denied" : e.message));
  ok("CommerceOrderEvent is append-only for the runtime (no UPDATE grant)", upd === "denied", upd);

  console.log("\n-- commerce: a signed order → receipt → M4 identity → CommerceOrder (never a Lead) --");
  const r1 = await sendOrder(wooA.connection.publicId, order("1001"), wooA.signingSecret);
  ok("a correctly signed order → 200", r1.status === 200, JSON.stringify(r1.body));
  const o1 = await o.commerceOrder.findFirst({ where: { businessId: A.id, externalOrderId: "1001" }, include: { lines: true, events: true } });
  ok("one CommerceOrder in A, status placed, totals kept, lines kept", !!o1 && o1.status === "placed" && o1.totalMinor === 25_900 && o1.lines.length === 1 && o1.lineCount === 1);
  const c1 = o1?.customerId ? await o.customer.findUnique({ where: { id: o1.customerId } }) : null;
  ok("a NEW buyer with a phone became a Customer (D8) and the order points at it", !!c1 && c1.businessId === A.id && c1.phone === "972527000001");
  ok("one append-only history row (created, applied)", o1?.events.length === 1 && o1.events[0].applied && o1.events[0].kind === "created");
  const att = o1?.attribution as Record<string, unknown> | null;
  ok("E15 attribution kept on the order (utm, landing path, click id) — the query string's email dropped",
    (att?.utm as Record<string, string> | undefined)?.source === "ig" && att?.landingPage === "https://shop.lab.test/p/lamp" && att?.clickId === "fbclid-1" && !JSON.stringify(att).includes("x@y.z"), JSON.stringify(att));
  const n1 = await o.intakeNormalizedEvent.findFirst({ where: { businessId: A.id, intakeEvent: { sourceKey: "commerce.woocommerce" } } });
  ok("the normalized record names rule R5_COMMERCE and the order", n1?.routingRule === "R5_COMMERCE" && (n1?.resultRefs as { orderId?: number } | null)?.orderId === o1?.id);
  ok("its contact hints were purged once identity was decided", n1?.contactHints === null);

  console.log("\n-- E3. duplicate / retry / parallel --");
  const dup = await sendOrder(wooA.connection.publicId, order("1001"), wooA.signingSecret);
  ok("the same store change redelivered → 200", dup.status === 200);
  ok("still one receipt, one order, one history row", (await o.intakeEvent.count({ where: { businessId: A.id, sourceKey: "commerce.woocommerce" } })) === 1
    && (await o.commerceOrder.count({ where: { businessId: A.id } })) === 1 && (await o.commerceOrderEvent.count({ where: { businessId: A.id } })) === 1);
  const par = await Promise.all(Array.from({ length: 6 }, () => sendOrder(wooA.connection.publicId, order("1002", { buyer: { phone: PHONE_NEW } }), wooA.signingSecret)));
  ok("6 parallel deliveries of one change → all 200", par.every((r) => r.status === 200), par.map((r) => r.status).join(","));
  ok("…one receipt and one order for 1002", (await o.intakeEvent.count({ where: { businessId: A.id, sourceKey: "commerce.woocommerce" } })) === 2
    && (await o.commerceOrder.count({ where: { businessId: A.id, externalOrderId: "1002" } })) === 1);
  ok("…and the returning buyer (same phone) is the SAME Customer — no duplicate", (await o.customer.count({ where: { businessId: A.id, phone: "972527000001" } })) === 1);
  const changes = await Promise.all([
    sendOrder(wooA.connection.publicId, order("1003", { buyer: { phone: "052-700-0009" } }), wooA.signingSecret),
    sendOrder(wooA.connection.publicId, order("1003", { buyer: { phone: "052-700-0009" }, eventKind: "paid", status: "paid", providerUpdatedAt: "2026-10-06T10:05:00Z" }), wooA.signingSecret),
    sendOrder(wooA.connection.publicId, order("1003", { buyer: { phone: "052-700-0009" }, eventKind: "fulfilled", status: "fulfilled", providerUpdatedAt: "2026-10-06T10:09:00Z" }), wooA.signingSecret),
  ]);
  const o3 = await o.commerceOrder.findFirst({ where: { businessId: A.id, externalOrderId: "1003" } });
  ok("3 different changes of one NEW order in parallel → one order, three history rows, the newest state wins",
    changes.every((r) => r.status === 200) && !!o3 && o3.status === "fulfilled" && (await o.commerceOrderEvent.count({ where: { orderId: o3.id } })) === 3, o3?.status);
  ok("…and one Customer for its new buyer", (await o.customer.count({ where: { businessId: A.id, phone: "972527000009" } })) === 1);

  console.log("\n-- E4. out-of-order lifecycle --");
  await sendOrder(wooA.connection.publicId, order("1004", { eventKind: "paid", status: "paid", providerUpdatedAt: "2026-10-06T11:00:00Z" }), wooA.signingSecret);
  await sendOrder(wooA.connection.publicId, order("1004", { eventKind: "created", status: "placed", providerUpdatedAt: "2026-10-06T10:00:00Z" }), wooA.signingSecret);
  const o4 = await o.commerceOrder.findFirst({ where: { businessId: A.id, externalOrderId: "1004" }, include: { events: { orderBy: { id: "asc" } } } });
  ok("a late 'created' after 'paid' never moves status back", o4?.status === "paid", o4?.status);
  ok("…it is kept in the history as NOT applied", o4?.events.length === 2 && o4.events[1].applied === false && o4.events[1].statusAfter === "paid");
  await sendOrder(wooA.connection.publicId, order("1004", { eventKind: "refunded", status: "refunded", refundedMinor: 25_900, providerUpdatedAt: "2026-10-06T12:00:00Z" }), wooA.signingSecret);
  ok("a newer refund applies (refunded, refundedMinor = total)", (await o.commerceOrder.findFirst({ where: { businessId: A.id, externalOrderId: "1004" } }))?.status === "refunded");

  console.log("\n-- E5–E9. wrong business, unknown resource, signature, disabled / paused / revoked, collision --");
  const before = await o.intakeEvent.count();
  const wrongBiz = await sendOrder(wooA.connection.publicId, { ...order("1005"), businessId: B.id, storeId: "shop-b.lab.test" }, wooA.signingSecret);
  ok("a body naming ANOTHER business / store is still A's (tenant = the endpoint only)", wrongBiz.status === 200
    && (await o.commerceOrder.count({ where: { businessId: B.id } })) === 0 && (await o.commerceOrder.count({ where: { businessId: A.id, externalOrderId: "1005" } })) === 1);
  ok("A's endpoint with B's secret → 401", (await sendOrder(wooA.connection.publicId, order("1006"), wooB.signingSecret)).status === 401);
  ok("B's endpoint with A's secret → 401", (await sendOrder(wooB.connection.publicId, order("1006"), wooA.signingSecret)).status === 401);
  ok("an unknown endpoint → 401", (await sendOrder("x".repeat(32), order("1006"), wooA.signingSecret)).status === 401);
  ok("a tampered body → 401", (await sendOrder(wooA.connection.publicId, order("1006"), wooA.signingSecret, {
    raw: JSON.stringify(order("1006", { totalMinor: 1 })), sig: createHmac("sha256", wooA.signingSecret).update(JSON.stringify(order("1006"))).digest("base64") })).status === 401);
  ok("no signature → 401", (await sendOrder(wooA.connection.publicId, order("1006"), wooA.signingSecret, { sig: "" })).status === 401);
  ok("authenticated but malformed → 400", (await sendOrder(wooA.connection.publicId, { providerOrderId: "bad id" }, wooA.signingSecret)).status === 400);
  ok("C (feature OFF) → 200, recorded nothing", (await sendOrder(wooC.connection.publicId, order("1007"), wooC.signingSecret)).status === 200
    && (await o.intakeEvent.count({ where: { businessId: C.id } })) === 1 - 1);
  ok("every refusal above recorded nothing", (await o.intakeEvent.count()) === before + 1 /* the wrong-body order 1005 only */);
  await runWithTenantContext({ businessId: A.id }, () => setPaused(wooA.connection.id, true));
  ok("a PAUSED store endpoint → 401", (await sendOrder(wooA.connection.publicId, order("1008"), wooA.signingSecret)).status === 401);
  await runWithTenantContext({ businessId: A.id }, () => setPaused(wooA.connection.id, false));
  const twin = await signed(B.id, "commerce.woocommerce", { externalResourceId: "shop-a.lab.test" }).then(() => "bound", (e: { code?: string }) => e?.code ?? "error");
  ok("E9 a store host live on A cannot be bound by B (one live mapping per resource)", twin === "P2002", twin);
  // A receipt accepted, then its connection revoked before processing → IGNORED, never an order.
  const wooA2 = await signed(A.id, "commerce.woocommerce", { externalResourceId: "shop-a2.lab.test" });
  // Durable receipt only (no processing yet) — exactly what the route leaves behind before after() runs.
  const accepted = await acceptIntake({ registry: labRegistry, sourceKey: "commerce.woocommerce", accountRef: wooA2.connection.publicId,
    receipts: [commerceReceipt(canonicalOrder(order("1009")), wooA2.connection.publicId)] });
  await runWithTenantContext({ businessId: A.id }, () => revokeConnection(wooA2.connection.id));
  await drain(A.id);
  const revokedEv = await o.intakeEvent.findFirst({ where: { businessId: A.id, providerAccountRef: wooA2.connection.publicId } });
  ok("accepted then revoked → settled IGNORED connection_revoked, no order", accepted.status === "accepted" && revokedEv?.status === "IGNORED"
    && revokedEv.lastErrorCode === "connection_revoked" && (await o.commerceOrder.count({ where: { businessId: A.id, externalOrderId: "1009" } })) === 0, revokedEv?.lastErrorCode ?? "");
  ok("a revoked endpoint → 401 afterwards", (await sendOrder(wooA2.connection.publicId, order("1010"), wooA2.signingSecret)).status === 401);
  const freed = await signed(B.id, "commerce.woocommerce", { externalResourceId: "shop-a2.lab.test" }).then(() => "bound", (e: { code?: string }) => e?.code ?? "error");
  ok("…and the revoked store host is free for another business", freed === "bound", freed);
  const crossFk = await withRuntimeTenant(A.id, `INSERT INTO "CommerceOrder" ("businessId","connectionId","sourceKey","externalOrderId","status","currency","totalMinor","placedAt","providerUpdatedAt","firstIntakeEventId","lastIntakeEventId","updatedAt")
    VALUES (${A.id}, ${wooB.connection.id}, 'commerce.woocommerce', 'x-cross', 'placed', 'ILS', 1, now(), now(), 1, 1, now())`);
  ok("the schema refuses an order of A pointing at B's connection (composite tenant FK)", /foreign key|violates/.test(crossFk), crossFk);
  const crossRls = await withRuntimeTenant(A.id, `INSERT INTO "CommerceOrder" ("businessId","connectionId","sourceKey","externalOrderId","status","currency","totalMinor","placedAt","providerUpdatedAt","firstIntakeEventId","lastIntakeEventId","updatedAt")
    VALUES (${B.id}, ${wooB.connection.id}, 'commerce.woocommerce', 'x-rls', 'placed', 'ILS', 1, now(), now(), 1, 1, now())`);
  ok("RLS refuses a row for ANOTHER business inside A's tenant context", /row-level security|violates/.test(crossRls), crossRls);
  const seen = await rt.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${B.id}', true)`);
    return tx.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "CommerceOrder" WHERE "businessId" = ${A.id}`);
  });
  ok("B's tenant context sees none of A's orders", seen[0]?.n === 0);
  const noCtx = await rt.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "CommerceOrder"`);
  ok("no tenant context → no rows at all (fail closed)", noCtx[0]?.n === 0);

  console.log("\n-- E10–E11. identity: known / email-only / uncertain (owner decides) --");
  const known = await o.customer.create({ data: { businessId: A.id, name: "Known Kim", phone: "972527000002" } });
  await sendOrder(wooA.connection.publicId, order("1011", { buyer: { phone: PHONE_KNOWN, name: "Someone Else" } }), wooA.signingSecret);
  const o11 = await o.commerceOrder.findFirst({ where: { businessId: A.id, externalOrderId: "1011" } });
  ok("a known phone → THAT Customer, no new one, the stored name untouched", o11?.customerId === known.id
    && (await o.customer.count({ where: { businessId: A.id, phone: "972527000002" } })) === 1 && (await o.customer.findUnique({ where: { id: known.id } }))?.name === "Known Kim");
  await sendOrder(wooA.connection.publicId, order("1012", { buyer: { email: "only-email@lab.test" } }), wooA.signingSecret);
  ok("an email-only buyer nobody knows → the order has NO Customer (none invented)", (await o.commerceOrder.findFirst({ where: { businessId: A.id, externalOrderId: "1012" } }))?.customerId === null
    && (await o.customer.count({ where: { businessId: A.id, email: "only-email@lab.test" } })) === 0);
  await o.customer.create({ data: { businessId: A.id, name: "Twin 1", email: "twin@lab.test" } });
  await o.customer.create({ data: { businessId: A.id, name: "Twin 2", email: "twin@lab.test" } });
  await sendOrder(wooA.connection.publicId, order("1013", { buyer: { email: "twin@lab.test" } }), wooA.signingSecret);
  const o13 = await o.commerceOrder.findFirst({ where: { businessId: A.id, externalOrderId: "1013" } });
  const ev13 = await o.commerceOrderEvent.findFirst({ where: { orderId: o13?.id } });
  const props = await o.identityProposal.findMany({ where: { businessId: A.id, intakeEventId: ev13?.intakeEventId } });
  ok("an AMBIGUOUS buyer → no Customer on the order, one proposal per candidate (owner decides; nothing merged)", o13?.customerId === null && props.length === 2, `${o13?.customerId} ${props.length}`);
  const dec = await runWithTenantContext({ businessId: A.id }, () => decideProposal({ businessId: A.id, proposalId: props[0].id, action: "confirm", userId: null }));
  ok("the owner confirms → the order is attached to that Customer", dec.status === "confirmed"
    && (await o.commerceOrder.findFirst({ where: { id: o13!.id } }))?.customerId === props[0].candidateCustomerId);
  const und = await runWithTenantContext({ businessId: A.id }, () => decideProposal({ businessId: A.id, proposalId: props[0].id, action: "undo", userId: null }));
  ok("undo → exactly that attachment is reverted", und.status === "undone" && (await o.commerceOrder.findFirst({ where: { id: o13!.id } }))?.customerId === null);

  console.log("\n-- E16. provider failure → retry → recovery --");
  commerceProviderDown = true;
  await sendOrder(wooA.connection.publicId, order("1014", { buyer: { phone: "052-700-0010" } }), wooA.signingSecret);
  const failed = await o.intakeEvent.findFirst({ where: { businessId: A.id, sourceKey: "commerce.woocommerce" }, orderBy: { id: "desc" } });
  ok("a transient failure → FAILED on backoff, no order yet", failed?.status === "FAILED" && (await o.commerceOrder.count({ where: { businessId: A.id, externalOrderId: "1014" } })) === 0, failed?.status);
  await drain(A.id, new Date(Date.now() + 3_600_000));
  ok("the retry (sweeper) completes it: one order, one Customer", (await o.commerceOrder.count({ where: { businessId: A.id, externalOrderId: "1014" } })) === 1
    && (await o.customer.count({ where: { businessId: A.id, phone: "972527000010" } })) === 1);

  console.log("\n-- telephony: signed calls → CallActivity (never a Lead, never a Customer) --");
  const lead = await o.lead.create({ data: { businessId: A.id, customerName: "Known Kim", phone: "972527000002", customerId: known.id, status: "OPEN", createdAt: new Date(Date.now() - 3 * 86_400_000), lastActivityAt: new Date(Date.now() - 2 * 86_400_000) } });
  const leadBefore = await o.lead.findUnique({ where: { id: lead.id } });
  ok("an unknown number's missed call → 200", (await sendCall(ctA.connection.publicId, call("ct-1"), ctA.signingSecret)).status === 200);
  const c1u = await o.callActivity.findFirst({ where: { businessId: A.id, providerCallId: "ct-1" } });
  ok("CallActivity: unknown caller, a hash (never the number), no Customer, no lead", c1u?.callerState === "unknown" && /^sha256:/.test(c1u.callerHash ?? "")
    && c1u.customerId === null && c1u.leadId === null && !JSON.stringify(c1u).includes("7000003"));
  ok("D8: the unknown caller did NOT become a Customer", (await o.customer.count({ where: { businessId: A.id, phone: "972547000003" } })) === 0);
  await sendCall(ctA.connection.publicId, call("ct-2", { startedAt: new Date(Date.now() - 1_800_000).toISOString() }), ctA.signingSecret);
  ok("the same unknown number again → grouped by the same hash", (await o.callActivity.findFirst({ where: { businessId: A.id, providerCallId: "ct-2" } }))?.callerHash === c1u?.callerHash);
  await sendCall(ctA.connection.publicId, call("ct-3", { counterpartNumber: PHONE_KNOWN }), ctA.signingSecret);
  const c3 = await o.callActivity.findFirst({ where: { businessId: A.id, providerCallId: "ct-3" } });
  ok("a known customer's missed call → known, that Customer, its open lead as evidence", c3?.callerState === "known" && c3.customerId === known.id && c3.leadId === lead.id);
  const leadAfter = await o.lead.findUnique({ where: { id: lead.id } });
  ok("…the lead itself is untouched (status, activity, version)", leadAfter?.status === leadBefore?.status
    && leadAfter?.lastActivityAt?.getTime() === leadBefore?.lastActivityAt?.getTime() && leadAfter?.lifecycleVersion === leadBefore?.lifecycleVersion);
  await sendCall(ctA.connection.publicId, call("ct-4", { counterpartNumber: "anonymous" }), ctA.signingSecret);
  const c4 = await o.callActivity.findFirst({ where: { businessId: A.id, providerCallId: "ct-4" } });
  ok("a hidden caller → hidden, no hash, no Customer", c4?.callerState === "hidden" && c4.callerHash === null && c4.customerId === null);
  ok("a tampered call body → 401", (await sendCall(ctA.connection.publicId, call("ct-5"), ctA.signingSecret, { tamper: true })).status === 401);
  ok("a stale Svix timestamp (replay) → 401", (await sendCall(ctA.connection.publicId, call("ct-6"), ctA.signingSecret, { now: new Date(Date.now() - 20 * 60_000) })).status === 401);
  ok("A's call endpoint with B's secret → 401", (await sendCall(ctA.connection.publicId, call("ct-7"), ctB.signingSecret)).status === 401);
  await Promise.all(Array.from({ length: 4 }, () => sendCall(ctA.connection.publicId, call("ct-8"), ctA.signingSecret)));
  ok("4 parallel deliveries of one call → one CallActivity", (await o.callActivity.count({ where: { businessId: A.id, providerCallId: "ct-8" } })) === 1);
  const correctedAt = new Date().toISOString();
  await sendCall(ctA.connection.publicId, call("ct-8", { outcome: "voicemail", durationSec: 25, providerUpdatedAt: correctedAt }), ctA.signingSecret);
  const c8 = await o.callActivity.findFirst({ where: { businessId: A.id, providerCallId: "ct-8" } });
  ok("a newer correction of the same call updates it (still one row)", c8?.outcome === "voicemail" && c8.durationSec === 25
    && (await o.callActivity.count({ where: { businessId: A.id, providerCallId: "ct-8" } })) === 1);
  // Voicenter: a keyed URL (no documented signature).
  const vc = (key: string, body: unknown) => receiveKeyedDelivery({ sourceKey: "telephony.voicenter", publicId: vcA.connection.publicId, key, raw: JSON.stringify(body),
    registry: labRegistry, processInline: true, parse: callParse(vcA.connection.publicId) });
  ok("Voicenter: a wrong key → 401", (await vc("dvk_wrong_wrong_wrong_wrong", call("vc-1"))).status === 401);
  ok("Voicenter: the right key → 200, one call", (await vc(vcA.key, call("vc-1"))).status === 200 && (await o.callActivity.count({ where: { businessId: A.id, providerCallId: "vc-1" } })) === 1);

  console.log("\n-- R0 at runtime: an adapter that aims a CALL at 'lead' is refused --");
  const leadsBeforeR0 = await o.lead.count({ where: { businessId: A.id } });
  await acceptIntake({ registry: r0Registry, sourceKey: "telephony.voicenter", accountRef: vcA.connection.publicId,
    receipts: [callReceipt(canonicalCall(call("r0-1", { counterpartNumber: "052-700-0011" })), vcA.connection.publicId)] });
  await drain(A.id, undefined, r0Registry);
  const r0 = await o.intakeEvent.findFirst({ where: { businessId: A.id, sourceKey: "telephony.voicenter" }, orderBy: { id: "desc" } });
  ok("dead-lettered routing:forbidden:R0_FORBIDDEN_LEAD; no Lead, no CallActivity", r0?.lastErrorCode === "routing:forbidden:R0_FORBIDDEN_LEAD"
    && (await o.lead.count({ where: { businessId: A.id } })) === leadsBeforeR0 && (await o.callActivity.count({ where: { providerCallId: "r0-1" } })) === 0, r0?.lastErrorCode ?? "");

  console.log("\n-- E11 (calls): a conflicting number → no attach, an owner proposal that would attach THIS call only --");
  const x = await o.customer.create({ data: { businessId: A.id, name: "Holder X", phone: "972547000004" } });
  const y = await o.customer.create({ data: { businessId: A.id, name: "Linked Y" } });
  // A state M4 itself would no longer create (the number is now X's Customer.phone), but a real one: Y's
  // owner-confirmed link predates the owner typing that number on X. Two strong identifiers → CONFLICT.
  const h = hashIdentifier({ kind: "phone", scope: "", value: "972547000004" });
  await o.identityLink.create({ data: { businessId: A.id, customerId: y.id, kind: h.kind, scope: h.scope, valueHash: h.valueHash, method: "owner_confirmed", status: "active" } });
  const linksBefore = await o.identityLink.count({ where: { businessId: A.id } });
  await sendCall(ctA.connection.publicId, call("ct-9", { counterpartNumber: PHONE_CONFLICT }), ctA.signingSecret);
  const c9 = await o.callActivity.findFirst({ where: { businessId: A.id, providerCallId: "ct-9" } });
  const p9 = await o.identityProposal.findMany({ where: { businessId: A.id, intakeEventId: c9?.firstIntakeEventId } });
  ok("conflict → unknown, no Customer; proposals for both candidates with NO identifier link proposed",
    c9?.customerId === null && p9.length === 2 && p9.every((p) => Array.isArray(p.proposedLinks) && (p.proposedLinks as unknown[]).length === 0), `${c9?.customerId} ${p9.length}`);
  const pick = p9.find((p) => p.candidateCustomerId === x.id)!;
  await runWithTenantContext({ businessId: A.id }, () => decideProposal({ businessId: A.id, proposalId: pick.id, action: "confirm", userId: null }));
  ok("owner confirms → the call is attached; NO IdentityLink was created by a call", (await o.callActivity.findFirst({ where: { id: c9!.id } }))?.customerId === x.id
    && (await o.identityLink.count({ where: { businessId: A.id } })) === linksBefore);
  await runWithTenantContext({ businessId: A.id }, () => decideProposal({ businessId: A.id, proposalId: pick.id, action: "undo", userId: null }));
  const c9u = await o.callActivity.findFirst({ where: { id: c9!.id } });
  ok("undo → detached again, its caller hash restored", c9u?.customerId === null && c9u.callerHash === c9?.callerHash);

  console.log("\n-- E13. Secretary: missed call not returned; unknown callers; returned by an outbound call --");
  const brief1 = await runWithTenantContext({ businessId: A.id }, () => withTenantTransaction((tx) => getLeadBriefing(tx, A.id)));
  const item = brief1.items.find((i) => i.leadId === lead.id);
  ok("the lead asks for a call back: CUSTOMER_CALLED, a FACT", item?.reason === "CUSTOMER_CALLED" && item.evidenceClass === "fact", JSON.stringify(item));
  ok("the briefing counts unknown numbers that called (grouped: 2 calls, 1 number) — never a number",
    (brief1.calls?.unreturned.unknownNumbers ?? 0) >= 1 && (brief1.calls?.unknownCallers[0]?.calls ?? 0) >= 2 && !JSON.stringify(brief1.calls).includes("547000003"), JSON.stringify(brief1.calls));
  ok("a hidden caller is counted, not identified", (brief1.calls?.unreturned.hiddenCallerCalls ?? 0) >= 1);
  await sendCall(ctA.connection.publicId, call("ct-10", { direction: "outbound", outcome: "answered", durationSec: 90, counterpartNumber: PHONE_KNOWN, startedAt: new Date().toISOString() }), ctA.signingSecret);
  ok("an outbound call back returns the missed call (returnedAt, via outbound_call)", (await o.callActivity.findFirst({ where: { businessId: A.id, providerCallId: "ct-3" } }))?.returnedVia === "outbound_call");
  const brief2 = await runWithTenantContext({ businessId: A.id }, () => withTenantTransaction((tx) => getLeadBriefing(tx, A.id)));
  ok("…and the lead no longer asks for a call back", brief2.items.find((i) => i.leadId === lead.id)?.reason !== "CUSTOMER_CALLED");

  console.log("\n-- E12. Order ≠ Lead, Call ≠ Lead; no Deal, no money, no stock --");
  const after = {
    leads: await o.lead.count(), deals: await o.deal.count(), financial: await o.financialEvent.count(),
    billing: await o.billingDocument.count(), invSales: await o.inventorySale.count(), invExternal: await o.inventoryExternalSale.count(),
  };
  ok("every order and call above created ZERO Leads (the one Lead was the owner's own setup)", after.leads === baseline.leads + 1, JSON.stringify({ baseline, after }));
  ok("…zero Deals, FinancialEvents, BillingDocuments, inventory sales", after.deals === baseline.deals && after.financial === baseline.financial
    && after.billing === baseline.billing && after.invSales === baseline.invSales && after.invExternal === baseline.invExternal);
  ok("no LeadLifecycleEvent for any M7 receipt", (await o.leadLifecycleEvent.count({ where: { businessId: A.id } })) === 0);

  console.log("\n-- E14. learning without PII --");
  const sensors = await o.learningEvent.findMany({ where: { businessId: A.id, eventType: { in: ["COMMERCE_ORDER_RECORDED", "COMMERCE_ORDER_STATUS_CHANGED", "CALL_RECORDED", "MISSED_CALL_RETURNED"] } } });
  const kinds = new Set(sensors.map((s) => s.eventType));
  ok("all four M7 sensors were written", kinds.size === 4, [...kinds].join(","));
  const allowed = (t: string) => new Set((SENSORS as Record<string, { payloadKeys: readonly string[] }>)[t].payloadKeys);
  ok("every M7 sensor payload holds only its catalogue keys", sensors.every((s) => Object.keys((s.payload ?? {}) as object).every((k) => allowed(s.eventType).has(k) || ["v", "actor", "source"].includes(k))),
    JSON.stringify(sensors.map((s) => s.payload)).slice(0, 300));
  const text = JSON.stringify(sensors);
  ok("no phone, email, name, product title or hash in any M7 learning signal", PII.every((re) => !re.test(text)) && !/sha256:/.test(text));
  const intakeSensors = JSON.stringify(await o.learningEvent.findMany({ where: { businessId: A.id, eventType: { in: ["INTAKE_EVENT_SETTLED", "INTAKE_IDENTITY_RESOLVED"] } } }));
  ok("…nor in the intake sensors of these receipts", PII.every((re) => !re.test(intakeSensors)));

  console.log("\n-- Meta Lead Ads hardening --");
  const pageA = "4040404040";
  const metaConn = await runWithTenantContext({ businessId: A.id }, () => bindMetaPage({ businessId: A.id, userId: null, pageId: pageA, pageAccessToken: "PAGE-TOKEN-M7A" }));
  await runWithTenantContext({ businessId: A.id }, () => markConnectionError(metaConn.id, "META_TOKEN_INVALID"));
  ok("a Page whose connection is in ERROR still resolves (leads are not dropped)", (await resolveResourceConnection("meta.lead_ads", pageA))?.businessId === A.id);
  setMetaGraphFetchForTests(async () => ({ status: 400, json: { error: { code: 190 } } }));
  const raw = JSON.stringify({ object: "page", entry: [{ id: pageA, changes: [{ field: "leadgen", value: { leadgen_id: "8800001", page_id: pageA } }] }] });
  const sig = "sha256=" + createHmac("sha256", process.env.META_LEAD_ADS_APP_SECRET!).update(raw).digest("hex");
  const mr = await metaPOST(new NextRequest("http://m7a.local/api/intake/acquisition/meta", { method: "POST", headers: { "x-hub-signature-256": sig, "content-type": "application/json" }, body: raw }));
  await drain(A.id);
  const mev = await o.intakeEvent.findFirst({ where: { businessId: A.id, sourceKey: "meta.lead_ads" } });
  ok("…its new lead is RECORDED (200) and DEFERRED until the owner reconnects — not acknowledged-and-dropped", mr.status === 200 && !!mev && mev.status !== "PROCESSED" && /meta_token_invalid|page_not_connected/.test(mev.lastErrorCode ?? ""), `${mr.status} ${mev?.status} ${mev?.lastErrorCode}`);
  await runWithTenantContext({ businessId: A.id }, () => setPaused(metaConn.id, true));
  ok("a PAUSED Page does not resolve (the owner stopped it)", (await resolveResourceConnection("meta.lead_ads", pageA)) === null);
  ok("…but its token is still readable, so disconnecting a paused Page can unsubscribe it at Meta",
    (await runWithTenantContext({ businessId: A.id }, () => readMetaPageToken(A.id, pageA)))?.token === "PAGE-TOKEN-M7A");
  setMetaGraphFetchForTests(null);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED:\n - " + failures.join("\n - ")); process.exitCode = 1; }
  else console.log("M7-A BATTERY: ALL PASS (LAB-PROVEN; providers simulated — not REAL-PROVIDER-PROVEN)");
}

/** Run one raw statement as the RUNTIME inside a business's tenant context; returns "ok" or the error. */
async function withRuntimeTenant(businessId: number, sql: string): Promise<string> {
  try {
    await rt.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${businessId}', true)`);
      await tx.$executeRawUnsafe(sql);
    });
    return "ok";
  } catch (e) {
    return e instanceof Error ? e.message.replace(/\s+/g, " ").slice(0, 200) : String(e);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await o.$disconnect(); await rt.$disconnect(); });
void Prisma;
