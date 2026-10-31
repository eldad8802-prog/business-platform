/**
 * Accountant workflow + sending OPEN FOR EVERY BUSINESS (migration 20261110090000_accountant_open_all) — the REAL
 * services and the REAL sweep on the Production-shaped lab, with no business override at all (as Production has for
 * every business but 9), a simulated clock and a Resend emulator. Nothing leaves the box.
 *
 *   1. Open by default: with the migration applied, a business with no override — existing or created after it — has
 *      both features; an explicit DISABLED override still closes either one.
 *   2. The sweep on the 1st over many businesses: each open business gets ONLY the month just closed (nothing older
 *      is created — no retroactive month), one package, one in-app notice; overlapping runs duplicate nothing; the
 *      time / build budget spreads the work over runs; a DISABLED business gets nothing.
 *   3. A month with no documents: prepared, recorded, no error, nothing sent.
 *   4. No automatic send: after any number of runs there is no delivery and no email — a send exists only after the
 *      owner's explicit approval; a business with no recipient cannot approve (RECIPIENT_MISSING).
 *   5. Resend over its limit (429): a send is retried with the SAME key and ends FAILED inside the window with one
 *      notice; the one-time code answers CODE_NOT_SENT; nothing else is sent.
 *   6. Stops: ACCOUNTANT_DELIVERY_ENABLED unset → approval refused and no retry contacts the provider; the policy's
 *      emergencyDisabled → the sweep skips every business and links answer 404; per business DISABLED → that one only.
 *
 * env: OWNER_URL, DATABASE_URL, DIRECT_URL. Synthetic only. ZERO real network.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

process.env.TZ = "UTC";
process.env.STORAGE_PROVIDER = "local";
process.env.LOCAL_STORAGE_ROOT = mkdtempSync(path.join(os.tmpdir(), "acct-rollout-"));
process.env.AUTH_TOKEN_SECRET = "acct-lab-synthetic-auth-token-secret-0123456789";
process.env.TRANSACTIONAL_EMAIL_ENABLED = "true";
process.env.RESEND_API_KEY = "re_lab_synthetic";
process.env.TRANSACTIONAL_EMAIL_FROM = "Dubiz <no-reply@example.com>";
process.env.APP_BASE_URL = "https://app.example.com";
process.env.ACCOUNTANT_DELIVERY_ENABLED = "true";
process.env.RATE_LIMIT_BACKEND = "memory";

import { PrismaClient } from "@prisma/client";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// Resend emulator: one message per Idempotency-Key; "429" answers like Resend over its quota.
let mode: "sent" | "429" = "sent";
const calls: { key: string }[] = [];
const messages = new Set<string>();
let otherNetwork = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (!String(input).startsWith("https://api.resend.com/")) { otherNetwork++; throw new Error("no network"); }
  const key = String((init?.headers as Record<string, string>)["Idempotency-Key"]);
  calls.push({ key });
  if (mode === "429") return new Response(JSON.stringify({ name: "daily_quota_exceeded", message: "quota" }), { status: 429, headers: { "retry-after": "60" } });
  messages.add(key);
  return new Response(JSON.stringify({ id: `msg_${messages.size}` }), { status: 200 });
}) as typeof fetch;

type Json = Record<string, unknown>;

async function main() {
  const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { putDocumentObject } = await import("@/lib/services/documents/document-storage.service");
  const { runAccountantSweep, defaultSweepDeps, SWEEP_MAX_PREPARES } = await import("@/lib/accountant/sweep");
  const del = await import("@/lib/accountant/delivery.service");
  const { setRecipient } = await import("@/lib/accountant/recipient.service");
  const { accountantWorkflowEnabled, accountantDeliveryPermitted } = await import("@/lib/accountant/http");
  const dev = await import("@/lib/accountant/link-device");
  const portalRoute = await import("@/app/api/accountant/link/portal/route");
  const KEY = "2026-10";

  for (const t of ["FinancialRecord", "Document", "BillingDocument", "BillingAuthoritySubmission", "Notification", "NotificationDelivery", "BusinessProfile", "BusinessFeatureAccess"]) {
    const on = (await owner.$queryRawUnsafe(`SELECT relforcerowsecurity AS f FROM pg_class WHERE relname = $1`, t)) as { f: boolean }[];
    if (on[0]?.f) continue;
    await owner.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`CREATE POLICY acct_lab_tenant ON "${t}" FOR ALL
      USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
      WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)`);
  }

  // ── 0. The migration's effect ─────────────────────────────────────────────────────────────────
  console.log("0. the opening (migration 20261110090000)");
  const flags = (await owner.$queryRawUnsafe(`SELECT d."key", d."defaultEnabled" AS d, p."globalEnabled" AS g, p."emergencyDisabled" AS e
    FROM "PlatformFeatureDefinition" d JOIN "PlatformFeaturePolicy" p ON p."featureKey" = d."key" WHERE d."key" IN ('accountant_month_close', 'accountant_delivery') ORDER BY 1`)) as { key: string; d: boolean; g: boolean; e: boolean }[];
  ok("0a both definitions default ON, both policies global ON, emergency OFF", flags.length === 2 && flags.every((f) => f.d && f.g && !f.e), JSON.stringify(flags));
  ok("0b no business override of either feature exists in the lab", Number(((await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "BusinessFeatureAccess" WHERE "featureKey" IN ('accountant_month_close', 'accountant_delivery')`)) as { n: number }[])[0].n) === 0);

  // ── Fixtures ───────────────────────────────────────────────────────────────────────────────────
  const one = async (sql: string, ...a: unknown[]) => Number(((await owner.$queryRawUnsafe(sql, ...a)) as { id: number }[])[0].id);
  let n = 0;
  const doc = async (b: number, month: string, day: string, amount: number) => {
    const body = Buffer.from(`%PDF-1.4 rollout ${++n}`);
    const basename = `doc-${Date.now()}${n}-rollout.pdf`;
    await putDocumentObject({ businessId: b, basename, body, contentType: "application/pdf", source: "file" });
    const d = await one(`INSERT INTO "Document" ("businessId", "fileUrl", "source", "mimeType", "status", "createdAt", "contentHashSha256") VALUES ($1, $2, 'file', 'application/pdf', 'approved', $3::timestamp, $4) RETURNING "id"`, b, basename, `${month}-${day}T08:00:00`, sha(body));
    await owner.$executeRawUnsafe(`INSERT INTO "FinancialRecord" ("documentId", "businessId", "amount", "date", "vendorName", "direction", "category") VALUES ($1, $2, $3, $4::timestamp, 'ספק', 'expense', 'general')`, d, b, amount, `${month}-${day}T00:00:00`);
  };
  const business = async (name: string, docs: boolean) => {
    const b = await one(`INSERT INTO "Business" ("name", "updatedAt") VALUES ($1, now()) RETURNING "id"`, name);
    const u = await one(`INSERT INTO "User" ("email", "password", "businessId", "updatedAt") VALUES ($1, 'x', $2, now()) RETURNING "id"`, `${name}-${b}@rollout.lab`, b);
    if (docs) {
      await doc(b, KEY, "05", 100);
      await doc(b, KEY, "18", 250.5);
      await doc(b, "2026-08", "10", 70); // an older month with data: the schedule must never create it
    }
    return { b, u };
  };
  const inX = <T>(b: number, fn: () => Promise<T>) => runWithTenantContext({ businessId: b }, fn);

  const many: { b: number; u: number }[] = [];
  for (let i = 0; i < 14; i++) many.push(await business(`acct-rollout-${i}`, true));
  const EMPTY = await business("acct-rollout-empty", false);
  const OFF = await business("acct-rollout-off", true);
  await owner.$executeRawUnsafe(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") VALUES ($1, 'accountant_month_close', 'DISABLED', now())`, OFF.b);
  const ours = [...many.map((x) => x.b), EMPTY.b, OFF.b];

  // ── 1. Open by default ─────────────────────────────────────────────────────────────────────────
  console.log("1. open by default");
  ok("1a an existing business with no override: workflow open", await accountantWorkflowEnabled(many[0].b));
  ok("1b …and sending permitted", await accountantDeliveryPermitted(many[0].b));
  const NEW = await business("acct-rollout-new", true);
  ok("1c a business created after the opening: both open, with no admin step", (await accountantWorkflowEnabled(NEW.b)) && (await accountantDeliveryPermitted(NEW.b)));
  ok("1d an explicit DISABLED override still closes the workflow", !(await accountantWorkflowEnabled(OFF.b)));

  // ── 2. The sweep on the 1st ────────────────────────────────────────────────────────────────────
  console.log("2. the sweep on the 1st over many businesses");
  let clock = new Date("2026-11-01T00:30:00Z");
  const deps = { ...defaultSweepDeps, now: () => clock, listBusinessIds: async () => ours };
  const runs: Json[] = [];
  for (let i = 0; i < 6; i++) {
    const [a, b] = await Promise.all([runAccountantSweep(deps), runAccountantSweep(deps)]); // two overlapping runs every "hour"
    runs.push({ a: a.built, b: b.built, budget: a.budgetExhausted || b.budgetExhausted });
    clock = new Date(clock.getTime() + 3600_000);
  }
  const periodsOf = async (b: number) => (await owner.accountantPeriod.findMany({ where: { businessId: b }, select: { periodKey: true } })).map((p) => p.periodKey);
  const openOnes = [...many, EMPTY];
  const allHaveOct = (await Promise.all(openOnes.map(async (x) => (await periodsOf(x.b)).join(",")))).every((k) => k === KEY);
  ok("2a every open business has exactly the month just closed (2026-10) — nothing older is created", allHaveOct);
  ok("2b one READY package per business with documents", (await Promise.all(many.map((x) => owner.accountantPackage.count({ where: { businessId: x.b } })))).every((c) => c === 1));
  ok(`2c the build budget spreads the work (≤ ${SWEEP_MAX_PREPARES} builds per run) and overlapping runs build nothing twice`,
    runs.every((r) => Number(r.a) <= SWEEP_MAX_PREPARES && Number(r.b) <= SWEEP_MAX_PREPARES) &&
      (await owner.accountantPackage.count({ where: { businessId: { in: many.map((x) => x.b) } } })) === many.length, JSON.stringify(runs));
  const notices = await Promise.all(openOnes.map((x) => owner.notification.count({ where: { businessId: x.b, resolvedAt: null } })));
  ok("2d one live in-app notice per open business (no duplicates)", notices.every((c) => c === 1), notices.join(","));
  const pushOrEmail = Number(((await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "NotificationDelivery" WHERE "businessId" = ANY($1::int[]) AND "channel"::text <> 'IN_APP'`, ours)) as { n: number }[])[0].n);
  ok("2e the notices are in the app only (no push, no email delivery rows)", pushOrEmail === 0, String(pushOrEmail));
  ok("2f the DISABLED business got nothing (no month, no notice)", (await periodsOf(OFF.b)).length === 0 && (await owner.notification.count({ where: { businessId: OFF.b } })) === 0);

  // ── 3. A month with no documents ──────────────────────────────────────────────────────────────
  console.log("3. a month with no documents");
  const empty = await owner.accountantPeriod.findFirst({ where: { businessId: EMPTY.b, periodKey: KEY } });
  ok("3a prepared and recorded, no failure", !!empty && !empty.failureCode && empty.status !== "BUILD_FAILED", JSON.stringify({ s: empty?.status, f: empty?.failureCode }));
  console.log(`      (empty month status: ${empty?.status}; packages: ${await owner.accountantPackage.count({ where: { businessId: EMPTY.b } })})`);

  // ── 4. No automatic send ──────────────────────────────────────────────────────────────────────
  console.log("4. no automatic send");
  ok("4a after 12 sweep runs: no delivery anywhere, no email", (await owner.accountantDelivery.count({ where: { businessId: { in: ours } } })) === 0 && calls.length === 0);
  const pkg0 = await owner.accountantPackage.findFirstOrThrow({ where: { businessId: many[0].b, status: "READY" } });
  const throwsCode = async (fn: () => Promise<unknown>) => { try { await fn(); return null; } catch (e) { return (e as { code?: string }).code ?? "?"; } };
  ok("4b a business with no recipient cannot approve (RECIPIENT_MISSING)", (await throwsCode(() => inX(many[0].b, () => del.approveDelivery({
    businessId: many[0].b, userId: many[0].u, periodKey: KEY, packageId: pkg0.id, packageSha256: pkg0.sha256!, recipientVersion: 1,
    recipientEmail: "cpa@example.com", acknowledgeIncomplete: true, idempotencyKey: "send:rollout-norecipient-01", now: clock })))) === "RECIPIENT_MISSING");

  // ── 5. Resend over its limit ──────────────────────────────────────────────────────────────────
  console.log("5. Resend over its limit (429)");
  const X = many[1];
  await inX(X.b, () => setRecipient({ businessId: X.b, userId: X.u, name: "רו\"ח", email: "cpa@example.com", expectedVersion: null, confirm: true, now: clock }));
  // The recipient change marks the month dirty; let the next run settle it before the approval.
  clock = new Date(clock.getTime() + 3600_000);
  await runAccountantSweep(deps);
  const pX = await owner.accountantPackage.findFirstOrThrow({ where: { businessId: X.b, status: "READY" } });
  mode = "429";
  const aX = await inX(X.b, () => del.approveDelivery({ businessId: X.b, userId: X.u, periodKey: KEY, packageId: pX.id, packageSha256: pX.sha256!, recipientVersion: 1,
    recipientEmail: "cpa@example.com", acknowledgeIncomplete: true, idempotencyKey: "send:rollout-429-0001", now: clock }));
  const first = await inX(X.b, () => del.attemptDelivery(X.b, aX.deliveryId, clock));
  ok("5a the explicit approval's send meets 429 → retry scheduled (not failed, not duplicated)", first === "retry_scheduled", first);
  for (let h = 0; h < 30; h++) { clock = new Date(clock.getTime() + 3600_000); await runAccountantSweep(deps); }
  const dX = await owner.accountantDelivery.findUniqueOrThrow({ where: { id: aX.deliveryId } });
  const keys = new Set(calls.map((c) => c.key));
  ok("5b retried with the SAME key only, never more than 7 attempts, then FAILED inside the 24 h window", dX.status === "FAILED" && dX.attempts <= 7 && keys.size === 1 && [...keys][0] === `acct:${aX.deliveryId}`, JSON.stringify({ s: dX.status, a: dX.attempts, keys: [...keys] }));
  ok("5c the owner has one notice for the failed send", (await owner.notification.count({ where: { businessId: X.b, resolvedAt: null, entityType: "accountant_period_send_failed" } })) === 1);
  const otpOut = await dev.sendLinkCode({ businessId: X.b, deliveryId: aX.deliveryId, businessName: "x", periodKey: KEY }, clock).catch(() => ({ ok: false, reason: "threw" }));
  ok("5d a one-time code over the limit → not sent (the route answers CODE_NOT_SENT)", !otpOut.ok && (otpOut as { reason: string }).reason === "not_sent", JSON.stringify(otpOut));
  mode = "sent";

  // ── 6. Stops ──────────────────────────────────────────────────────────────────────────────────
  console.log("6. stops");
  const Y = many[2];
  await inX(Y.b, () => setRecipient({ businessId: Y.b, userId: Y.u, name: "רו\"ח", email: "cpa@example.com", expectedVersion: null, confirm: true, now: clock }));
  clock = new Date(clock.getTime() + 3600_000);
  await runAccountantSweep(deps);
  const pY = await owner.accountantPackage.findFirstOrThrow({ where: { businessId: Y.b, status: "READY" } });
  delete process.env.ACCOUNTANT_DELIVERY_ENABLED;
  const before = calls.length;
  ok("6a master switch unset: approval refused (DELIVERY_DISABLED)", (await throwsCode(() => inX(Y.b, () => del.approveDelivery({ businessId: Y.b, userId: Y.u, periodKey: KEY, packageId: pY.id, packageSha256: pY.sha256!, recipientVersion: 1,
    recipientEmail: "cpa@example.com", acknowledgeIncomplete: true, idempotencyKey: "send:rollout-stop-0001", now: clock })))) === "DELIVERY_DISABLED");
  for (let h = 0; h < 3; h++) { clock = new Date(clock.getTime() + 3600_000); await runAccountantSweep(deps); }
  ok("6b …and no sweep run contacts the provider", calls.length === before);
  process.env.ACCOUNTANT_DELIVERY_ENABLED = "true";
  await owner.$executeRawUnsafe(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") VALUES ($1, 'accountant_delivery', 'DISABLED', now())`, Y.b);
  ok("6c one business's sending DISABLED: that one refused (DELIVERY_NOT_PERMITTED), the others still permitted", (await throwsCode(() => inX(Y.b, () => del.approveDelivery({ businessId: Y.b, userId: Y.u, periodKey: KEY, packageId: pY.id, packageSha256: pY.sha256!, recipientVersion: 1,
    recipientEmail: "cpa@example.com", acknowledgeIncomplete: true, idempotencyKey: "send:rollout-stop-0002", now: clock })))) === "DELIVERY_NOT_PERMITTED" && (await accountantDeliveryPermitted(many[3].b)));
  await owner.$executeRawUnsafe(`UPDATE "PlatformFeaturePolicy" SET "emergencyDisabled" = true WHERE "featureKey" = 'accountant_month_close'`);
  const stopped = await runAccountantSweep({ ...deps, now: () => new Date(clock.getTime() + 3600_000) });
  ok("6d emergency switch on the workflow: the very next sweep skips every business", stopped.eligible === 0, JSON.stringify(stopped));
  const res = await portalRoute.POST(new Request("https://app.example.com/api/accountant/link/portal", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.9" }, body: JSON.stringify({ publicId: "A".repeat(32), token: "B".repeat(43) }) }));
  ok("6e …and the portal answers 404", res.status === 404);
  await owner.$executeRawUnsafe(`UPDATE "PlatformFeaturePolicy" SET "emergencyDisabled" = false WHERE "featureKey" = 'accountant_month_close'`);

  ok("9z no network but the emulator", otherNetwork === 0);
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
  await owner.$disconnect();
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => process.exit());
