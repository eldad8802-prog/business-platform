/**
 * M6 — first-wave acquisition connectors, end to end on PostgreSQL 17 with Production's RLS and a
 * NOBYPASSRLS runtime (the app code runs as the runtime; the owner only sets up and inspects).
 *
 * Drives the REAL route handlers (website, Google, Meta webhooks; owner API) and the REAL Business
 * Intake processor (M3) → M4 identity → routeToLead → M5 lifecycle → Secretary briefing.
 *
 * env: DATABASE_URL / DIRECT_URL = runtime, OWNER_URL = owner (setup / assertions), AUTH_TOKEN_SECRET,
 *      META_LEAD_ADS_APP_SECRET, META_LEAD_ADS_VERIFY_TOKEN, ACQUISITION_CREDENTIAL_ENCRYPTION_KEY.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { signAuthToken } from "../lib/auth-token";
import { runTenantJob } from "../lib/tenant/job";
import { runWithTenantContext } from "../lib/tenant/context";
import { acceptIntake, drainIntake } from "../lib/intake/core/processor";
import { ACQUISITION_EVENT_TYPE } from "../lib/intake/acquisition/canonical";
import { intakeRegistry } from "../lib/intake/sources";
import { bindMetaPage, createKeyedConnection, revokeConnection, setPaused } from "../lib/intake/acquisition/connection.service";
import { setMetaGraphFetchForTests } from "../lib/intake/acquisition/providers/meta-lead-ads";
import { getLeadBriefing } from "../lib/services/crm/lead-briefing";
import { withTenantTransaction } from "../lib/tenant/transaction";
import { POST as webPOST, OPTIONS as webOPTIONS } from "../app/api/intake/acquisition/web/[publicId]/route";
import { POST as googlePOST } from "../app/api/intake/acquisition/google/[publicId]/route";
import { GET as metaGET, POST as metaPOST } from "../app/api/intake/acquisition/meta/route";
import { GET as ownerGET, POST as ownerPOST } from "../app/api/integrations/acquisition/route";
import { GET as sweepGET, POST as sweepPOST } from "../app/api/intake/sweep/route";
import { SWEEP_URL } from "../lib/intake/sweep-auth";
import { SignJWT } from "jose";
import { runIntakeSweep } from "../lib/intake/intake-sweeper";
import { deriveEventIdentity } from "../lib/intake/core/event-identity";
import { setMetaCodeExchangeForTests, setMetaGraphCallForTests } from "../lib/intake/acquisition/providers/meta-graph";
import { POST as metaPagesPOST } from "../app/api/integrations/acquisition/meta/pages/route";
import { POST as metaConnectPOST } from "../app/api/integrations/acquisition/meta/connect/route";

type MetaPagesBody = { handle?: string; pages?: { id: string; name: string; canAdvertise: boolean }[] };
const RUN = `m6-${Date.now()}`;
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const o = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const params = <T extends object>(p: T) => ({ params: Promise.resolve(p) });

async function enable(businessId: number, featureKey: string) {
  await o.businessFeatureAccess.upsert({
    where: { businessId_featureKey: { businessId, featureKey } },
    create: { businessId, featureKey, state: "ENABLED" },
    update: { state: "ENABLED" },
  });
}
async function drain(businessId: number, now?: Date) {
  return runTenantJob({ businessId }, () => drainIntake(intakeRegistry, businessId, now ? { now } : {}));
}
const counts = async (businessId: number, sourceKey: string) => ({
  receipts: await o.intakeEvent.count({ where: { businessId, sourceKey } }),
  leads: await o.lead.count({ where: { businessId, sourceChannel: `intake:${sourceKey}` } }),
});

function web(publicId: string, body: Record<string, unknown>, opts: { key?: string; origin?: string; raw?: string } = {}) {
  return webPOST(
    new NextRequest(`http://m6.local/api/intake/acquisition/web/${publicId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}),
        ...(opts.origin ? { origin: opts.origin } : {}),
        "x-forwarded-for": "203.0.113.7",
      },
      body: opts.raw ?? JSON.stringify(body),
    }),
    params({ publicId })
  );
}
function google(publicId: string, body: Record<string, unknown> | string) {
  return googlePOST(
    new NextRequest(`http://m6.local/api/intake/acquisition/google/${publicId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    params({ publicId })
  );
}
function metaSign(raw: string, secret = process.env.META_LEAD_ADS_APP_SECRET!) {
  return "sha256=" + createHmac("sha256", secret).update(raw, "utf8").digest("hex");
}
function meta(body: unknown, sig?: string) {
  const raw = JSON.stringify(body);
  return metaPOST(new NextRequest("http://m6.local/api/intake/acquisition/meta", {
    method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig ?? metaSign(raw) }, body: raw,
  }));
}
const leadgen = (pageId: string, leadgenId: string, formId = "777") => ({
  object: "page",
  entry: [{ id: pageId, time: 1, changes: [{ field: "leadgen", value: { leadgen_id: leadgenId, page_id: pageId, form_id: formId, ad_id: "5501", adgroup_id: "4401", created_time: Math.floor(Date.now() / 1000) } }] }],
});
const googleLead = (key: string, leadId: string, extra: Record<string, unknown> = {}) => ({
  lead_id: leadId, google_key: key, api_version: "1.0", form_id: 9001, campaign_id: 8001, adgroup_id: 7001, creative_id: 6001,
  gcl_id: "Cj0KCQ-test", is_test: false, lead_submit_time: new Date().toISOString(),
  user_column_data: [
    { column_id: "FULL_NAME", column_name: "Full Name", string_value: "Dana Levi" },
    { column_id: "PHONE_NUMBER", column_name: "Phone", string_value: "+972 52-555-0101" },
    { column_id: "EMAIL", column_name: "Email", string_value: "dana@example.test" },
    { column_id: "SERVICE", column_name: "Which service?", string_value: "Kitchen renovation" },
  ],
  ...extra,
});

async function main() {
  const A = await o.business.create({ data: { name: `${RUN}-A` } });
  const B = await o.business.create({ data: { name: `${RUN}-B` } });
  const C = await o.business.create({ data: { name: `${RUN}-C` } }); // source never enabled
  const userA = await o.user.create({ data: { email: `${RUN}-a@lab.test`, password: "x", businessId: A.id, role: "USER" } });
  for (const b of [A.id, B.id]) for (const f of ["acquisition_web_forms", "acquisition_google_lead_forms", "acquisition_meta_lead_ads"]) await enable(b, f);

  const mk = (businessId: number, sourceKey: "web.form" | "google.lead_form", allowedOrigins: string[] = []) =>
    runWithTenantContext({ businessId }, () => createKeyedConnection({ businessId, userId: null, sourceKey, allowedOrigins }));
  const webA = await mk(A.id, "web.form", ["https://a.example"]);
  const webB = await mk(B.id, "web.form");
  const webC = await mk(C.id, "web.form");
  const gA = await mk(A.id, "google.lead_form");

  console.log("\n-- 1. website form, server mode: one submission → one canonical Lead --");
  const sub = { submission_id: `${RUN}-s1`, name: "Noa Cohen", phone: "050-123-4567", email: "noa@example.test",
    message: "Need a quote for a bathroom", budget: "20-30k", businessId: B.id,
    page_url: "https://a.example/contact?utm_source=fb&utm_campaign=spring&token=SECRET", utm_medium: "cpc" };
  const r1 = await web(webA.connection.publicId, sub, { key: webA.key });
  ok("server-mode post with the key → 202", r1.status === 202, String(r1.status));
  await drain(A.id);
  const leadA = await o.lead.findFirst({ where: { businessId: A.id, sourceChannel: "intake:web.form" } });
  ok("a Lead exists in A with source intake:web.form", !!leadA);
  ok("…and NOT in B although the body named B (tenant comes only from the endpoint)",
    (await o.lead.count({ where: { businessId: B.id, sourceChannel: "intake:web.form" } })) === 0);
  ok("the Lead carries the answers for the owner (intentSnapshot), not the contact fields",
    !!leadA?.intentSnapshot && /bathroom/.test(leadA.intentSnapshot) && /budget/.test(leadA.intentSnapshot) && !/050/.test(leadA.intentSnapshot), leadA?.intentSnapshot ?? "");
  ok("the Lead has the normalized phone and email", !!leadA?.phone && leadA.email === "noa@example.test");
  const life = leadA ? await o.leadLifecycleEvent.findMany({ where: { businessId: A.id, leadId: leadA.id } }) : [];
  ok("M5 lifecycle started exactly once, evidenced by the intake event", life.length === 1 && life[0].kind === "created" && life[0].evidenceKind === "intake_event");
  const norm = await o.intakeNormalizedEvent.findFirst({ where: { businessId: A.id }, orderBy: { id: "desc" } });
  const attr = norm?.attribution as Record<string, unknown> | null;
  ok("attribution kept: provider, UTM (from URL and field), landing page WITHOUT its query",
    attr?.provider === "web" && (attr?.utm as Record<string, string>)?.source === "fb" && (attr?.utm as Record<string, string>)?.medium === "cpc"
      && attr?.landingPage === "https://a.example/contact", JSON.stringify(attr));
  const ev = await o.intakeEvent.findFirst({ where: { businessId: A.id, sourceKey: "web.form" } });
  const facts = (ev?.metadata as { facts?: Record<string, string> } | null)?.facts;
  ok("receipt metadata says supplied / not_supplied / not_applicable per fact",
    facts?.phone === "supplied" && facts?.adSet === "not_applicable" && facts?.landingPage === "supplied", JSON.stringify(facts));
  ok("the raw payload is purged once processed", ev?.payload === null && ev?.payloadPurgedAt !== null);

  console.log("\n-- 2. delivery: repeated, parallel, retried → one receipt, one Lead --");
  for (let i = 0; i < 3; i++) await web(webA.connection.publicId, sub, { key: webA.key });
  await Promise.all(Array.from({ length: 6 }, () => web(webA.connection.publicId, { ...sub, submission_id: `${RUN}-par` }, { key: webA.key })));
  await drain(A.id);
  const cw = await counts(A.id, "web.form");
  ok("3 re-deliveries of s1 + 6 parallel deliveries of another → exactly 2 receipts", cw.receipts === 2, JSON.stringify(cw));
  ok("…and the same person (same phone) never gets a second open Lead", cw.leads === 1, JSON.stringify(cw));
  const attached = await o.leadLifecycleEvent.count({ where: { businessId: A.id, leadId: leadA?.id, kind: "intake_attached" } });
  ok("the second submission of the same phone is recorded on that Lead (intake_attached)", attached === 1, String(attached));

  console.log("\n-- 3. authentication and tenant boundary --");
  const before = await counts(A.id, "web.form");
  ok("a wrong key → 401", (await web(webA.connection.publicId, { ...sub, submission_id: "x1" }, { key: "dwk_wrong_wrong_wrong" })).status === 401);
  ok("B's key on A's endpoint → 401", (await web(webA.connection.publicId, { ...sub, submission_id: "x2" }, { key: webB.key })).status === 401);
  ok("a forged endpoint id → 404", (await web("A".repeat(32), { ...sub, submission_id: "x3" }, { origin: "https://a.example" })).status === 404);
  ok("browser post from an allowed origin → 202",
    (await web(webA.connection.publicId, { name: "Browser Lead", email: "b@example.test", submission_id: `${RUN}-br` }, { origin: "https://a.example" })).status === 202);
  ok("browser post from another origin → 403", (await web(webA.connection.publicId, { email: "c@example.test" }, { origin: "https://evil.example" })).status === 403);
  ok("browser post with no origin → 403", (await web(webA.connection.publicId, { email: "c@example.test" })).status === 403);
  const pre = await webOPTIONS(new NextRequest(`http://m6.local/x`, { method: "OPTIONS", headers: { origin: "https://a.example" } }), params({ publicId: webA.connection.publicId }));
  ok("CORS preflight answers only the allowed origin", pre.status === 204 && pre.headers.get("access-control-allow-origin") === "https://a.example");
  const beforeHp = await o.intakeEvent.count({ where: { businessId: A.id } });
  const hp = await web(webA.connection.publicId, { email: "bot@example.test", _hp: "filled", submission_id: `${RUN}-hp` }, { origin: "https://a.example" });
  ok("honeypot → 202 like a success, nothing recorded", hp.status === 202 && (await o.intakeEvent.count({ where: { businessId: A.id } })) === beforeHp);
  ok("no contact at all → 400", (await web(webA.connection.publicId, { message: "hi" }, { key: webA.key })).status === 400);
  ok("malformed JSON → 400", (await web(webA.connection.publicId, {}, { key: webA.key, raw: "{not json" })).status === 400);
  ok("oversized body → 413", (await web(webA.connection.publicId, {}, { key: webA.key, raw: JSON.stringify({ email: "a@b.test", pad: "x".repeat(40_000) }) })).status === 413);
  ok("source not enabled for the business → 404, nothing recorded",
    (await web(webC.connection.publicId, { email: "c@example.test" }, { key: webC.key })).status === 404 && (await o.intakeEvent.count({ where: { businessId: C.id } })) === 0);
  await runWithTenantContext({ businessId: A.id }, () => setPaused(webA.connection.id, true));
  ok("a paused endpoint → 401 for its own key", (await web(webA.connection.publicId, { ...sub, submission_id: "x4" }, { key: webA.key })).status === 401);
  await runWithTenantContext({ businessId: A.id }, () => setPaused(webA.connection.id, false));
  await drain(A.id);
  const after3 = await counts(A.id, "web.form");
  ok("every refused request recorded nothing (only the browser lead was added)", after3.receipts === before.receipts + 1, JSON.stringify({ before, after3 }));

  console.log("\n-- 4. Google Ads lead form webhook --");
  ok("valid Google lead → 200 {}", (await google(gA.connection.publicId, googleLead(gA.key, `${RUN}-g1`))).status === 200);
  ok("wrong google_key → 401", (await google(gA.connection.publicId, googleLead("dgk_wrong_wrong_wrong", `${RUN}-g2`))).status === 401);
  ok("missing google_key → 401", (await google(gA.connection.publicId, { ...googleLead("", `${RUN}-g3`), google_key: undefined })).status === 401);
  ok("malformed body → 400", (await google(gA.connection.publicId, "{oops")).status === 400);
  ok("Google's 'Send test data' → 200, recorded, never a Lead",
    (await google(gA.connection.publicId, googleLead(gA.key, `${RUN}-gt`, { is_test: true }))).status === 200);
  ok("the same Google lead redelivered → 200", (await google(gA.connection.publicId, googleLead(gA.key, `${RUN}-g1`))).status === 200);
  await drain(A.id);
  const cg = await counts(A.id, "google.lead_form");
  ok("2 receipts (lead + test), 1 Lead", cg.receipts === 2 && cg.leads === 1, JSON.stringify(cg));
  const gNorm = await o.intakeNormalizedEvent.findFirst({ where: { businessId: A.id, intakeEvent: { sourceKey: "google.lead_form", eventType: "lead.submitted" }, routeTarget: "lead" } });
  const ga = gNorm?.attribution as Record<string, unknown> | null;
  ok("Google attribution: campaign, ad group, creative, form and gclid kept",
    ga?.campaignId === "8001" && ga?.adSetId === "7001" && ga?.adId === "6001" && ga?.formId === "9001" && ga?.clickId === "Cj0KCQ-test", JSON.stringify(ga));
  const testEv = await o.intakeEvent.findFirst({ where: { businessId: A.id, sourceKey: "google.lead_form", status: "IGNORED" } });
  ok("the test submission was ignored as test_submission", testEv?.lastErrorCode === "test_submission" || testEv?.status === "IGNORED", JSON.stringify(testEv?.lastErrorCode));
  const r = await runWithTenantContext({ businessId: A.id }, () => revokeConnection(gA.connection.id));
  ok("a revoked Google endpoint → 401 for its old key", !!r && (await google(gA.connection.publicId, googleLead(gA.key, `${RUN}-g9`))).status === 401);

  console.log("\n-- 5. Meta Lead Ads: signed webhook → reference → hydrate (Page token) → Lead --");
  ok("verify handshake with the right token echoes the challenge",
    (await (await metaGET(new NextRequest(`http://m6.local/x?hub.mode=subscribe&hub.verify_token=${process.env.META_LEAD_ADS_VERIFY_TOKEN}&hub.challenge=abc123`))).text()) === "abc123");
  ok("verify handshake with a wrong token → 403",
    (await metaGET(new NextRequest(`http://m6.local/x?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=abc`))).status === 403);
  const pageA = "1010101010", pageB = "2020202020";
  await runWithTenantContext({ businessId: A.id }, () => bindMetaPage({ businessId: A.id, userId: null, pageId: pageA, pageName: "A Page", pageAccessToken: "PAGE-TOKEN-A" }));
  await runWithTenantContext({ businessId: B.id }, () => bindMetaPage({ businessId: B.id, userId: null, pageId: pageB, pageName: "B Page", pageAccessToken: "PAGE-TOKEN-B" }));
  const stolen = await runWithTenantContext({ businessId: B.id }, () =>
    bindMetaPage({ businessId: B.id, userId: null, pageId: pageA, pageAccessToken: "X" })).then(() => "bound", (e: { code?: string }) => e?.code ?? "error");
  ok("B cannot bind A's Page (one live mapping per Page)", stolen === "P2002", stolen);
  const tokRow = await o.acquisitionConnection.findFirst({ where: { externalResourceId: pageA, status: "ACTIVE" } });
  ok("the Page token is stored encrypted, never in clear", !!tokRow?.credentialCiphertext && !JSON.stringify(tokRow).includes("PAGE-TOKEN-A"));

  const graphCalls: string[] = [];
  let graphMode: "ok" | "190" = "ok";
  setMetaGraphFetchForTests(async (url, token) => {
    graphCalls.push(`${token}|${url.includes("access_token")}`);
    if (graphMode === "190") return { status: 400, json: { error: { code: 190, message: "expired" } } };
    const id = decodeURIComponent(url.split("/").pop()!.split("?")[0]);
    return { status: 200, json: {
      id, created_time: new Date().toISOString(), form_id: "777", ad_id: "5501", ad_name: "Spring ad", adset_id: "4401", adset_name: "TLV",
      campaign_id: "3301", campaign_name: "Spring", platform: "ig",
      field_data: [
        // A distinct person per lead id (same id → same person), so recovery is visible as a new Lead.
        { name: "full_name", values: ["Yossi Meta"] }, { name: "phone_number", values: [`+97252555${id.slice(-4)}`] },
        { name: "email", values: [`yossi${id.slice(-4)}@example.test`] }, { name: "what_do_you_need", values: ["Solar panels"] },
      ],
      custom_disclaimer_responses: [{ checkbox_key: "marketing_ok", is_checked: "1" }],
    } };
  });
  ok("a bad signature → 401, nothing recorded", (await meta(leadgen(pageA, "9000001"), "sha256=" + "0".repeat(64))).status === 401);
  ok("a valid leadgen notification → 200", (await meta(leadgen(pageA, "9000001"))).status === 200);
  ok("the same notification again (Meta retries for ~36 h) → 200", (await meta(leadgen(pageA, "9000001"))).status === 200);
  ok("a Page nobody connected → 200, skipped", (await meta(leadgen("3030303030", "9000009"))).status === 200);
  ok("B's Page → B", (await meta(leadgen(pageB, "9000002"))).status === 200);
  ok("a signed non-leadgen body → 200, nothing", (await meta({ object: "page", entry: [{ id: pageA, changes: [{ field: "feed", value: {} }] }] })).status === 200);
  await drain(A.id); await drain(B.id);
  const cm = await counts(A.id, "meta.lead_ads");
  ok("A: one receipt, one Lead for leadgen 9000001", cm.receipts === 1 && cm.leads === 1, JSON.stringify(cm));
  ok("B: its own Lead, A has nothing of B's", (await counts(B.id, "meta.lead_ads")).leads === 1);
  ok("the unknown Page created nothing anywhere", (await o.intakeEvent.count({ where: { providerAccountRef: "3030303030" } })) === 0);
  ok("the Page token went in the Authorization header, never the URL", graphCalls.length >= 2 && graphCalls.every((c) => c.endsWith("|false")), graphCalls.join(","));
  const mLead = await o.lead.findFirst({ where: { businessId: A.id, sourceChannel: "intake:meta.lead_ads" } });
  ok("the Meta Lead has the fetched answers and consent", !!mLead?.intentSnapshot && /Solar/.test(mLead.intentSnapshot) && /marketing_ok: ✓/.test(mLead.intentSnapshot), mLead?.intentSnapshot ?? "");
  const mNorm = await o.intakeNormalizedEvent.findFirst({ where: { businessId: A.id, intakeEvent: { sourceKey: "meta.lead_ads" } } });
  const ma = mNorm?.attribution as Record<string, unknown> | null;
  ok("Meta attribution: campaign / ad set / ad / form ids and names, platform ig",
    ma?.campaignId === "3301" && ma?.adSetId === "4401" && ma?.adId === "5501" && ma?.formId === "777" && ma?.source === "ig" && ma?.campaign === "Spring", JSON.stringify(ma));

  graphMode = "190";
  await meta(leadgen(pageA, "9000003"));
  await drain(A.id);
  const deferred = await o.intakeEvent.findFirst({ where: { businessId: A.id, sourceKey: "meta.lead_ads", status: "RECEIVED" } });
  const conn = await o.acquisitionConnection.findFirst({ where: { externalResourceId: pageA, status: { not: "REVOKED" } } });
  ok("an invalid Page token defers the lead (not lost) and marks the connection ERROR",
    !!deferred && deferred.lastErrorCode === "meta_token_invalid" && conn?.status === "ERROR" && conn.lastErrorCode === "META_TOKEN_INVALID", JSON.stringify({ d: deferred?.lastErrorCode, c: conn?.status }));
  graphMode = "ok";
  await runWithTenantContext({ businessId: A.id }, () => bindMetaPage({ businessId: A.id, userId: null, pageId: pageA, pageAccessToken: "PAGE-TOKEN-A2" }));
  await drain(A.id, new Date(Date.now() + 7 * 3_600_000));
  ok("after the owner reconnects the Page, the deferred lead is read and becomes a Lead",
    (await counts(A.id, "meta.lead_ads")).leads === 2);
  setMetaGraphFetchForTests(null);

  console.log("\n-- 6. identity across sources and businesses --");
  await web(webA.connection.publicId, { submission_id: `${RUN}-x`, name: "Dana L", phone: "052-555-0101", email: "dana@example.test" }, { key: webA.key });
  await drain(A.id);
  const danaCustomers = await o.customer.count({ where: { businessId: A.id, phone: { contains: "5550101" } } });
  ok("the same person from Google then the website → one Customer in A (deterministic phone)", danaCustomers === 1, String(danaCustomers));
  await web(webB.connection.publicId, { submission_id: `${RUN}-y`, phone: "052-555-0101" }, { key: webB.key });
  await drain(B.id);
  ok("the same phone in B → B's own Customer, nothing shared with A",
    (await o.customer.count({ where: { businessId: B.id, phone: { contains: "5550101" } } })) === 1);
  await web(webA.connection.publicId, { submission_id: `${RUN}-e`, email: "only-email@example.test", name: "No Phone" }, { key: webA.key });
  await drain(A.id);
  ok("a lead with email but no phone still becomes a Lead",
    (await o.lead.count({ where: { businessId: A.id, email: "only-email@example.test" } })) === 1);

  console.log("\n-- 7. RLS: A's acquisition state is invisible and untouchable from B --");
  const asB = <T>(fn: (tx: Parameters<Parameters<typeof withTenantTransaction>[0]>[0]) => Promise<T>) =>
    runWithTenantContext({ businessId: B.id }, () => withTenantTransaction(fn));
  ok("B's context sees none of A's connections", (await asB((tx) => tx.acquisitionConnection.count({ where: { businessId: A.id } }))) === 0);
  ok("B's context sees none of A's intake receipts", (await asB((tx) => tx.intakeEvent.count({ where: { businessId: A.id } }))) === 0);
  ok("B's context sees none of A's normalized events", (await asB((tx) => tx.intakeNormalizedEvent.count({ where: { businessId: A.id } }))) === 0);
  ok("B's context sees none of A's leads", (await asB((tx) => tx.lead.count({ where: { businessId: A.id } }))) === 0);
  ok("B's context changes none of A's connections",
    (await asB((tx) => tx.acquisitionConnection.updateMany({ where: { businessId: A.id }, data: { label: "pwned" } }))).count === 0);

  console.log("\n-- 8. Secretary, owner API, learning privacy --");
  const briefing = await runWithTenantContext({ businessId: A.id }, () => withTenantTransaction((tx) => getLeadBriefing(tx, A.id)));
  const groups = Object.fromEntries((briefing.arrivals?.bySource ?? []).map((s) => [s.group, s.count]));
  ok("the Secretary counts today's new leads by source (web / google / meta)",
    (briefing.arrivals?.today ?? 0) >= 4 && groups.web >= 2 && groups.google === 1 && groups.meta === 2, JSON.stringify(briefing.arrivals));
  const auth = { authorization: `Bearer ${signAuthToken(userA.id)}`, "content-type": "application/json" };
  const list = await ownerGET(new NextRequest("http://m6.local/api/integrations/acquisition", { headers: auth }));
  const listed = JSON.stringify(await list.json());
  ok("owner list: connections + endpoint URLs, and NO key hash, token or key",
    list.status === 200 && listed.includes("/api/intake/acquisition/web/") && !/keyHash|credential|PAGE-TOKEN|dwk_/.test(listed));
  const userC = await o.user.create({ data: { email: `${RUN}-c@lab.test`, password: "x", businessId: C.id, role: "USER" } });
  const createC = await ownerPOST(new NextRequest("http://m6.local/api/integrations/acquisition", {
    method: "POST", headers: { authorization: `Bearer ${signAuthToken(userC.id)}`, "content-type": "application/json" },
    body: JSON.stringify({ sourceKey: "web.form" }) }));
  ok("a business whose source is OFF cannot create an endpoint (403)", createC.status === 403);
  const createA = await ownerPOST(new NextRequest("http://m6.local/api/integrations/acquisition", {
    method: "POST", headers: auth, body: JSON.stringify({ sourceKey: "google.lead_form", label: "Spring form" }) }));
  const created = (await createA.json()) as { key?: string; connection?: { endpointUrl?: string } };
  ok("an enabled source: the key is shown once with the endpoint URL", createA.status === 201 && /^dgk_/.test(created.key ?? "") && /\/google\//.test(created.connection?.endpointUrl ?? ""));

  const learning = await o.learningEvent.findMany({ where: { businessId: A.id } });
  const blob = JSON.stringify(learning.map((l) => l.payload));
  ok("no learning payload carries a phone, an email, a name or an answer",
    !/5550101|555-0101|example\.test|Noa|Dana|Yossi|Solar|bathroom/i.test(blob), blob.slice(0, 200));
  const started = learning.filter((l) => l.eventType === "LEAD_LIFECYCLE_STARTED").map((l) => (l.payload as { intakeSource?: string })?.intakeSource);
  ok("LEAD_LIFECYCLE_STARTED records which acquisition source (closed vocabulary)",
    started.includes("web.form") && started.includes("google.lead_form") && started.includes("meta.lead_ads"), JSON.stringify(started));

  console.log("\n-- 9. durable retry: the scheduled sweep (safe, idempotent, concurrent, isolated) --");
  process.env.CRON_SECRET ||= `m6-lab-cron-${"x".repeat(48)}`;
  const sweepReq = (bearer?: string) => new NextRequest("http://m6.local/api/intake/sweep", { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
  ok("the sweep endpoint refuses a caller without CRON_SECRET (401)", (await sweepGET(sweepReq())).status === 401);
  ok("the sweep endpoint refuses a wrong secret (401)", (await sweepGET(sweepReq("nope-".repeat(12)))).status === 401);

  const metaKey = (pageId: string, leadgenId: string) => deriveEventIdentity({ providerEventId: leadgenId, accountScope: pageId }).externalEventId;
  const fetched: string[] = [];
  let down = true;
  setMetaGraphFetchForTests(async (url) => {
    const id = decodeURIComponent(url.split("/").pop()!.split("?")[0]);
    fetched.push(id);
    if (down) return { status: 503, json: { error: { code: 2, message: "temporarily unavailable" } } };
    return { status: 200, json: { id, created_time: new Date().toISOString(), form_id: "777", platform: "fb",
      field_data: [{ name: "full_name", values: ["Retry Person"] }, { name: "phone_number", values: [`+97254444${id.slice(-4)}`] }] } };
  });
  // Meta is down when the notifications arrive: the receipts are durable, the leads are not lost.
  await meta(leadgen(pageA, "9100001"));
  await meta(leadgen(pageB, "9100002"));
  await drain(A.id); await drain(B.id);
  const failedA = await o.intakeEvent.findFirst({ where: { businessId: A.id, externalEventId: metaKey(pageA, "9100001") } });
  ok("a lead whose answers could not be read is kept, FAILED on backoff (observable code, not lost)",
    failedA?.status === "FAILED" && !!failedA.lastErrorCode, JSON.stringify({ s: failedA?.status, c: failedA?.lastErrorCode }));

  // B revokes its Page before the retry: B's pending receipt must NOT become a Lead (and Meta is not asked).
  const bConn = await o.acquisitionConnection.findFirst({ where: { businessId: B.id, externalResourceId: pageB, status: { not: "REVOKED" } } });
  await runWithTenantContext({ businessId: B.id }, () => revokeConnection(bConn!.id));

  down = false;
  fetched.length = 0;
  const later = new Date(Date.now() + 3 * 3_600_000);
  const [sw1, sw2] = await Promise.all([runIntakeSweep({ now: later }), runIntakeSweep({ now: later })]);
  ok("two concurrent sweeps: no business errors in either", sw1.businessErrors === 0 && sw2.businessErrors === 0, JSON.stringify([sw1, sw2]));
  ok("two concurrent sweeps: A's recovered Meta lead was fetched ONCE (one worker per receipt)",
    fetched.filter((x) => x === "9100001").length === 1, JSON.stringify(fetched));
  ok("…and became exactly ONE Lead in A",
    (await o.lead.count({ where: { businessId: A.id, phone: { contains: "4444" } } })) === 1);
  const bEv = await o.intakeEvent.findFirst({ where: { businessId: B.id, externalEventId: metaKey(pageB, "9100002") } });
  ok("B's receipt for its REVOKED Page is settled IGNORED (connection_revoked), never fetched, no Lead",
    bEv?.status === "IGNORED" && bEv.lastErrorCode === "connection_revoked" && !fetched.includes("9100002") &&
      (await o.lead.count({ where: { businessId: B.id, phone: { contains: "4444" } } })) === 0,
    JSON.stringify({ s: bEv?.status, c: bEv?.lastErrorCode, fetched }));
  ok("tenant isolation: A's recovered lead is in A only",
    (await o.lead.count({ where: { phone: { contains: "44440001" } } })) === 1 &&
      (await o.lead.count({ where: { businessId: { not: A.id }, phone: { contains: "44440001" } } })) === 0);

  // Meta re-notifies (it retries for ~36 h) and the schedule runs again: still one Lead.
  await meta(leadgen(pageA, "9100001"));
  const again = await sweepGET(sweepReq(process.env.CRON_SECRET));
  const againBody = (await again.json()) as { ok?: boolean; report?: Record<string, unknown> };
  ok("the scheduled endpoint (CRON_SECRET) answers 200 with counts only",
    again.status === 200 && againBody.ok === true && !!againBody.report && !/4444|Retry Person|PAGE-TOKEN/.test(JSON.stringify(againBody)), JSON.stringify(againBody));
  ok("a re-notified, re-swept recovered lead is still ONE Lead (idempotent)",
    (await o.lead.count({ where: { businessId: A.id, phone: { contains: "4444" } } })) === 1 &&
      (await o.intakeEvent.count({ where: { businessId: A.id, externalEventId: metaKey(pageA, "9100001") } })) === 1);

  // The same revoked-connection rule holds for every source (one shared adapter step).
  const revokedWeb = await runWithTenantContext({ businessId: B.id }, () => revokeConnection(webB.connection.id));
  const webHydrate = await runWithTenantContext({ businessId: B.id }, () =>
    intakeRegistry.get("web.form")!.hydrate!({ businessId: B.id, now: new Date() }, { providerAccountRef: webB.connection.publicId } as never));
  ok("a website receipt whose endpoint was revoked is ignored too", !!revokedWeb && webHydrate.kind === "ignored", JSON.stringify(webHydrate));
  setMetaGraphFetchForTests(null);

  console.log("\n-- 10. owner Meta connect: login code → Pages + sealed handle → connect (no token in the browser) --");
  const userB = await o.user.create({ data: { email: `${RUN}-b@lab.test`, password: "x", businessId: B.id, role: "USER" } });
  const authB = { authorization: `Bearer ${signAuthToken(userB.id)}`, "content-type": "application/json" };
  const ownerReq = (path: string, headers: Record<string, string>, body?: unknown) =>
    new NextRequest(`http://m6.local${path}`, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
  const overview = async () => (await (await ownerGET(ownerReq("/api/integrations/acquisition", authB))).json()) as { meta?: { available?: boolean; login?: Record<string, string> | null } };

  delete process.env.NEXT_PUBLIC_META_LEAD_ADS_CONFIG_ID;
  ok("without the Meta login configuration, Meta is reported NOT available", (await overview()).meta?.available === false);
  ok("…and the pages step refuses (503), nothing is called", (await metaPagesPOST(ownerReq("/api/integrations/acquisition/meta/pages", authB, { code: "c" }))).status === 503);
  process.env.META_APP_ID ||= "1234567890";
  process.env.NEXT_PUBLIC_META_LEAD_ADS_CONFIG_ID = "9876543210";
  const ov = await overview();
  ok("configured: Meta available, the browser gets only the public app id + login configuration",
    ov.meta?.available === true && ov.meta.login?.configId === "9876543210" && !JSON.stringify(ov).includes(process.env.META_LEAD_ADS_APP_SECRET!), JSON.stringify(ov.meta));

  const subscribed: string[] = [];
  setMetaCodeExchangeForTests(async (url) => {
    const code = new URL(url).searchParams.get("code");
    return code === "good-code" ? { status: 200, json: { access_token: "USER-TOKEN-B" } } : { status: 400, json: { error: { code: 190 } } };
  });
  setMetaGraphCallForTests(async (method, path, token) => {
    if (method === "GET" && path.startsWith("/me/accounts")) {
      if (token !== "USER-TOKEN-B") return { status: 401, json: { error: { code: 190 } } };
      return { status: 200, json: { data: [
        { id: "4040404040", name: "B Studio", access_token: "PAGE-TOKEN-B2", tasks: ["ADVERTISE", "MANAGE"] },
        { id: "5050505050", name: "B Fan Page", access_token: "PAGE-TOKEN-B3", tasks: ["MODERATE"] },
      ] } };
    }
    if (method === "POST" && path.includes("/subscribed_apps")) { subscribed.push(`${path}|${token}`); return { status: 200, json: { success: true } }; }
    return { status: 404, json: {} };
  });
  ok("a bad login code → refused (403), no handle", (await metaPagesPOST(ownerReq("/api/integrations/acquisition/meta/pages", authB, { code: "bad" }))).status === 403);
  const pagesRes = await metaPagesPOST(ownerReq("/api/integrations/acquisition/meta/pages", authB, { code: "good-code" }));
  const pagesBody = (await pagesRes.json()) as MetaPagesBody;
  ok("a good code → the owner's Pages and a handle; no user or Page token in the answer",
    pagesRes.status === 200 && pagesBody.pages?.length === 2 && typeof pagesBody.handle === "string" && !/USER-TOKEN|PAGE-TOKEN|access_token/.test(JSON.stringify(pagesBody)), JSON.stringify(pagesBody).slice(0, 200));
  ok("the old body shape (a raw user token from the browser) is no longer accepted",
    (await metaConnectPOST(ownerReq("/api/integrations/acquisition/meta/connect", authB, { userAccessToken: "USER-TOKEN-B", pageId: "4040404040" }))).status === 400);
  ok("B's handle used by ANOTHER business → refused (400), nothing bound",
    (await metaConnectPOST(ownerReq("/api/integrations/acquisition/meta/connect", auth, { handle: pagesBody.handle, pageId: "4040404040" }))).status === 400 &&
      (await o.acquisitionConnection.count({ where: { externalResourceId: "4040404040" } })) === 0);
  ok("a Page without the advertise task → refused (403)",
    (await metaConnectPOST(ownerReq("/api/integrations/acquisition/meta/connect", authB, { handle: pagesBody.handle, pageId: "5050505050" }))).status === 403);
  const connectRes = await metaConnectPOST(ownerReq("/api/integrations/acquisition/meta/connect", authB, { handle: pagesBody.handle, pageId: "4040404040" }));
  const bound = await o.acquisitionConnection.findFirst({ where: { externalResourceId: "4040404040", status: "ACTIVE" } });
  ok("connect → 201: the Page is subscribed with ITS token and bound to B, token encrypted",
    connectRes.status === 201 && bound?.businessId === B.id && subscribed.some((s) => s.endsWith("|PAGE-TOKEN-B2")) && !!bound.credentialCiphertext && !JSON.stringify(bound).includes("PAGE-TOKEN-B2"),
    JSON.stringify({ s: connectRes.status, subscribed }));
  setMetaCodeExchangeForTests(null);
  setMetaGraphCallForTests(null);

  console.log("\n-- 11. website readiness: plain HTML form, same-day dedup, www twin, inactive business, failure observability --");
  const site = await mk(A.id, "web.form", ["https://shop-a.example"]);
  const twin = await o.acquisitionConnection.findUnique({ where: { id: site.connection.id } });
  ok("the owner gave one site; its www twin is allowed with it",
    JSON.stringify(twin?.allowedOrigins) === JSON.stringify(["https://shop-a.example", "https://www.shop-a.example"]), JSON.stringify(twin?.allowedOrigins));
  const htmlPost = (publicId: string, fields: Record<string, string>, origin: string, referer?: string, ip = "203.0.113.9") =>
    webPOST(new NextRequest(`http://m6.local/api/intake/acquisition/web/${publicId}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html,application/xhtml+xml", origin,
        ...(referer ? { referer } : {}), "x-forwarded-for": ip },
      body: new URLSearchParams(fields).toString(),
    }), params({ publicId }));
  const enquiry = { name: "Plain Form", phone: "053-777-1234", message: "do you work on Fridays", page_url: "https://www.shop-a.example/contact?utm_source=newsletter" };
  const before11 = await o.intakeEvent.count({ where: { businessId: A.id, sourceKey: "web.form", providerAccountRef: site.connection.publicId } });
  const h1 = await htmlPost(site.connection.publicId, enquiry, "https://www.shop-a.example", "https://www.shop-a.example/contact");
  const page = await h1.text();
  ok("a plain HTML form post from the www twin → 200 Hebrew thank-you page (not JSON), safe headers",
    h1.status === 200 && (h1.headers.get("content-type") ?? "").startsWith("text/html") && page.includes("תודה") &&
      (h1.headers.get("content-security-policy") ?? "").includes("default-src \x27none\x27"), `${h1.status} ${h1.headers.get("content-type")}`);
  ok("the page links back to the referring page on the allowed site, and echoes nothing the visitor typed",
    page.includes("https://www.shop-a.example/contact") && !page.includes("053-777-1234") && !page.includes("Fridays"));
  const h2 = await htmlPost(site.connection.publicId, enquiry, "https://www.shop-a.example");
  const h3 = await htmlPost(site.connection.publicId, enquiry, "https://shop-a.example");
  const after11 = await o.intakeEvent.count({ where: { businessId: A.id, sourceKey: "web.form", providerAccountRef: site.connection.publicId } });
  ok("a double submit + a resubmit of the SAME enquiry (no submission_id) the same day → ONE receipt",
    h2.status === 200 && h3.status === 200 && after11 === before11 + 1, JSON.stringify({ before11, after11 }));
  const formLead = await o.lead.count({ where: { businessId: A.id, phone: { contains: "537771234" } } });
  ok("…and ONE Lead", formLead === 1, String(formLead));
  const missing = await htmlPost(site.connection.publicId, { name: "No Contact", message: "hi" }, "https://shop-a.example");
  ok("a plain form without phone or email → 400 Hebrew page asking for contact details",
    missing.status === 400 && (await missing.text()).includes("פרטי קשר"));
  const json = await web(site.connection.publicId, { phone: "053-777-9999", message: "api client" }, { origin: "https://shop-a.example" });
  ok("a script / API client still gets JSON (202)", json.status === 202 && (json.headers.get("content-type") ?? "").includes("application/json"));

  const D = await o.business.create({ data: { name: `${RUN}-D` } });
  await enable(D.id, "acquisition_web_forms");
  const webD = await mk(D.id, "web.form");
  await o.business.update({ where: { id: D.id }, data: { deletionRequestedAt: new Date() } });
  const inactive = await web(webD.connection.publicId, { submission_id: `${RUN}-d1`, phone: "054-111-2222" }, { key: webD.key });
  ok("an inactive business (deletion requested) → 404, nothing recorded",
    inactive.status === 404 && (await o.intakeEvent.count({ where: { businessId: D.id } })) === 0, String(inactive.status));

  // A receipt that cannot be processed (no contact at all) dead-letters during the scheduled sweep:
  // the run must be unhealthy (500, reason failed_receipts) — "the sweep ran" is not "the leads arrived".
  const bad = deriveEventIdentity({ providerEventId: `${RUN}-poison`, accountScope: webA.connection.publicId });
  await acceptIntake({
    registry: intakeRegistry, sourceKey: "web.form", accountRef: webA.connection.publicId,
    receipts: [{ family: "LEAD", eventType: ACQUISITION_EVENT_TYPE, externalEventId: bad.externalEventId, dedupeBasis: bad.dedupeBasis,
      providerAccountRef: null, occurredAt: new Date(), payload: { v: 1 } as never, metadata: { v: 1 } as never }],
  });
  const unhealthy = await sweepGET(sweepReq(process.env.CRON_SECRET));
  const uBody = (await unhealthy.json()) as { ok?: boolean; reasons?: string[]; report?: { events?: { failed?: number } } };
  ok("a sweep in which a receipt fails → 500, ok:false, reason failed_receipts, counts only",
    unhealthy.status === 500 && uBody.ok === false && (uBody.reasons ?? []).includes("failed_receipts") && (uBody.report?.events?.failed ?? 0) >= 1,
    JSON.stringify(uBody));
  const poison = await o.intakeEvent.findFirst({ where: { businessId: A.id, externalEventId: bad.externalEventId } });
  ok("…the poison receipt is dead-lettered (not retried forever), and the next sweep is healthy again",
    poison?.status === "FAILED" && poison.nextAttemptAt === null && (poison.lastErrorCode ?? "").startsWith("normalize:") &&
      (await sweepGET(sweepReq(process.env.CRON_SECRET))).status === 200, JSON.stringify({ s: poison?.status, n: poison?.nextAttemptAt, c: poison?.lastErrorCode }));
  console.log("\n-- 12. QStash as the scheduler: a signed request for the Production sweep URL sweeps for real; tampered ones do not --");
  process.env.QSTASH_CURRENT_SIGNING_KEY = "sig_lab_current_0123456789abcdefghijklmnopqr";
  process.env.QSTASH_NEXT_SIGNING_KEY = "sig_lab_next_0123456789abcdefghijklmnopqrstu";
  const qsign = async (key: string, o: { url?: string; body?: string } = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ body: createHash("sha256").update(o.body ?? "", "utf8").digest("base64url") })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" }).setIssuer("Upstash").setSubject(o.url ?? SWEEP_URL)
      .setIssuedAt(now).setNotBefore(now).setExpirationTime(now + 300).setJti(randomUUID())
      .sign(new TextEncoder().encode(key));
  };
  const qpost = (signature: string, body = "") =>
    sweepPOST(new NextRequest("https://promaxgroup.co.il/api/intake/sweep", { method: "POST", headers: { "upstash-signature": signature }, body }));
  const receiptsBefore = await o.intakeEvent.count();
  const qok = await qpost(await qsign(process.env.QSTASH_CURRENT_SIGNING_KEY));
  const qokBody = (await qok.json()) as { ok?: boolean; via?: string; report?: { businesses?: number } };
  ok("a QStash-signed sweep (current key, exact Production URL) runs for real: 200, via qstash, counts only",
    qok.status === 200 && qokBody.ok === true && qokBody.via === "qstash" && typeof qokBody.report?.businesses === "number", JSON.stringify(qokBody));
  ok("…signed with the NEXT key (rotation) as well", (await qpost(await qsign(process.env.QSTASH_NEXT_SIGNING_KEY))).status === 200);
  ok("a signature for another URL → 401", (await qpost(await qsign(process.env.QSTASH_CURRENT_SIGNING_KEY, { url: "https://promaxgroup.co.il/api/payments/settlement-recovery" }))).status === 401);
  ok("a body other than the signed one → 401", (await qpost(await qsign(process.env.QSTASH_CURRENT_SIGNING_KEY, { body: "" }), "{\"tamper\":1}")).status === 401);
  ok("a signature made with a foreign key → 401", (await qpost(await qsign("sig_attacker_0123456789abcdefghijklmnopqrs"))).status === 401);
  ok("a foreign signature with a valid CRON bearer alongside → still 401 (no fallback)",
    (await sweepPOST(new NextRequest("https://promaxgroup.co.il/api/intake/sweep", { method: "POST",
      headers: { "upstash-signature": await qsign("sig_attacker_0123456789abcdefghijklmnopqrs"), authorization: `Bearer ${process.env.CRON_SECRET}` } }))).status === 401);
  ok("the CRON_SECRET backstop (no signature) still sweeps", (await sweepPOST(new NextRequest("https://promaxgroup.co.il/api/intake/sweep", { method: "POST",
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }))).status === 200);
  ok("scheduled sweeps wrote no intake receipt of their own (no side effects)", (await o.intakeEvent.count()) === receiptsBefore);

  console.log("\n-- 13. ready-made form idempotency: one submission id per page load decides --");
  const rcpts = () => o.intakeEvent.count({ where: { businessId: A.id, sourceKey: "web.form", providerAccountRef: site.connection.publicId } });
  const ask = { name: "Same Text Person", phone: "053-222-3344", message: "same question twice", page_url: "https://shop-a.example/contact" };
  const pageLoad1 = randomUUID();
  // one visitor on one page (8 requests, under the 10/min per-IP limit, which is proven elsewhere); new page loads from a second IP
  const V1 = "203.0.113.50", V2 = "203.0.113.51";
  const r0 = await rcpts();
  const d1 = await htmlPost(site.connection.publicId, { ...ask, submission_id: pageLoad1 }, "https://shop-a.example", undefined, V1);
  const d2 = await htmlPost(site.connection.publicId, { ...ask, submission_id: pageLoad1 }, "https://shop-a.example", undefined, V1);
  ok("double-click (same page load, same id) → ONE receipt", d1.status === 200 && d2.status === 200 && (await rcpts()) === r0 + 1);
  await htmlPost(site.connection.publicId, { ...ask, submission_id: pageLoad1 }, "https://www.shop-a.example", undefined, V1);
  ok("a retry / back + resubmit of that page → still ONE receipt", (await rcpts()) === r0 + 1);
  const parallel = await Promise.all(Array.from({ length: 5 }, () => htmlPost(site.connection.publicId, { ...ask, submission_id: pageLoad1 }, "https://shop-a.example")));
  ok("5 parallel deliveries of the same id → still ONE receipt", parallel.every((r) => r.status === 200) && (await rcpts()) === r0 + 1);
  const n1 = await htmlPost(site.connection.publicId, { ...ask, submission_id: randomUUID() }, "https://shop-a.example", undefined, V2);
  ok("the identical enquiry from a NEW page load (new id) → a new receipt", n1.status === 200 && (await rcpts()) === r0 + 2);
  const n2 = await htmlPost(site.connection.publicId, { ...ask, submission_id: randomUUID() }, "https://shop-a.example", undefined, V2);
  ok("two identical same-day enquiries with two ids → two receipts (three page loads → three)", n2.status === 200 && (await rcpts()) === r0 + 3);
  const keys = await o.intakeEvent.findMany({ where: { businessId: A.id, sourceKey: "web.form", providerAccountRef: site.connection.publicId },
    select: { externalEventId: true, dedupeBasis: true } });
  ok("no idempotency key carries PII or the raw id (sha256 keys only)",
    keys.length > 0 && keys.every((k) => /^sha256:[0-9a-f]{64}$/.test(k.externalEventId) && !/533222|222-3344|Same|question|[0-9a-f]{8}-[0-9a-f]{4}-/.test(k.externalEventId)));
  ok("…and these receipts are keyed on the submission id (provider_event_id), not the content",
    keys.filter((k) => k.dedupeBasis === "provider_event_id").length >= 3, JSON.stringify(keys.map((k) => k.dedupeBasis)));

  console.log(`\nM6 acquisition battery: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED:\n - " + failures.join("\n - ")); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await o.$disconnect(); });
