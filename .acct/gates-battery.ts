/**
 * Monthly accountant workflow — the OFF state, as it ships before the owner gates (G2 / G4 / G5).
 *
 * The real route handlers and services run on the Production-shaped lab (DATABASE_URL = app_runtime_prod,
 * NOBYPASSRLS) with every accountant switch at its default, and every table of the database is fingerprinted
 * before and after: "inert" means not one row anywhere changed and no network call was made.
 *
 *   A. The sweep endpoint the new Vercel cron calls: no CRON_SECRET → 503; a wrong or missing bearer → 401;
 *      the right bearer with ACCOUNTANT_SWEEP_ENABLED unset (or anything but exactly "true") → 200
 *      { enabled: false }. Nothing written, nothing sent.
 *   B. G2 alone (the sweep enabled, the feature still off for every business): the sweep reads no business
 *      data and writes nothing — no period, package, notification or delivery.
 *   C. The owner routes with the flag off answer 404, as if they did not exist.
 *   D. Sending: approval refused (DELIVERY_DISABLED), an attempt is "disabled", the retry path does nothing.
 *   E. The public link: malformed and unknown links → the same 404; nothing recorded.
 *   F. The provider webhook: no RESEND_WEBHOOK_SECRET → 503; a forged signature → 401; nothing written.
 *   G. Positive control (so the checks above are not vacuous): the flag on for ONE business + the sweep on →
 *      that business's closed month is prepared, the other business gets nothing, and sending still stays
 *      refused until G4.
 *
 * env: OWNER_URL, DATABASE_URL (runtime). The auth plane (who is signed in) reads User / AuthSession through
 * AUTH_DATABASE_URL, as in Production; the lab points it at the owner. Every accountant read and write still
 * runs as the runtime role. Synthetic only. ZERO network.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.STORAGE_PROVIDER = "local";
process.env.LOCAL_STORAGE_ROOT = mkdtempSync(path.join(os.tmpdir(), "acct-gates-"));
process.env.AUTH_TOKEN_SECRET = "acct-lab-synthetic-auth-token-secret-0123456789";
process.env.TRANSACTIONAL_EMAIL_ENABLED = "true";
process.env.RESEND_API_KEY = "re_lab_synthetic";
process.env.TRANSACTIONAL_EMAIL_FROM = "Dubiz <no-reply@example.com>";
process.env.APP_BASE_URL = "https://app.example.com";
process.env.AUTH_PLANE_ENABLED = "true";
process.env.AUTH_DATABASE_URL = process.env.AUTH_DATABASE_URL || process.env.OWNER_URL;
// The switches under test start at their shipped defaults: absent.
delete process.env.ACCOUNTANT_SWEEP_ENABLED;
delete process.env.ACCOUNTANT_DELIVERY_ENABLED;
delete process.env.RESEND_WEBHOOK_SECRET;
delete process.env.CRON_SECRET;

import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

// Any outbound call would be a send (or a leak): count them, never perform them.
let networkCalls = 0;
globalThis.fetch = (async () => {
  networkCalls++;
  throw new Error("network is not allowed in the gates battery");
}) as typeof fetch;

async function main() {
  const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

  /** Every table of the public schema: row count + an order-independent content hash. */
  async function fingerprint(): Promise<Map<string, string>> {
    const tables = (await owner.$queryRawUnsafe(
      `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`
    )) as { t: string }[];
    const out = new Map<string, string>();
    for (const { t } of tables) {
      const r = (await owner.$queryRawUnsafe(
        `SELECT count(*)::text AS n, coalesce(md5(string_agg(md5(x::text), '' ORDER BY md5(x::text))), '-') AS h FROM "${t}" x`
      )) as { n: string; h: string }[];
      out.set(t, `${r[0].n}:${r[0].h}`);
    }
    return out;
  }
  function changed(a: Map<string, string>, b: Map<string, string>): string[] {
    const names = new Set([...a.keys(), ...b.keys()]);
    return [...names].filter((t) => a.get(t) !== b.get(t));
  }
  const accountantRows = async () =>
    Number(((await owner.$queryRawUnsafe(`SELECT (
        (SELECT count(*) FROM "AccountantPeriod") + (SELECT count(*) FROM "AccountantPackage") +
        (SELECT count(*) FROM "AccountantRecipient") + (SELECT count(*) FROM "AccountantDelivery") +
        (SELECT count(*) FROM "AccountantWorkflowEvent"))::int AS n`)) as { n: number }[])[0].n);

  // ── Fixtures (owner): two businesses with a closed month of documents; the flag OFF (its default) ──
  const one = async (sql: string, ...a: unknown[]) => Number(((await owner.$queryRawUnsafe(sql, ...a)) as { id: number }[])[0].id);
  const bizA = await one(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('gates-A', now()) RETURNING "id"`);
  const bizB = await one(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('gates-B', now()) RETURNING "id"`);
  const userA = await one(`INSERT INTO "User" ("email", "password", "businessId", "updatedAt") VALUES ('owner-a@gates.lab', 'x', $1, now()) RETURNING "id"`, bizA);
  const now = new Date();
  const prevMonthDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 12, 8, 0, 0)).toISOString().slice(0, 19);
  for (const b of [bizA, bizB]) {
    const d = await one(`INSERT INTO "Document" ("businessId", "fileUrl", "source", "mimeType", "status", "createdAt") VALUES ($1, $2, 'file', 'application/pdf', 'approved', $3::timestamp) RETURNING "id"`, b, `doc-gates-${b}.pdf`, prevMonthDay);
    await owner.$executeRawUnsafe(`INSERT INTO "FinancialRecord" ("documentId", "businessId", "amount", "date", "vendorName", "direction", "category") VALUES ($1, $2, 100, $3::timestamp, 'ספק', 'expense', 'general')`, d, b, prevMonthDay);
  }
  const flagRows = Number(((await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "BusinessFeatureAccess" WHERE "featureKey" = 'accountant_month_close'`)) as { n: number }[])[0].n);
  const def = (await owner.$queryRawUnsafe(`SELECT "defaultEnabled" AS d FROM "PlatformFeatureDefinition" WHERE key = 'accountant_month_close'`)) as { d: boolean }[];
  ok("the flag ships OFF: defaultEnabled false, no business override", def.length === 1 && def[0].d === false && flagRows === 0, JSON.stringify({ def, flagRows }));

  const sweepRoute = await import("@/app/api/accountant/sweep/route");
  const periodsRoute = await import("@/app/api/accountant/periods/route");
  const linkRoute = await import("@/app/api/accountant/link/open/route");
  const webhookRoute = await import("@/app/api/webhooks/resend/route");
  const del = await import("@/lib/accountant/delivery.service");
  const { accountantWorkflowEnabled } = await import("@/lib/accountant/http");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { signAuthToken } = await import("@/lib/auth-token");
  const SECRET = "gates-lab-cron-secret-0123456789abcdef0123456789";
  const cronReq = (auth?: string) => new NextRequest("https://app.example.com/api/accountant/sweep", { headers: auth ? { authorization: auth } : {} });

  const before = await fingerprint();

  // ── A. The sweep endpoint (the Vercel cron target) ───────────────────────────────────────────────
  console.log("A. the sweep endpoint, switches at their defaults");
  let r = await sweepRoute.GET(cronReq(`Bearer ${SECRET}`));
  ok("A1 no CRON_SECRET configured → 503, nothing run", r.status === 503, String(r.status));
  process.env.CRON_SECRET = SECRET;
  r = await sweepRoute.GET(cronReq());
  ok("A2 no bearer → 401", r.status === 401, String(r.status));
  r = await sweepRoute.GET(cronReq("Bearer not-the-secret-0123456789abcdef0123456789"));
  ok("A3 a wrong bearer → 401", r.status === 401, String(r.status));
  r = await sweepRoute.GET(cronReq(`Bearer ${SECRET}`));
  let body = (await r.json()) as { ok?: boolean; enabled?: boolean; summary?: unknown };
  ok("A4 the cron's own call with ACCOUNTANT_SWEEP_ENABLED unset → 200 { enabled: false }, no summary (nothing ran)", r.status === 200 && body.enabled === false && body.summary === undefined, JSON.stringify(body));
  for (const v of ["false", "TRUE", "1", "yes", " true1"]) {
    process.env.ACCOUNTANT_SWEEP_ENABLED = v;
    r = await sweepRoute.POST(cronReq(`Bearer ${SECRET}`));
    body = (await r.json()) as typeof body;
    ok(`A5 ACCOUNTANT_SWEEP_ENABLED="${v}" is not "true" → still inert`, r.status === 200 && body.enabled === false, JSON.stringify(body));
  }
  delete process.env.ACCOUNTANT_SWEEP_ENABLED;
  const afterA = await fingerprint();
  ok("A6 not one row changed in any table", changed(before, afterA).length === 0, changed(before, afterA).join(", "));

  // ── B. G2 alone: the sweep on, the feature off everywhere ────────────────────────────────────────
  console.log("B. G2 alone (sweep on, feature off for every business)");
  process.env.ACCOUNTANT_SWEEP_ENABLED = "true";
  r = await sweepRoute.GET(cronReq(`Bearer ${SECRET}`));
  body = (await r.json()) as typeof body;
  const sum = body.summary as { eligible?: number; built?: number; businessErrors?: number } | undefined;
  ok("B1 the sweep runs and finds no eligible business", r.status === 200 && body.enabled === true && sum?.eligible === 0 && sum?.built === 0 && sum?.businessErrors === 0, JSON.stringify(body));
  const afterB = await fingerprint();
  ok("B2 no period, package, recipient, delivery or event — and not one row anywhere", (await accountantRows()) === 0 && changed(before, afterB).length === 0, changed(before, afterB).join(", "));
  delete process.env.ACCOUNTANT_SWEEP_ENABLED;

  // ── C. Owner routes, flag off ────────────────────────────────────────────────────────────────────
  console.log("C. owner routes with the flag off");
  ok("C1 the workflow is disabled for both businesses", !(await runWithTenantContext({ businessId: bizA }, () => accountantWorkflowEnabled(bizA))) && !(await runWithTenantContext({ businessId: bizB }, () => accountantWorkflowEnabled(bizB))));
  r = await periodsRoute.GET(new Request("https://app.example.com/api/accountant/periods"));
  ok("C2 no session → 401", r.status === 401, String(r.status));
  const token = signAuthToken(userA, 0);
  r = await periodsRoute.GET(new Request("https://app.example.com/api/accountant/periods", { headers: { authorization: `Bearer ${token}` } }));
  ok("C3 the signed-in owner, flag off → 404 (the route does not exist for the business)", r.status === 404, String(r.status));

  // ── D. Sending ───────────────────────────────────────────────────────────────────────────────────
  console.log("D. sending, ACCOUNTANT_DELIVERY_ENABLED unset");
  ok("D1 deliveryEnabled() is false", del.deliveryEnabled() === false);
  let code = "";
  try {
    await del.approveDelivery({ businessId: bizA, userId: userA, periodKey: "2026-09", packageId: 1, packageSha256: "0".repeat(64), recipientVersion: 1, recipientEmail: "acc@example.com", acknowledgeIncomplete: true, idempotencyKey: "send:gates-0000000001", now });
  } catch (e) { code = (e as { code?: string }).code ?? String(e); }
  ok("D2 an approval is refused before anything is read: DELIVERY_DISABLED", code === "DELIVERY_DISABLED", code);
  ok("D3 a send attempt is 'disabled'", (await runWithTenantContext({ businessId: bizA }, () => del.attemptDelivery(bizA, 1, now))) === "disabled");
  ok("D4 the retry path sends nothing", (await runWithTenantContext({ businessId: bizA }, () => del.processDueDeliveries(bizA, now))) === 0);

  // ── E. The public link ───────────────────────────────────────────────────────────────────────────
  console.log("E. the public link");
  const linkReq = (b: unknown) => new Request("https://app.example.com/api/accountant/link/open", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" }, body: JSON.stringify(b) });
  const r1 = await linkRoute.POST(linkReq({ publicId: "x", token: "y", mode: "download" }));
  const r2 = await linkRoute.POST(linkReq({ publicId: "A".repeat(32), token: "B".repeat(43), mode: "download" }));
  const b1 = await r1.text(), b2 = await r2.text();
  ok("E1 a malformed link and a well-formed unknown link get the same 404", (r1.status === 404 && r2.status === 404 && b1 === b2), `${r1.status} ${b1} | ${r2.status} ${b2}`);

  // ── F. The provider webhook ──────────────────────────────────────────────────────────────────────
  console.log("F. the provider webhook");
  const hookReq = () => new Request("https://app.example.com/api/webhooks/resend", { method: "POST", headers: { "content-type": "application/json", "svix-id": "msg_x", "svix-timestamp": String(Math.floor(Date.now() / 1000)), "svix-signature": "v1,Zm9yZ2Vk" }, body: JSON.stringify({ type: "email.delivered", data: { email_id: "re_1" } }) });
  r = await webhookRoute.POST(hookReq());
  ok("F1 no RESEND_WEBHOOK_SECRET → 503 for everything", r.status === 503, String(r.status));
  process.env.RESEND_WEBHOOK_SECRET = "whsec_" + Buffer.from("gates-lab-webhook-secret-0123456789").toString("base64");
  r = await webhookRoute.POST(hookReq());
  ok("F2 with the secret, a forged signature → 401", r.status === 401, String(r.status));
  delete process.env.RESEND_WEBHOOK_SECRET;

  const afterF = await fingerprint();
  ok("A–F: not one row changed anywhere, and no network call was made", changed(before, afterF).length === 0 && networkCalls === 0, `${changed(before, afterF).join(", ")} | network ${networkCalls}`);

  // ── G. Positive control ──────────────────────────────────────────────────────────────────────────
  console.log("G. positive control: the flag on for ONE business, the sweep on");
  await owner.$executeRawUnsafe(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") VALUES ($1, 'accountant_month_close', 'ENABLED', now())`, bizA);
  process.env.ACCOUNTANT_SWEEP_ENABLED = "true";
  r = await sweepRoute.GET(cronReq(`Bearer ${SECRET}`));
  body = (await r.json()) as typeof body;
  const sumG = body.summary as { eligible?: number; built?: number } | undefined;
  const periods = (await owner.$queryRawUnsafe(`SELECT "businessId" AS b FROM "AccountantPeriod"`)) as { b: number }[];
  ok("G1 the enabled business's closed month is prepared, and only that business", r.status === 200 && sumG?.eligible === 1 && sumG?.built === 1 && periods.length === 1 && periods[0].b === bizA, JSON.stringify({ body, periods }));
  code = "";
  try {
    await del.approveDelivery({ businessId: bizA, userId: userA, periodKey: "2026-09", packageId: 1, packageSha256: "0".repeat(64), recipientVersion: 1, recipientEmail: "acc@example.com", acknowledgeIncomplete: true, idempotencyKey: "send:gates-0000000002", now });
  } catch (e) { code = (e as { code?: string }).code ?? String(e); }
  ok("G2 even with the flag and the sweep on, sending stays refused until G4", code === "DELIVERY_DISABLED" && networkCalls === 0, `${code} | network ${networkCalls}`);
  delete process.env.ACCOUNTANT_SWEEP_ENABLED;

  await owner.$disconnect();
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => process.exit());
