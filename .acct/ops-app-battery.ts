/**
 * Accountant package operations monitoring (G5 milestone 1: M2 monitor + M1 delivery tracking) — end to end on the
 * Production-shaped lab (.acct/ops-app-lab.sh: the accountant workflow, its link events and the three 20261107
 * migrations applied by `prisma migrate deploy`), as the real roles: the runtime (app_runtime_prod, NOBYPASSRLS), the
 * console (app_admin_lab) and the owner (lab_owner, for fixtures only). The REAL services, routes and Resend adapter;
 * the network is a Resend emulator (fetch) that, like Resend, keeps one message per Idempotency-Key. Nothing leaves
 * the box.
 *
 *   1. healthy: a prepared, delivered month and a good sweep → the monitor finds nothing and sends nothing;
 *   2. M1 webhook: signatures (missing secret, forged, stale), malformed / unknown events and messages, delivered,
 *      a duplicate, bounced after delivered, a late delivered after bounced, a spam complaint (audit event + owner
 *      notice, NO status change) and its duplicate, a temporary database failure (500) and Resend's retry;
 *   3. every fault of the plan, each in its own business: exactly the expected findings, ONE email, nothing else;
 *   4. the email: to the operator only; codes, ids and months — no address, link, token or business name;
 *   5. dedupe: the next run sends nothing; two monitors at once → one alert, one email;
 *   6. the alert channel failing (provider 503, no address): claims given back, the run FAILED (endpoint 500); the
 *      next run sends the SAME items under the SAME idempotency key;
 *   7. a business that could not be evaluated keeps its alerts (never resolved by a partial run);
 *   8. reminders after 24 h (not for the complaint), once; recovery → one "resolved" notice;
 *   9. the endpoint: auth, switched off (no database), Vercel vs GitHub source, the safe simulation (no database);
 *   9b. a run that died after claiming: the next run recovers its claims, sends them once, closes it "abandoned";
 *  10. isolation: each alert in its own business, under RLS; a business without the feature has none;
 *  11. the console's read: alerts with business names, runs, no address anywhere; without the grant → "not granted";
 *  12. nothing of the workflow changed: packages, stored ZIPs, documents, the trail (the monitor writes none of it);
 *  13. the sweep: each run recorded with its own summary (only while the monitor is on); a broken run log changes
 *      nothing about the sweep.
 *
 * env: OWNER_URL, DATABASE_URL (runtime), ADMIN_DATABASE_URL (console). Synthetic only. ZERO real network.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";

process.env.TZ = "UTC";
process.env.STORAGE_PROVIDER = "local";
process.env.LOCAL_STORAGE_ROOT = mkdtempSync(path.join(os.tmpdir(), "acct-ops-"));
process.env.AUTH_TOKEN_SECRET = "acct-lab-synthetic-auth-token-secret-0123456789";
process.env.TRANSACTIONAL_EMAIL_ENABLED = "true";
process.env.RESEND_API_KEY = "re_lab_synthetic";
process.env.TRANSACTIONAL_EMAIL_FROM = "Dubiz <no-reply@example.com>";
process.env.APP_BASE_URL = "https://app.example.com";
process.env.ACCOUNTANT_DELIVERY_ENABLED = "true";
process.env.ACCOUNTANT_SWEEP_ENABLED = "true";
process.env.ACCOUNTANT_MONITOR_ENABLED = "true";
process.env.ACCOUNTANT_OPS_ALERT_EMAIL = "ops@example.org";
process.env.CRON_SECRET = "acct-ops-lab-synthetic-cron-secret-0123456789";
const WEBHOOK_KEY = Buffer.from("acct-ops-lab-synthetic-webhook-key-0123456789");
process.env.RESEND_WEBHOOK_SECRET = `whsec_${WEBHOOK_KEY.toString("base64")}`;
process.env.RATE_LIMIT_BACKEND = "memory";
process.env.AUTH_PLANE_ENABLED = "true";
process.env.AUTH_DATABASE_URL = process.env.AUTH_DATABASE_URL || process.env.OWNER_URL;

import { PrismaClient } from "@prisma/client";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
type Json = Record<string, unknown>;
/** JSON with sorted keys — PostgreSQL's jsonb does not keep key order. */
const canon = (v: unknown): string =>
  v && typeof v === "object" && !Array.isArray(v)
    ? `{${Object.keys(v as Json).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Json)[k])}`).join(",")}}`
    : JSON.stringify(v);

// ── The Resend emulator ─────────────────────────────────────────────────────────────────────────
type Mode = "sent" | "503" | "422" | "timeout";
let mode: Mode = "sent"; // the accountant's emails
let alertMode: "sent" | "503" = "sent"; // the operator's alert emails
type Call = { key: string; to: string; subject: string; text: string; html: string };
const calls: Call[] = [];
const messages = new Map<string, string>();
let otherNetwork = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith("https://api.resend.com/")) { otherNetwork++; throw new Error("no network"); }
  const key = String((init?.headers as Record<string, string>)["Idempotency-Key"]);
  const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string; html: string };
  calls.push({ key, to: body.to[0], subject: body.subject, text: body.text, html: body.html });
  const accept = () => { if (!messages.has(key)) messages.set(key, `msg_lab_${messages.size + 1}`); };
  const m = key.startsWith("acctops") ? alertMode : mode;
  if (m === "timeout") { accept(); const e = new Error("The operation timed out"); e.name = "TimeoutError"; throw e; }
  if (m === "503") return new Response(JSON.stringify({ name: "internal_server_error" }), { status: 503 });
  if (m === "422") return new Response(JSON.stringify({ name: "validation_error" }), { status: 422 });
  accept();
  return new Response(JSON.stringify({ id: messages.get(key) }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
const alertCalls = () => calls.filter((c) => c.key.startsWith("acctops"));

async function main() {
  const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { getStorageService } = await import("@/lib/storage");
  const { putDocumentObject } = await import("@/lib/services/documents/document-storage.service");
  const prep = await import("@/lib/accountant/prepare.service");
  const del = await import("@/lib/accountant/delivery.service");
  const { setRecipient } = await import("@/lib/accountant/recipient.service");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const { getPeriodView } = await import("@/lib/accountant/view.service");
  const { complaintHe } = await import("@/components/accountant/labels");
  const monitor = await import("@/lib/accountant/ops/monitor");
  const monitorRoute = await import("@/app/api/accountant/monitor/route");
  const sweepRoute = await import("@/app/api/accountant/sweep/route");
  const webhook = await import("@/app/api/webhooks/resend/route");
  const adminOps = await import("@/lib/services/platform-admin/accountant-ops.service");
  const adminRoute = await import("@/app/api/platform-admin/accountant-ops/route");
  const storage = getStorageService();
  const KEY = "2026-09";

  for (const t of ["FinancialRecord", "Document", "BillingDocument", "BillingAuthoritySubmission", "Notification", "NotificationDelivery", "BusinessProfile", "BusinessFeatureAccess"]) {
    const on = (await owner.$queryRawUnsafe(`SELECT relforcerowsecurity AS f FROM pg_class WHERE relname = $1`, t)) as { f: boolean }[];
    if (on[0]?.f) continue;
    await owner.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`CREATE POLICY acct_lab_tenant ON "${t}" FOR ALL
      USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
      WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)`);
  }

  // ── Fixtures ───────────────────────────────────────────────────────────────────────────────────
  const one = async (sql: string, ...a: unknown[]) => Number(((await owner.$queryRawUnsafe(sql, ...a)) as { id: number }[])[0].id);
  let n = 0;
  const names: string[] = [];
  const business = async (name: string, enabled = true) => {
    names.push(name);
    const b = await one(`INSERT INTO "Business" ("name", "updatedAt") VALUES ($1, now()) RETURNING "id"`, name);
    const u = await one(`INSERT INTO "User" ("email", "password", "businessId", "updatedAt") VALUES ($1, 'x', $2, now()) RETURNING "id"`, `owner-${b}@ops.lab`, b);
    if (enabled) await owner.$executeRawUnsafe(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") VALUES ($1, 'accountant_month_close', 'ENABLED', now())`, b);
    await owner.$executeRawUnsafe(`INSERT INTO "BusinessProfile" ("businessId", "billingLegalName", "billingTaxId", "updatedAt") VALUES ($1, $2, '515151515', now())`, b, `${name} בע"מ`);
    for (const day of ["05", "12"]) {
      const body = Buffer.from(`%PDF-1.4 ops ${name} ${++n}`);
      const basename = `doc-${Date.now()}${n}-ops.pdf`;
      await putDocumentObject({ businessId: b, basename, body, contentType: "application/pdf", source: "file" });
      const d = await one(`INSERT INTO "Document" ("businessId", "fileUrl", "source", "mimeType", "status", "createdAt", "contentHashSha256") VALUES ($1, $2, 'file', 'application/pdf', 'approved', $3::timestamp, $4) RETURNING "id"`,
        b, basename, `2026-09-${day}T08:00:00`, sha(body));
      await owner.$executeRawUnsafe(`INSERT INTO "FinancialRecord" ("documentId", "businessId", "amount", "date", "vendorName", "direction", "category") VALUES ($1, $2, 99.9, $3::timestamp, 'ספק', 'expense', 'general')`, d, b, `2026-09-${day}T00:00:00`);
    }
    return { b, u, name };
  };
  type Biz = Awaited<ReturnType<typeof business>>;
  const inB = <T>(b: number, fn: () => Promise<T>) => runWithTenantContext({ businessId: b }, fn);
  const now = new Date();
  const prepare = (x: Biz, at = now) =>
    inB(x.b, () => prep.preparePeriod({ businessId: x.b, periodKey: KEY, trigger: "SCHEDULE", actor: { type: "SYSTEM" } }, { ...prep.defaultPrepareDeps, now: () => at }));
  const recipient = (x: Biz) =>
    inB(x.b, () => setRecipient({ businessId: x.b, userId: x.u, name: "רו\"ח דנה", email: `cpa-${x.b}@accountants.example`, expectedVersion: null, confirm: true, now }));
  const approve = async (x: Biz) => {
    const p = await owner.accountantPackage.findFirstOrThrow({ where: { businessId: x.b, status: "READY" } });
    const rc = await owner.accountantRecipient.findUniqueOrThrow({ where: { businessId: x.b } });
    return inB(x.b, () => del.approveDelivery({ businessId: x.b, userId: x.u, periodKey: KEY, packageId: p.id, packageSha256: p.sha256!, recipientVersion: rc.version,
      recipientEmail: rc.email, acknowledgeIncomplete: true, idempotencyKey: `send:ops-${x.b}-${Math.random().toString(36).slice(2)}`, now }));
  };
  const sendNow = async (x: Biz) => {
    const a = await approve(x);
    mode = "sent";
    await inB(x.b, () => del.attemptDelivery(x.b, a.deliveryId, now));
    return owner.accountantDelivery.findUniqueOrThrow({ where: { id: a.deliveryId } });
  };
  const ready = async (x: Biz) => { await prepare(x); await recipient(x); };
  const bizAlerts = (b: number) => owner.accountantBusinessAlert.findMany({ where: { businessId: b }, orderBy: { id: "asc" } });
  const sweepRun = (outcome: "OK" | "FAILED" | "RUNNING", startedAt: Date) =>
    owner.accountantOpsRun.create({ data: { kind: "SWEEP", source: "VERCEL_CRON", startedAt, finishedAt: outcome === "RUNNING" ? null : new Date(startedAt.getTime() + 20_000), outcome } });
  // A monitor run from GitHub; the Vercel Cron channel is shown alive at the same moment (each channel watches the
  // other — section 11b tests that on its own).
  const run = async (at: Date, over: Partial<Parameters<typeof monitor.runAccountantMonitor>[1]> = {}) => {
    await owner.accountantOpsRun.create({ data: { kind: "MONITOR", source: "VERCEL_CRON", startedAt: at, finishedAt: at, outcome: "OK" } });
    return monitor.runAccountantMonitor("GITHUB_ACTIONS", { ...monitor.defaultMonitorDeps, now: () => at, ...over });
  };

  // Signed Resend webhook calls (the Svix scheme Resend uses).
  let msgSeq = 0;
  const signed = (payload: Json, opts: { ts?: number; secret?: Buffer; sig?: string } = {}) => {
    const raw = JSON.stringify(payload);
    const id = `msg_${++msgSeq}`;
    const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
    const sig = opts.sig ?? createHmac("sha256", opts.secret ?? WEBHOOK_KEY).update(`${id}.${ts}.${raw}`).digest("base64");
    return new Request("https://app.example.com/api/webhooks/resend", {
      method: "POST", body: raw, headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}`, "content-type": "application/json" },
    });
  };
  const hook = async (type: string, messageId: string, opts: Parameters<typeof signed>[1] = {}) => {
    const r = await webhook.POST(signed({ type, created_at: new Date().toISOString(), data: { email_id: messageId } }, opts));
    return { s: r.status, j: (await r.json()) as Json };
  };
  const trail = (deliveryId: number, type: string) => owner.accountantWorkflowEvent.count({ where: { deliveryId, eventType: type } });

  // ── 1. Healthy ─────────────────────────────────────────────────────────────────────────────────
  console.log("1. healthy");
  const A = await business("מאפיית הבוקר");
  await ready(A);
  const dA = await sendNow(A);
  ok("1a fixture: A's month was sent and accepted", dA.status === "ACCEPTED" && !!dA.providerMessageId, dA.status);
  let h = await hook("email.delivered", dA.providerMessageId!);
  ok("1b the provider's delivered event → DELIVERED, with its trail event", h.s === 200 && (await owner.accountantDelivery.findUniqueOrThrow({ where: { id: dA.id } })).status === "DELIVERED" &&
    (await trail(dA.id, "DELIVERY_DELIVERED")) === 1, JSON.stringify(h));
  await sweepRun("OK", new Date(now.getTime() - 10 * 60_000));
  // The monitor has watched for a while (no "never ran" grace needed in this lab).
  await owner.accountantOpsRun.create({ data: { kind: "MONITOR", source: "VERCEL_CRON", startedAt: new Date(now.getTime() - 30 * 86400_000), finishedAt: new Date(now.getTime() - 30 * 86400_000 + 1000), outcome: "OK" } });
  let before = alertCalls().length;
  let r = await run(now);
  ok("1c a healthy business and a good sweep: no finding, no alert, no email", r.ok && r.counts.findings === 0 && r.counts.opened === 0 && alertCalls().length === before && r.notification === "none", JSON.stringify(r.counts));
  const monRun = await owner.accountantOpsRun.findFirstOrThrow({ where: { kind: "MONITOR" }, orderBy: { id: "desc" } });
  ok("1d the monitor's own run is recorded OK with counts only", monRun.outcome === "OK" && monRun.source === "GITHUB_ACTIONS" && !!monRun.finishedAt && !JSON.stringify(monRun.counts).includes('"'.concat("@")));

  // ── 2. M1 — the delivery webhook ───────────────────────────────────────────────────────────────
  console.log("2. the delivery webhook (M1)");
  const B = await business("acct-ops-B"); await ready(B);
  const C = await business("acct-ops-C"); await ready(C);
  const E = await business("acct-ops-E"); await ready(E);
  const dB = await sendNow(B);
  const dC = await sendNow(C);
  const dE = await sendNow(E);
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  delete process.env.RESEND_WEBHOOK_SECRET;
  h = await hook("email.delivered", dB.providerMessageId!);
  ok("2a no RESEND_WEBHOOK_SECRET → 503, nothing applied", h.s === 503 && (await owner.accountantDelivery.findUniqueOrThrow({ where: { id: dB.id } })).status === "ACCEPTED");
  process.env.RESEND_WEBHOOK_SECRET = secret;
  h = await hook("email.delivered", dB.providerMessageId!, { secret: Buffer.from("another-key-that-is-not-ours-0123456789") });
  ok("2b a forged signature → 401, nothing applied", h.s === 401 && (await owner.accountantDelivery.findUniqueOrThrow({ where: { id: dB.id } })).status === "ACCEPTED");
  h = await hook("email.delivered", dB.providerMessageId!, { ts: Math.floor(Date.now() / 1000) - 11 * 60 });
  ok("2c a stale timestamp (replay outside the window) → 401", h.s === 401);
  const malformed = await webhook.POST((() => {
    const raw = "{not json"; const id = "msg_bad"; const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", WEBHOOK_KEY).update(`${id}.${ts}.${raw}`).digest("base64");
    return new Request("https://app.example.com/api/webhooks/resend", { method: "POST", body: raw, headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` } });
  })());
  ok("2d a signed but malformed body → 200 ignored", malformed.status === 200 && ((await malformed.json()) as Json).ignored === "malformed");
  h = await hook("email.opened", dB.providerMessageId!);
  ok("2e an event we do not track → 200 ignored", h.s === 200 && h.j.ignored === "event");
  h = await hook("email.delivered", "msg_not_ours_42");
  ok("2f a message that is not an accountant delivery (account email, operator alert) → 200 ignored", h.s === 200 && h.j.ignored === "unknown_message");
  h = await hook("email.delivered", dB.providerMessageId!);
  ok("2g delivered → DELIVERED", h.s === 200 && (await owner.accountantDelivery.findUniqueOrThrow({ where: { id: dB.id } })).status === "DELIVERED");
  h = await hook("email.delivered", dB.providerMessageId!);
  ok("2h the same event again → nothing changes, one trail event", h.s === 200 && (await trail(dB.id, "DELIVERY_DELIVERED")) === 1);
  h = await hook("email.bounced", dB.providerMessageId!);
  const bAfter = await owner.accountantDelivery.findUniqueOrThrow({ where: { id: dB.id } });
  ok("2i bounced after delivered → BOUNCED (allowed), the month SEND_FAILED, the owner notified in the app",
    bAfter.status === "BOUNCED" && (await owner.accountantPeriod.findFirstOrThrow({ where: { businessId: B.b, periodKey: KEY } })).status === "SEND_FAILED" &&
    (await owner.notification.count({ where: { businessId: B.b, resolvedAt: null, title: { contains: "נכשלה" } } })) === 1);
  h = await hook("email.delivered", dB.providerMessageId!);
  ok("2j a late delivered after the bounce → ignored, still BOUNCED", h.s === 200 && (await owner.accountantDelivery.findUniqueOrThrow({ where: { id: dB.id } })).status === "BOUNCED" &&
    (await trail(dB.id, "DELIVERY_DELIVERED")) === 1);
  await hook("email.delivered", dC.providerMessageId!); // Resend reports delivered, then the complaint
  const cBefore = await owner.accountantDelivery.findUniqueOrThrow({ where: { id: dC.id } });
  h = await hook("email.complained", dC.providerMessageId!);
  const cAfter = await owner.accountantDelivery.findUniqueOrThrow({ where: { id: dC.id } });
  ok("2k a spam complaint → ONE audit event, the delivery and the month unchanged",
    h.s === 200 && (await trail(dC.id, "DELIVERY_COMPLAINED")) === 1 && cBefore.status === "DELIVERED" && cAfter.status === "DELIVERED" && cAfter.updatedAt.getTime() === cBefore.updatedAt.getTime() &&
    (await owner.accountantPeriod.findFirstOrThrow({ where: { businessId: C.b, periodKey: KEY } })).status === "SENT");
  const complaintNotices = await owner.notification.findMany({ where: { businessId: C.b, resolvedAt: null, title: { contains: "ספאם" } } });
  ok("2l …and ONE in-app notice to the owner, linking to the month", complaintNotices.length === 1 && complaintNotices[0].href === `/documents/accountant-pack?period=${KEY}`, JSON.stringify(complaintNotices.map((x) => x.title)));
  h = await hook("email.complained", dC.providerMessageId!);
  ok("2m the same complaint again → still one event, one notice", h.s === 200 && (await trail(dC.id, "DELIVERY_COMPLAINED")) === 1 &&
    (await owner.notification.count({ where: { businessId: C.b, resolvedAt: null, title: { contains: "ספאם" } } })) === 1);
  const viewC = await inB(C.b, () => getPeriodView(C.b, KEY));
  ok("2n the owner's screen: still 'delivered', plus the complaint line", viewC!.deliveries[0].status === "DELIVERED" && !!viewC!.deliveries[0].complainedAt &&
    (complaintHe(viewC!.deliveries[0]) ?? "").includes("ספאם"));
  await owner.$executeRawUnsafe(`REVOKE EXECUTE ON FUNCTION public.accountant_delivery_by_provider_message(text, text) FROM app_runtime`);
  h = await hook("email.delivered", dE.providerMessageId!);
  ok("2o a temporary database failure → 500 (Resend retries), nothing applied", h.s === 500 && (await owner.accountantDelivery.findUniqueOrThrow({ where: { id: dE.id } })).status === "ACCEPTED");
  await owner.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION public.accountant_delivery_by_provider_message(text, text) TO app_runtime`);
  h = await hook("email.delivered", dE.providerMessageId!);
  ok("2p Resend's retry after recovery → applied once", h.s === 200 && (await owner.accountantDelivery.findUniqueOrThrow({ where: { id: dE.id } })).status === "DELIVERED" && (await trail(dE.id, "DELIVERY_DELIVERED")) === 1);
  ok("2q the provider's message ids map to their own business only (no cross-business apply)",
    (await owner.accountantWorkflowEvent.count({ where: { deliveryId: dC.id, businessId: { not: C.b } } })) === 0);

  // ── 3. Every fault, each in its own business ───────────────────────────────────────────────────
  console.log("3. every fault of the plan");
  const G = await business("acct-ops-G");                     // not prepared by the deadline
  const H = await business("acct-ops-H"); await prepare(H);   // preparation failing for hours
  await owner.$executeRawUnsafe(`UPDATE "AccountantPeriod" SET "status" = 'PREPARATION_FAILED', "evaluatedAt" = $2::timestamp WHERE "businessId" = $1`, H.b, new Date(now.getTime() - 4 * 3600_000).toISOString());
  const K = await business("acct-ops-K"); await prepare(K);   // a build stuck BUILDING
  const pK = await owner.accountantPeriod.findFirstOrThrow({ where: { businessId: K.b } });
  await owner.$executeRawUnsafe(`INSERT INTO "AccountantPackage" ("businessId", "periodId", "version", "contentFingerprint", "status", "createdAt") VALUES ($1, $2, 2, $3, 'BUILDING', $4::timestamp)`,
    K.b, pK.id, "f".repeat(64), new Date(now.getTime() - 2 * 3600_000).toISOString());
  const R = await business("acct-ops-R"); await ready(R);     // a retry the sweep never ran
  const aR = await approve(R);
  mode = "503";
  await inB(R.b, () => del.attemptDelivery(R.b, aR.deliveryId, now));
  await owner.$executeRawUnsafe(`UPDATE "AccountantDelivery" SET "nextAttemptAt" = $2::timestamp WHERE "id" = $1`, aR.deliveryId, new Date(now.getTime() - 3 * 3600_000).toISOString());
  const S = await business("acct-ops-S"); await ready(S);     // a worker died mid-send
  const aS = await approve(S);
  await owner.$executeRawUnsafe(`UPDATE "AccountantDelivery" SET "status" = 'SENDING', "leaseUntil" = $2::timestamp WHERE "id" = $1`, aS.deliveryId, new Date(now.getTime() - 3600_000).toISOString());
  const U = await business("acct-ops-U"); await ready(U);     // no answer on every attempt
  const aU = await approve(U);
  mode = "timeout";
  let clock = now;
  await inB(U.b, () => del.attemptDelivery(U.b, aU.deliveryId, clock));
  for (let i = 0; i < 8; i++) { clock = new Date(clock.getTime() + 7 * 3600_000); await inB(U.b, () => del.processDueDeliveries(U.b, clock)); }
  const F = await business("acct-ops-F"); await ready(F);     // refused by the provider
  const aF = await approve(F);
  mode = "422";
  await inB(F.b, () => del.attemptDelivery(F.b, aF.deliveryId, now));
  mode = "sent";
  const W = await business("acct-ops-W"); await ready(W);     // accepted 30 h ago, no event since
  const dW = await sendNow(W);
  await owner.$executeRawUnsafe(`UPDATE "AccountantDelivery" SET "acceptedAt" = $2::timestamp WHERE "id" = $1`, dW.id, new Date(now.getTime() - 30 * 3600_000).toISOString());
  const D = await business("acct-ops-D", false);              // no feature: never looked at
  ok("3a fixtures: U uncertain, F refused, both months SEND_FAILED",
    (await owner.accountantDelivery.findUniqueOrThrow({ where: { id: aU.deliveryId } })).failureCode?.startsWith("timeout") === true &&
    (await owner.accountantDelivery.findUniqueOrThrow({ where: { id: aF.deliveryId } })).failureCode === "rejected_422" &&
    (await owner.accountantPeriod.count({ where: { businessId: { in: [U.b, F.b] }, status: "SEND_FAILED" } })) === 2);

  const snapshot = async () => {
    const pkgs = await owner.accountantPackage.findMany({ orderBy: { id: "asc" } });
    const zips = await Promise.all(pkgs.filter((p) => p.storageKey).map(async (p) => sha((await storage.getObject(p.storageKey!)).body)));
    const docs = await owner.document.findMany({ select: { id: true, businessId: true, status: true, contentHashSha256: true }, orderBy: { id: "asc" } });
    const deliveries = await owner.accountantDelivery.findMany({ orderBy: { id: "asc" } });
    const periods = await owner.accountantPeriod.findMany({ orderBy: { id: "asc" } });
    const events = await owner.accountantWorkflowEvent.count();
    return JSON.stringify({ pkgs, zips, docs, deliveries, periods, events });
  };
  const frozen = await snapshot();
  const lastEventAtFreeze = (await owner.accountantWorkflowEvent.aggregate({ _max: { id: true } }))._max.id ?? 0;

  before = alertCalls().length;
  r = await run(now);
  const expected = new Map<number, string>([
    [G.b, "PACKAGE_NOT_PREPARED@p:2026-09"],
    [H.b, "PREPARATION_FAILED@p:2026-09"],
    [K.b, "PREPARATION_STUCK@p:2026-09"],
    [R.b, `RETRY_OVERDUE@d:${aR.deliveryId}`],
    [S.b, `SEND_STUCK@d:${aS.deliveryId}`],
    [U.b, `SEND_UNCERTAIN@d:${aU.deliveryId}`],
    [F.b, `DELIVERY_FAILED@d:${aF.deliveryId}`],
    [B.b, `DELIVERY_BOUNCED@d:${dB.id}`],
    [C.b, `DELIVERY_COMPLAINED@d:${dC.id}`],
    [W.b, `WEBHOOK_SILENT@d:${dW.id}`],
  ]);
  let exact = true;
  const got: string[] = [];
  for (const [b, want] of expected) {
    const rows = (await bizAlerts(b)).filter((a) => a.resolvedAt === null).map((a) => `${a.code}@${a.subjectKey}`);
    got.push(`${b}:${rows.join("+")}`);
    if (rows.length !== 1 || rows[0] !== want) exact = false;
  }
  ok("3b each fault → exactly its finding, in its own business", exact, got.join(" "));
  ok("3c the healthy businesses (A, E) and the one without the feature (D) have no alert",
    (await owner.accountantBusinessAlert.count({ where: { businessId: { in: [A.b, E.b, D.b] } } })) === 0);
  ok("3d no platform finding (the sweep ran, every business was evaluated)", (await owner.accountantOpsAlert.count({ where: { resolvedAt: null } })) === 0);
  ok("3e ONE email for all ten", alertCalls().length === before + 1 && r.notification === "sent" && r.counts.claimed === 10, `${alertCalls().length - before} ${r.notification} ${r.counts.claimed}`);

  // ── 4. The email ───────────────────────────────────────────────────────────────────────────────
  console.log("4. the operator's email");
  const mail = alertCalls()[alertCalls().length - 1];
  ok("4a to the operator's address only", mail.to === "ops@example.org");
  ok("4b it names every finding by its Hebrew title, business id and subject",
    mail.text.includes(`עסק #${G.b} · חודש 2026-09`) && mail.text.includes(`עסק #${S.b} · שליחה #${aS.deliveryId}`) && mail.text.includes("ספאם") && (mail.text.match(/^חדש · /gm) ?? []).length === 10, mail.text.slice(0, 300));
  const allText = mail.text + mail.html + mail.subject;
  ok("4c no address, portal link, token or provider id in it", !/accountants\.example|@ops\.lab|\/a\/[A-Za-z0-9_-]{32}|#t=|msg_lab_/.test(allText));
  ok("4d no business name in it", names.every((nm) => !allText.includes(nm)));
  ok("4e its only link is the console's monitoring page", (mail.text.match(/https?:\/\/\S+/g) ?? []).every((u) => u === "https://app.example.com/admin/accountant-ops"));

  // ── 5. Dedupe and concurrency ──────────────────────────────────────────────────────────────────
  console.log("5. no repeats");
  before = alertCalls().length;
  const rowsBefore = await owner.accountantBusinessAlert.count();
  r = await run(new Date(now.getTime() + 60_000));
  ok("5a the next run: same findings, nothing new, NO email", r.ok && r.counts.findings === 10 && r.counts.opened === 0 && r.counts.claimed === 0 && alertCalls().length === before);
  ok("5b …and still one alert row per finding", (await owner.accountantBusinessAlert.count()) === rowsBefore);
  await sweepRun("FAILED", new Date(now.getTime() + 90_000));
  before = alertCalls().length;
  const [r1, r2] = await Promise.all([run(new Date(now.getTime() + 120_000)), run(new Date(now.getTime() + 120_000))]);
  ok("5c two monitors at once on a new fault (the sweep failed) → one alert row, claimed once, ONE email",
    (await owner.accountantOpsAlert.count({ where: { code: "SWEEP_FAILED" } })) === 1 && r1.counts.claimed + r2.counts.claimed === 1 && alertCalls().length === before + 1 &&
    alertCalls()[alertCalls().length - 1].text.includes("הסריקה נכשלה"), `${r1.counts.claimed}+${r2.counts.claimed} ${alertCalls().length - before}`);

  // ── 6. The alert channel failing ───────────────────────────────────────────────────────────────
  console.log("6. the channel failing");
  await sweepRun("OK", new Date(now.getTime() + 150_000)); // SWEEP_FAILED recovers → a "resolved" notice is due
  alertMode = "503";
  before = alertCalls().length;
  r = await run(new Date(now.getTime() + 180_000));
  const failedKey = alertCalls()[alertCalls().length - 1]?.key;
  const sf = await owner.accountantOpsAlert.findFirstOrThrow({ where: { code: "SWEEP_FAILED" } });
  ok("6a the provider fails → the run FAILED, the claim given back (still due)", !r.ok && r.notification === "failed" && r.counts.released === 1 && sf.resolvedAt !== null && sf.resolvedNotifiedAt === null,
    JSON.stringify({ n: r.notification, rel: r.counts.released, res: sf.resolvedNotifiedAt }));
  const failedRun = await owner.accountantOpsRun.findFirstOrThrow({ where: { kind: "MONITOR" }, orderBy: { id: "desc" } });
  ok("6b the run log says FAILED with notify_failed", failedRun.outcome === "FAILED" && failedRun.errorCode === "notify_failed");
  alertMode = "sent";
  r = await run(new Date(now.getTime() + 240_000));
  const retried = alertCalls()[alertCalls().length - 1];
  ok("6c the next run sends the same item under the SAME idempotency key (the provider sends it once)",
    r.ok && r.notification === "sent" && retried.key === failedKey && retried.text.includes("נפתר") && messages.has(failedKey!), `${retried?.key} vs ${failedKey}`);
  ok("6d …and it is not sent a third time", (r = await run(new Date(now.getTime() + 300_000))).counts.claimed === 0);
  delete process.env.ACCOUNTANT_OPS_ALERT_EMAIL;
  const V = await business("acct-ops-V"); // a new fault (not prepared) whose alert is due now
  expected.set(V.b, "PACKAGE_NOT_PREPARED@p:2026-09");
  const res = await monitorRoute.POST(new Request("https://app.example.com/api/accountant/monitor", { method: "POST", headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }) as never);
  const body = (await res.json()) as Json;
  ok("6e no alert address configured → the endpoint answers 500 (the GitHub watchdog goes red), claims given back",
    res.status === 500 && body.notification === "not_configured" && (await bizAlerts(V.b)).length === 1 && (await bizAlerts(V.b))[0].notifyCount === 0, JSON.stringify(body));
  process.env.ACCOUNTANT_OPS_ALERT_EMAIL = "ops@example.org";
  await sweepRun("OK", new Date());

  // ── 7. A partial run resolves nothing it did not look at ──────────────────────────────────────
  console.log("7. partial runs");
  const hOpen = (await bizAlerts(H.b)).find((a) => a.resolvedAt === null)!;
  r = await run(new Date(now.getTime() + 400_000), { isEnabled: async (id) => { if (id === H.b) throw new Error("lab: H cannot be read"); return monitor.defaultMonitorDeps.isEnabled(id); } });
  ok("7a a business that could not be evaluated keeps its open alert", (await owner.accountantBusinessAlert.findUniqueOrThrow({ where: { id: hOpen.id } })).resolvedAt === null);
  ok("7b …and the run reports MONITOR_INCOMPLETE (alerted)", (await owner.accountantOpsAlert.count({ where: { code: "MONITOR_INCOMPLETE", resolvedAt: null } })) === 1 && r.counts.businessesFailed === 1);
  r = await run(new Date(now.getTime() + 460_000));
  ok("7c a full run afterwards resolves MONITOR_INCOMPLETE", (await owner.accountantOpsAlert.count({ where: { code: "MONITOR_INCOMPLETE", resolvedAt: null } })) === 0);

  // ── 8. Reminders and recovery ──────────────────────────────────────────────────────────────────
  console.log("8. reminders and recovery");
  await sweepRun("OK", new Date(now.getTime() + 25 * 3600_000 - 10 * 60_000));
  before = alertCalls().length;
  r = await run(new Date(now.getTime() + 25 * 3600_000));
  const reminder = alertCalls()[alertCalls().length - 1];
  const reminded = await owner.accountantBusinessAlert.findMany({ where: { resolvedAt: null } });
  ok("8a after 24 h: ONE email with the reminders", alertCalls().length === before + 1 && (reminder.text.match(/^תזכורת · /gm) ?? []).length === 10, reminder.text.slice(0, 200));
  ok("8b the complaint is not reminded", reminded.find((a) => a.code === "DELIVERY_COMPLAINED")?.notifyCount === 1 && reminded.filter((a) => a.code !== "DELIVERY_COMPLAINED").every((a) => a.notifyCount === 2));
  ok("8c a second run at the same time reminds nothing", (await run(new Date(now.getTime() + 25 * 3600_000 + 60_000))).counts.claimed === 0);
  await inB(R.b, () => del.cancelDelivery(R.b, R.u, aR.deliveryId, new Date()));
  await prepare(G);
  r = await run(new Date(now.getTime() + 26 * 3600_000));
  const recovery = alertCalls()[alertCalls().length - 1];
  ok("8d the owner canceled R's send and G's month was prepared → both resolved, announced once",
    (await bizAlerts(R.b)).every((a) => a.resolvedAt !== null && a.resolvedNotifiedAt !== null) && (await bizAlerts(G.b)).every((a) => a.resolvedAt !== null) &&
    (recovery.text.match(/^נפתר · /gm) ?? []).length === 2, recovery.text.slice(0, 200));

  // ── 9. The endpoint ────────────────────────────────────────────────────────────────────────────
  console.log("9. the endpoint");
  const call = (method: "GET" | "POST", auth: string | null, q = "") =>
    (method === "GET" ? monitorRoute.GET : monitorRoute.POST)(new Request(`https://app.example.com/api/accountant/monitor${q}`, { method, headers: auth ? { authorization: auth } : {} }) as never);
  ok("9a no credential → 401; a wrong one → 401", (await call("POST", null)).status === 401 && (await call("POST", "Bearer not-the-secret-not-the-secret-000000")).status === 401);
  const runsBefore = await owner.accountantOpsRun.count();
  process.env.ACCOUNTANT_MONITOR_ENABLED = "false";
  const off = await call("POST", `Bearer ${process.env.CRON_SECRET}`);
  ok("9b switched off → 200 {enabled:false}, nothing read or written", off.status === 200 && ((await off.json()) as Json).enabled === false && (await owner.accountantOpsRun.count()) === runsBefore);
  const alertsBefore = JSON.stringify(await owner.accountantBusinessAlert.findMany({ orderBy: { id: "asc" } })) + JSON.stringify(await owner.accountantOpsAlert.findMany({ orderBy: { id: "asc" } }));
  before = alertCalls().length;
  const sim = await call("POST", `Bearer ${process.env.CRON_SECRET}`, "?simulate=1");
  const simBody = (await sim.json()) as Json;
  const simMail = alertCalls()[alertCalls().length - 1];
  ok("9c the safe simulation works with the monitor off: one test email to the operator, saying so",
    sim.status === 200 && simBody.notification === "sent" && alertCalls().length === before + 1 && simMail.to === "ops@example.org" && simMail.text.includes("הודעת בדיקה") && simMail.key.startsWith("acctops-sim:"));
  ok("9d …it read and wrote nothing (runs, alerts unchanged)", (await owner.accountantOpsRun.count()) === runsBefore &&
    JSON.stringify(await owner.accountantBusinessAlert.findMany({ orderBy: { id: "asc" } })) + JSON.stringify(await owner.accountantOpsAlert.findMany({ orderBy: { id: "asc" } })) === alertsBefore);
  await call("POST", `Bearer ${process.env.CRON_SECRET}`, "?simulate=1");
  ok("9e a second simulation within ten minutes → the same idempotency key (the provider sends one)", alertCalls()[alertCalls().length - 1].key === simMail.key && [...messages.keys()].filter((k) => k === simMail.key).length === 1);
  delete process.env.ACCOUNTANT_OPS_ALERT_EMAIL;
  ok("9f a simulation with no channel configured → 500", (await call("POST", `Bearer ${process.env.CRON_SECRET}`, "?simulate=1")).status === 500);
  process.env.ACCOUNTANT_OPS_ALERT_EMAIL = "ops@example.org";
  process.env.ACCOUNTANT_MONITOR_ENABLED = "true";
  const viaCron = await call("GET", `Bearer ${process.env.CRON_SECRET}`);
  const cronRun = await owner.accountantOpsRun.findFirstOrThrow({ where: { kind: "MONITOR" }, orderBy: { id: "desc" } });
  const cronBody = (await viaCron.json()) as Json;
  ok("9g Vercel Cron (GET) → 200, recorded as VERCEL_CRON, the answer holds counts and codes only",
    viaCron.status === 200 && cronRun.source === "VERCEL_CRON" && !/accountants\.example|ops\.lab|acct-ops-/.test(JSON.stringify(cronBody)), JSON.stringify(cronBody).slice(0, 200));

  // ── 9b. A run that died after claiming ─────────────────────────────────────────────────────────
  console.log("9b. a run that died after claiming");
  const { reconcileAlerts } = await import("@/lib/accountant/ops/alert-store");
  const { businessFindings } = await import("@/lib/accountant/ops/findings");
  const Y = await business("acct-ops-Y"); // a new fault (not prepared)
  expected.set(Y.b, "PACKAGE_NOT_PREPARED@p:2026-09");
  const tRun = new Date(Date.now() + 2 * 60_000);
  const tDead = new Date(tRun.getTime() - 15 * 60_000);
  const dead = await owner.accountantOpsRun.create({ data: { kind: "MONITOR", source: "VERCEL_CRON", startedAt: tDead, outcome: "RUNNING" } });
  // The dead run opened and CLAIMED Y's alert (its claims carry its start time), then was killed before sending.
  const yFindings = businessFindings({ now: tDead, sweepEnabled: true, webhookConfigured: true, latestKey: "2026-09", periods: [], buildingPackages: [], deliveries: [], complaints: [] });
  const deadClaim = await inB(Y.b, () => tenantTx(Y.b, (tx) => reconcileAlerts(tx, { kind: "business", businessId: Y.b }, yFindings, tDead, { claimAt: tDead })));
  const yAlert = (await bizAlerts(Y.b))[0];
  ok("9b-a fixture: the dead run claimed Y's first notice (notifyCount 1, stamped with its start) and sent nothing",
    deadClaim.claims.length === 1 && yAlert?.notifyCount === 1 && yAlert.lastNotifiedAt?.getTime() === tDead.getTime());
  before = alertCalls().length;
  r = await run(tRun);
  const yAfter = (await bizAlerts(Y.b))[0];
  const deadAfter = await owner.accountantOpsRun.findUniqueOrThrow({ where: { id: dead.id } });
  ok("9b-b the next run recovers the dead run's claim and sends it as a first notice",
    r.counts.recovered >= 1 && alertCalls().length === before + 1 && alertCalls()[alertCalls().length - 1].text.includes(`עסק #${Y.b} · חודש 2026-09`) &&
      yAfter.notifyCount === 1 && yAfter.lastNotifiedAt?.getTime() === tRun.getTime(), JSON.stringify({ rec: r.counts.recovered, n: yAfter.notifyCount }));
  ok("9b-c …and closes the dead run as FAILED (abandoned)", deadAfter.outcome === "FAILED" && deadAfter.errorCode === "abandoned" && r.counts.abandonedRuns === 1);
  r = await run(new Date(tRun.getTime() + 60_000));
  ok("9b-d …and nothing is recovered or sent twice afterwards", r.counts.recovered === 0 && r.counts.claimed === 0);

  // ── 10. Isolation ──────────────────────────────────────────────────────────────────────────────
  console.log("10. isolation");
  const { prisma } = await import("@/lib/prisma");
  const seenByB = await inB(B.b, () => tenantTx(B.b, (tx) => tx.accountantBusinessAlert.findMany()));
  ok("10a the runtime in business B sees only B's alerts", seenByB.length >= 1 && seenByB.every((a) => a.businessId === B.b));
  ok("10b the runtime with no tenant context sees no business alert", (await prisma.accountantBusinessAlert.count()) === 0);
  ok("10c every alert row belongs to the business it describes", (await owner.accountantBusinessAlert.findMany()).every((a) => [...expected.keys()].includes(a.businessId)));

  // ── 11. The console's read ─────────────────────────────────────────────────────────────────────
  console.log("11. the console");
  const view = await adminOps.getAccountantOps();
  ok("11a the console reads alerts across businesses, with their names, and the runs", view.available === true &&
    view.openAlerts.some((a) => a.businessId === S.b && a.businessName === "acct-ops-S") && view.sweepRuns.length > 0 && view.monitorRuns.length > 0);
  const viewJson = JSON.stringify(view);
  ok("11b no address, link, token or provider id anywhere in it", !/@|\/a\/[A-Za-z0-9_-]{32}|#t=|msg_lab_|linkPublicId|recipientEmail/.test(viewJson.replace(/"generatedAt":"[^"]+"/, "")));
  ok("11c the switches are on/off only", JSON.stringify(view.config) === JSON.stringify({ monitorEnabled: true, sweepEnabled: true, deliveryEnabled: true, webhookConfigured: true, alertChannelConfigured: true }));
  await owner.$executeRawUnsafe(`REVOKE SELECT ON "AccountantOpsRun", "AccountantOpsAlert", "AccountantBusinessAlert" FROM app_admin`);
  const noGrant = await adminOps.getAccountantOps();
  ok("11d without the console's grant (migration 20261107092000 not applied) → 'not granted', no error, no zeros", noGrant.available === false && noGrant.reason === "admin_read_not_granted");
  await owner.$executeRawUnsafe(`GRANT SELECT ON "AccountantOpsRun", "AccountantOpsAlert", "AccountantBusinessAlert" TO app_admin`);
  const anon = await adminRoute.GET(new Request("https://app.example.com/api/platform-admin/accountant-ops") as never);
  ok("11e the console route without a platform-admin session → 401", anon.status === 401);

  // ── 11b. Age never closes an alert; the monitor watches itself ─────────────────────────────────
  console.log("11b. no closing by age; the monitor watching itself");
  const later = new Date(now.getTime() + 40 * 86400_000); // past the 30-day window, and two month-ends later
  const stillOpen = async (b: number, code: string) => (await bizAlerts(b)).some((a) => a.code === code && a.resolvedAt === null);
  before = alertCalls().length;
  r = await run(later);
  ok("11b-a 40 days on: the uncertain send, the stuck send, the failing month, the stuck build — all still open",
    (await stillOpen(U.b, "SEND_UNCERTAIN")) && (await stillOpen(S.b, "SEND_STUCK")) && (await stillOpen(H.b, "PREPARATION_FAILED")) && (await stillOpen(K.b, "PREPARATION_STUCK")));
  ok("11b-b the month never prepared (2026-09) is still open after the months rolled over", (await bizAlerts(V.b)).some((a) => a.subjectKey === "p:2026-09" && a.resolvedAt === null));
  ok("11b-c the silent webhook past its 72 h window, still no event → still open", await stillOpen(W.b, "WEBHOOK_SILENT"));
  ok("11b-d the 40-day-old complaint, nothing done → still open", await stillOpen(C.b, "DELIVERY_COMPLAINED"));
  ok("11b-e nothing closed by age: no 'resolved' line in this run's email", !(alertCalls().slice(before).map((c) => c.text).join("\n").match(/^נפתר · /gm)));
  const rc = await owner.accountantRecipient.findUniqueOrThrow({ where: { businessId: C.b } });
  await inB(C.b, () => setRecipient({ businessId: C.b, userId: C.u, name: "רו\"ח דנה", email: `cpa2-${C.b}@accountants.example`, expectedVersion: rc.version, confirm: true, now: new Date(later.getTime() + 60_000) }));
  r = await run(new Date(later.getTime() + 120_000));
  const handled = (await bizAlerts(C.b)).find((a) => a.code === "DELIVERY_COMPLAINED");
  ok("11b-f the owner changes the accountant's address (RECIPIENT_CHANGED in the trail) → the complaint closes",
    handled?.resolvedAt !== null && (await owner.accountantWorkflowEvent.count({ where: { businessId: C.b, eventType: "RECIPIENT_CHANGED" } })) === 1);
  r = await run(new Date(later.getTime() + 180_000));
  ok("11b-g …and it never reopens", (await bizAlerts(C.b)).filter((a) => a.code === "DELIVERY_COMPLAINED").length === 1);
  process.env.ACCOUNTANT_SWEEP_ENABLED = "false";
  r = await run(new Date(later.getTime() + 25 * 3600_000));
  const sm = await owner.accountantOpsAlert.findFirstOrThrow({ where: { code: "SWEEP_MISSED", resolvedAt: null } });
  ok("11b-h the sweep switched off while SWEEP_MISSED is open → stays open, marked unchecked, NOT reminded after 24 h",
    sm.notifyCount === 1 && (sm.detail as Json).unchecked === true);
  ok("11b-i …and the month the switched-off sweep cannot prepare stays open quietly, not reminded",
    (await bizAlerts(V.b)).filter((a) => a.subjectKey === "p:2026-09" && a.resolvedAt === null).every((a) => (a.detail as Json).unchecked === true));
  process.env.ACCOUNTANT_SWEEP_ENABLED = "true";
  // The monitor watching itself: a GitHub run with no Vercel Cron run for 3 h, then a Vercel run with no GitHub run for 13 h.
  const t1 = new Date(later.getTime() + 28 * 3600_000);
  r = await monitor.runAccountantMonitor("GITHUB_ACTIONS", { ...monitor.defaultMonitorDeps, now: () => t1 });
  ok("11b-j Vercel Cron silent for 3 h (seen by the GitHub watchdog) → MONITOR_CRON_MISSED, emailed",
    (await owner.accountantOpsAlert.count({ where: { code: "MONITOR_CRON_MISSED", resolvedAt: null } })) === 1 && alertCalls()[alertCalls().length - 1].text.includes("תזמון הניטור ב־Vercel"));
  const t2 = new Date(t1.getTime() + 13 * 3600_000);
  r = await monitor.runAccountantMonitor("VERCEL_CRON", { ...monitor.defaultMonitorDeps, now: () => t2 });
  ok("11b-k the GitHub watchdog silent for 13 h (seen by Vercel Cron) → WATCHDOG_MISSED; Vercel Cron back → MONITOR_CRON_MISSED resolved",
    (await owner.accountantOpsAlert.count({ where: { code: "WATCHDOG_MISSED", resolvedAt: null } })) === 1 &&
    (await owner.accountantOpsAlert.count({ where: { code: "MONITOR_CRON_MISSED", resolvedAt: null } })) === 0);
  const health = await adminOps.getAccountantOps(t2);
  ok("11b-l the console shows the monitor's health per channel, and the last run's notification outcome",
    health.available === true && !!health.health.lastRunBySource.VERCEL_CRON && !!health.health.lastRunBySource.GITHUB_ACTIONS && health.health.watchdogStale === true && health.health.cronStale === false);

  // ── 12. Nothing of the workflow changed ────────────────────────────────────────────────────────
  console.log("12. the workflow is untouched by the monitor");
  // Between the freeze and now only the owner's own acts changed the workflow — R's cancel, G's preparation — and
  // business V was created (its documents).
  const after = JSON.parse(await snapshot()) as Json;
  const was = JSON.parse(frozen) as Json;
  const unaffected = (x: Json, keyOf: (r: Json) => number) => (x as unknown as Json[]).filter((row) => ![R.b, G.b, V.b, C.b, Y.b].includes(keyOf(row)));
  ok("12a packages, stored ZIPs and documents of every other business are byte-identical",
    JSON.stringify(unaffected(was.pkgs as Json, (p) => Number(p.businessId))) === JSON.stringify(unaffected(after.pkgs as Json, (p) => Number(p.businessId))) &&
    JSON.stringify(unaffected(was.docs as Json, (d) => Number(d.businessId))) === JSON.stringify(unaffected(after.docs as Json, (d) => Number(d.businessId))));
  ok("12b deliveries and periods of every other business are unchanged",
    JSON.stringify(unaffected(was.deliveries as Json, (d) => Number(d.businessId))) === JSON.stringify(unaffected(after.deliveries as Json, (d) => Number(d.businessId))) &&
    JSON.stringify(unaffected(was.periods as Json, (p) => Number(p.businessId))) === JSON.stringify(unaffected(after.periods as Json, (p) => Number(p.businessId))));
  const newEvents = await owner.accountantWorkflowEvent.findMany({ where: { id: { gt: lastEventAtFreeze } } });
  ok("12c the trail grew only by the owner's acts (R canceled, G prepared, C's address) — never by the monitor",
    newEvents.length > 0 && newEvents.every((e) => [R.b, G.b, C.b].includes(e.businessId)), JSON.stringify(newEvents.map((e) => [e.businessId, e.eventType])));
  ok("12d no network other than the provider", otherNetwork === 0);

  // ── 13. The sweep and its run log ──────────────────────────────────────────────────────────────
  console.log("13. the sweep");
  const sweepCall = () => sweepRoute.GET(new Request("https://app.example.com/api/accountant/sweep", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }) as never);
  const s1 = await sweepCall();
  const s1Body = (await s1.json()) as { summary: Json };
  const s1Run = await owner.accountantOpsRun.findFirstOrThrow({ where: { kind: "SWEEP" }, orderBy: { id: "desc" } });
  ok("13a a sweep run is recorded with exactly its own summary (counts only)", s1Run.outcome === (s1.status === 200 ? "OK" : "FAILED") && s1Run.source === "VERCEL_CRON" &&
    canon(s1Run.counts) === canon(s1Body.summary), JSON.stringify({ c: s1Run.counts, s: s1Body.summary }).slice(0, 300));
  await owner.$executeRawUnsafe(`REVOKE INSERT ON "AccountantOpsRun" FROM app_runtime`);
  const runsNow = await owner.accountantOpsRun.count();
  const s2 = await sweepCall();
  const s2Body = (await s2.json()) as Json;
  ok("13b with the run log broken the sweep still runs and answers as before (best-effort recording)",
    s2.status === s1.status && s2Body.enabled === true && typeof (s2Body.summary as Json)?.eligible === "number" && (await owner.accountantOpsRun.count()) === runsNow);
  await owner.$executeRawUnsafe(`GRANT INSERT ON "AccountantOpsRun" TO app_runtime`);
  process.env.ACCOUNTANT_MONITOR_ENABLED = "false";
  const runsOff = await owner.accountantOpsRun.count();
  const s3 = await sweepCall();
  ok("13c with the monitor switched off the sweep records nothing (merging the code writes nothing)", s3.status === s1.status && (await owner.accountantOpsRun.count()) === runsOff);
  process.env.ACCOUNTANT_MONITOR_ENABLED = "true";

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
  await owner.$disconnect();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
