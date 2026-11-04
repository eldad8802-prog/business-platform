/**
 * M6 — rehearsal of the Google Ads lead form LIVE PROOF for business 9 on PostgreSQL 17 (Production RLS,
 * NOBYPASSRLS runtime), so ops/evidence/m6-google-live-proof-evidence.sql is proven BEFORE it is ever run in
 * Production.
 *
 *   npx tsx .m6/google-live-proof-rehearsal.ts enable    business 9 as Production holds it today (the closed
 *                                                         website pilot: web.form connection REVOKED,
 *                                                         acquisition_web_forms DISABLED, its lead kept) plus an
 *                                                         existing customer; another business Y stays OFF; then
 *                                                         acquisition_google_lead_forms ENABLED for 9 only and
 *                                                         9's owner connects Google through the real owner API
 *   npx tsx .m6/google-live-proof-rehearsal.ts test      Google's "Send test data" (is_test: true) through the
 *                                                         real webhook route
 *   npx tsx .m6/google-live-proof-rehearsal.ts submit    one genuine-shaped lead (a contact new to business 9),
 *                                                         then Google's retry of the SAME lead_id
 *   npx tsx .m6/google-live-proof-rehearsal.ts collide   a lead whose phone is the EXISTING customer's — the
 *                                                         "contact was new" identity checks must fail
 *   npx tsx .m6/google-live-proof-rehearsal.ts widen     Y is enabled too — the "business 9 only" check must fail
 *
 * Synthetic lab data only. Never pointed at Production.
 * env: DATABASE_URL / DIRECT_URL = runtime, OWNER_URL = owner, AUTH_TOKEN_SECRET.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { signAuthToken } from "../lib/auth-token";
import { runWithTenantContext } from "../lib/tenant/context";
import { createKeyedConnection, revokeConnection } from "../lib/intake/acquisition/connection.service";
import { normalizeCustomerPhone } from "../lib/services/integrations/whatsapp/phone";
import { POST as googlePOST } from "../app/api/intake/acquisition/google/[publicId]/route";
import { POST as ownerPOST } from "../app/api/integrations/acquisition/route";

const STATE = "/tmp/m6-google-live-proof-rehearsal.json";
const PILOT = 9;
const EXISTING_PHONE = "052-555-0199";
const o = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const fail = (m: string): never => {
  console.error(`REHEARSAL FAIL: ${m}`);
  process.exit(1);
};
type State = { Y: number; publicId: string; key: string };
const state = (): State => {
  if (!existsSync(STATE)) fail("run `enable` first");
  return JSON.parse(readFileSync(STATE, "utf8")) as State;
};

const lead = (key: string, leadId: string, phone: string, extra: Record<string, unknown> = {}) => ({
  lead_id: leadId, google_key: key, api_version: "1.0", form_id: 9001, campaign_id: 8001, adgroup_id: 7001, creative_id: 6001,
  gcl_id: "Cj0KCQ-rehearsal", is_test: false, lead_submit_time: new Date().toISOString(), lead_source: "LEAD_FORM",
  user_column_data: [
    { column_id: "FULL_NAME", column_name: "Full Name", string_value: "Rehearsal Prospect" },
    { column_id: "PHONE_NUMBER", column_name: "Phone", string_value: phone },
    { column_id: "SERVICE", column_name: "Which service?", string_value: "Consultation" },
  ],
  ...extra,
});

const send = (publicId: string, body: unknown) =>
  googlePOST(new NextRequest(`http://lab.local/api/intake/acquisition/google/${publicId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ publicId }) });

async function enable() {
  const nine = await o.business.create({ data: { id: PILOT, name: "rehearsal-pilot-9" } });
  const Y = await o.business.create({ data: { name: "rehearsal-shop-y" } });
  const owner = await o.user.create({ data: { email: "owner-9@rehearsal.test", password: "x", businessId: nine.id, role: "USER" } });

  // Business 9 as Production holds it after the closed website pilot: a revoked web.form connection, the web
  // feature closed for 9, and a customer that existed before Google (the "collide" phase types its phone).
  await o.businessFeatureAccess.create({ data: { businessId: PILOT, featureKey: "acquisition_web_forms", state: "ENABLED" } });
  const web = await runWithTenantContext({ businessId: PILOT }, () =>
    createKeyedConnection({ businessId: PILOT, userId: null, sourceKey: "web.form", allowedOrigins: ["https://pilot-9.example"] }));
  await runWithTenantContext({ businessId: PILOT }, () => revokeConnection(web.connection.id));
  await o.businessFeatureAccess.update({ where: { businessId_featureKey: { businessId: PILOT, featureKey: "acquisition_web_forms" } }, data: { state: "DISABLED" } });
  await o.customer.create({ data: { businessId: PILOT, name: "Existing Customer", phone: normalizeCustomerPhone(EXISTING_PHONE) } });

  // The platform-admin feature override, for business 9 only (in Production: the owner-run admin action).
  await o.businessFeatureAccess.create({ data: { businessId: PILOT, featureKey: "acquisition_google_lead_forms", state: "ENABLED" } });
  const res = await ownerPOST(new NextRequest("http://lab.local/api/integrations/acquisition", {
    method: "POST",
    headers: { authorization: `Bearer ${signAuthToken(owner.id)}`, "content-type": "application/json" },
    body: JSON.stringify({ sourceKey: "google.lead_form" }),
  }));
  const body = (await res.json()) as { connection?: { publicId?: string }; key?: string };
  if (res.status !== 201 || !body.connection?.publicId || !body.key) fail(`owner connect → ${res.status}`);
  writeFileSync(STATE, JSON.stringify({ Y: Y.id, publicId: body.connection!.publicId, key: body.key } satisfies State));
  console.log("enabled: Google for business 9 only (closed website pilot kept); connected through the owner API");
}

async function test() {
  const { publicId, key } = state();
  const r = await send(publicId, lead(key, "TeStLeAdId-rehearsal-1", "050-000-0000", { is_test: true }));
  if (r.status !== 200) fail(`test data → ${r.status}`);
  console.log("test: Google's \"Send test data\" accepted (200)");
}

async function submit() {
  const { publicId, key } = state();
  const body = lead(key, "lead-rehearsal-genuine-1", "054-777-0101");
  const first = await send(publicId, body);
  const retry = await send(publicId, body); // Google redelivers the same lead_id
  if (first.status !== 200 || retry.status !== 200) fail(`lead posts → ${first.status}, ${retry.status}`);
  console.log("submitted: one genuine-shaped lead + Google's retry of the same lead_id");
}

async function collide() {
  const { publicId, key } = state();
  // The existing customer's phone resolves the lead to them (Customer.phone needs no link); the email typed
  // with it becomes a deterministic email link ON that pre-existing customer — what K3 must catch.
  const body = lead(key, "lead-rehearsal-existing-1", EXISTING_PHONE);
  body.user_column_data.push({ column_id: "EMAIL", column_name: "Email", string_value: "someone-else@rehearsal.test" });
  const r = await send(publicId, body);
  if (r.status !== 200) fail(`colliding lead → ${r.status}`);
  console.log("collided: a lead typed with the existing customer's phone (+ an email)");
}

async function widen() {
  const { Y } = state();
  await o.businessFeatureAccess.create({ data: { businessId: Y, featureKey: "acquisition_google_lead_forms", state: "ENABLED" } });
  console.log("widened: a second business is enabled");
}

const phases: Record<string, () => Promise<void>> = { enable, test, submit, collide, widen };
const run = phases[process.argv[2] ?? ""];
if (!run) fail("phase must be enable | test | submit | collide | widen");
run!().catch((e) => fail(e instanceof Error ? e.message : String(e))).finally(() => o.$disconnect());
