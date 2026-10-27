/**
 * Monthly accountant workflow — the sweep run HOURLY (Vercel Cron `30 * * * *`), on the Production-shaped lab.
 * The REAL sweep (lib/accountant/sweep.ts) with a simulated clock, 48 hourly runs and overlapping runs; the
 * email provider is a Resend emulator (it sends once per Idempotency-Key). Nothing leaves the box.
 *
 *   1. Packages: hourly runs from the 1st build exactly ONE package per month; two runs at the same moment
 *      build nothing twice; unchanged data is never rebuilt; a real change builds exactly one new version.
 *   2. Notices: hourly runs never duplicate the owner's notice (one live notice per month).
 *   3. Retries: a send whose first attempt failed (503) is retried by the next hourly run with the SAME key
 *      and accepted — one message at the provider; two overlapping runs claim it once.
 *   4. The 24 h window and the 7 attempts: a send the provider never answers is retried hourly, never more
 *      than 7 attempts, and ends (FAILED, uncertain) inside the window — still ONE message at the provider.
 *   5. Switch off: with ACCOUNTANT_DELIVERY_ENABLED unset, hourly runs never contact the provider.
 *   6. Isolation: a business without the feature gets nothing from any run.
 *
 * env: OWNER_URL, DATABASE_URL, DIRECT_URL. Synthetic only. ZERO real network.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

process.env.TZ = "UTC";
process.env.STORAGE_PROVIDER = "local";
process.env.LOCAL_STORAGE_ROOT = mkdtempSync(path.join(os.tmpdir(), "acct-hourly-"));
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

// Resend emulator: one message per Idempotency-Key.
let mode: "sent" | "503" | "timeout" = "sent";
const calls: { key: string }[] = [];
const messages = new Set<string>();
let otherNetwork = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (!String(input).startsWith("https://api.resend.com/")) { otherNetwork++; throw new Error("no network"); }
  const key = String((init?.headers as Record<string, string>)["Idempotency-Key"]);
  calls.push({ key });
  if (mode === "timeout") { messages.add(key); const e = new Error("timeout"); e.name = "TimeoutError"; throw e; }
  if (mode === "503") return new Response(JSON.stringify({ name: "internal_server_error" }), { status: 503 });
  messages.add(key);
  return new Response(JSON.stringify({ id: `msg_${messages.size}` }), { status: 200 });
}) as typeof fetch;

async function main() {
  const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { putDocumentObject } = await import("@/lib/services/documents/document-storage.service");
  const { runAccountantSweep, defaultSweepDeps } = await import("@/lib/accountant/sweep");
  const del = await import("@/lib/accountant/delivery.service");
  const { setRecipient } = await import("@/lib/accountant/recipient.service");
  const { noteDocumentChangeForAccountant } = await import("@/lib/accountant/change-hooks");
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
  const one = async (sql: string, ...a: unknown[]) => Number(((await owner.$queryRawUnsafe(sql, ...a)) as { id: number }[])[0].id);
  let n = 0;
  const doc = async (b: number, day: string, amount: number) => {
    const body = Buffer.from(`%PDF-1.4 hourly ${++n}`);
    const basename = `doc-${Date.now()}${n}-hourly.pdf`;
    await putDocumentObject({ businessId: b, basename, body, contentType: "application/pdf", source: "file" });
    const d = await one(`INSERT INTO "Document" ("businessId", "fileUrl", "source", "mimeType", "status", "createdAt", "contentHashSha256") VALUES ($1, $2, 'file', 'application/pdf', 'approved', $3::timestamp, $4) RETURNING "id"`, b, basename, `2026-09-${day}T08:00:00`, sha(body));
    await owner.$executeRawUnsafe(`INSERT INTO "FinancialRecord" ("documentId", "businessId", "amount", "date", "vendorName", "direction", "category") VALUES ($1, $2, $3, $4::timestamp, 'ספק', 'expense', 'general')`, d, b, amount, `2026-09-${day}T00:00:00`);
    return d;
  };
  const business = async (name: string, enabled: boolean) => {
    const b = await one(`INSERT INTO "Business" ("name", "updatedAt") VALUES ($1, now()) RETURNING "id"`, name);
    const u = await one(`INSERT INTO "User" ("email", "password", "businessId", "updatedAt") VALUES ($1, 'x', $2, now()) RETURNING "id"`, `${name}-${b}@hourly.lab`, b);
    if (enabled) await owner.$executeRawUnsafe(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") VALUES ($1, 'accountant_month_close', 'ENABLED', now())`, b);
    await doc(b, "05", 100);
    await doc(b, "12", 250.5);
    return { b, u };
  };
  const A = await business("acct-hourly-A", true);
  const C = await business("acct-hourly-C", true);
  const D = await business("acct-hourly-D", false);
  const ours = [A.b, C.b, D.b];

  // Only our businesses, in a fixed order (the lab may hold others); the real enablement check.
  let clock = new Date("2026-10-01T00:30:00Z");
  const deps = { ...defaultSweepDeps, now: () => clock, listBusinessIds: async () => ours, shuffle: <T>(x: T[]) => x };
  const sweep = () => runAccountantSweep(deps);
  const pkgs = (b: number) => owner.accountantPackage.count({ where: { businessId: b } });
  const liveNotices = (b: number) => owner.notification.count({ where: { businessId: b, resolvedAt: null } });

  // ── 1. Packages ────────────────────────────────────────────────────────────────────────────────
  console.log("1. packages under hourly runs");
  const first = await sweep();
  ok("1a the first run on the 1st prepares the closed month for each enabled business", first.eligible === 2 && first.built === 2, JSON.stringify(first));
  const [s1, s2] = await Promise.all([sweep(), sweep()]);
  ok("1b two runs at the same moment build nothing more", (await pkgs(A.b)) === 1 && (await pkgs(C.b)) === 1 && s1.built + s2.built === 0, JSON.stringify([s1.built, s2.built]));
  let built = 0;
  for (let h = 1; h <= 47; h++) { clock = new Date(clock.getTime() + 3600_000); built += (await sweep()).built; }
  ok("1c 47 more hourly runs over two days, unchanged data → no new version", built === 0 && (await pkgs(A.b)) === 1 && (await pkgs(C.b)) === 1, String(built));
  ok("1d one READY package per month per business", (await owner.accountantPackage.count({ where: { businessId: A.b, status: "READY" } })) === 1);
  const late = await doc(A.b, "28", 40);
  await runWithTenantContext({ businessId: A.b }, () => noteDocumentChangeForAccountant(A.b, late, clock));
  clock = new Date(clock.getTime() + 3600_000);
  const [c1, c2] = await Promise.all([sweep(), sweep()]);
  ok("1e a real change: the next (overlapping) runs build exactly ONE new version", (await pkgs(A.b)) === 2 && (await owner.accountantPackage.count({ where: { businessId: A.b, status: "READY" } })) === 1 && c1.built + c2.built === 1, JSON.stringify([c1.built, c2.built]));
  for (let h = 1; h <= 3; h++) { clock = new Date(clock.getTime() + 3600_000); await sweep(); }
  ok("1f …and nothing after it", (await pkgs(A.b)) === 2);

  // ── 2. Notices ─────────────────────────────────────────────────────────────────────────────────
  console.log("2. notices");
  ok("2a after ~52 hourly runs the owner has ONE live notice for the month", (await liveNotices(A.b)) === 1 && (await liveNotices(C.b)) === 1, `${await liveNotices(A.b)} / ${await liveNotices(C.b)}`);

  // ── 3. A retry by the next hourly run ──────────────────────────────────────────────────────────
  console.log("3. a retry by the hourly run");
  const approve = async (x: { b: number; u: number }) => {
    await runWithTenantContext({ businessId: x.b }, async () => {
      if (!(await owner.accountantRecipient.findUnique({ where: { businessId: x.b } }))) {
        await setRecipient({ businessId: x.b, userId: x.u, name: "רו\"ח", email: "cpa@example.com", expectedVersion: null, confirm: true, now: clock });
      }
    });
    const p = await owner.accountantPackage.findFirstOrThrow({ where: { businessId: x.b, status: "READY" } });
    return runWithTenantContext({ businessId: x.b }, () => del.approveDelivery({ businessId: x.b, userId: x.u, periodKey: KEY, packageId: p.id, packageSha256: p.sha256!,
      recipientVersion: 1, recipientEmail: "cpa@example.com", acknowledgeIncomplete: true, idempotencyKey: `send:hourly-${x.b}-${Date.now()}`, now: clock }));
  };
  const a1 = await approve(A);
  mode = "503";
  await runWithTenantContext({ businessId: A.b }, () => del.attemptDelivery(A.b, a1.deliveryId, clock)); // the route's immediate attempt
  ok("3a the immediate attempt meets a 503 → waiting for a retry", (await owner.accountantDelivery.findUniqueOrThrow({ where: { id: a1.deliveryId } })).status === "APPROVED");
  mode = "sent";
  clock = new Date(clock.getTime() + 3600_000);
  const [r1, r2] = await Promise.all([sweep(), sweep()]);
  const dA = await owner.accountantDelivery.findUniqueOrThrow({ where: { id: a1.deliveryId } });
  ok("3b the next hourly run (two overlapping) retries it once and it is accepted", dA.status === "ACCEPTED" && dA.attempts === 2, `${dA.status} ${dA.attempts} ${r1.deliveriesProcessed}+${r2.deliveriesProcessed}`);
  ok("3c both attempts used the SAME key; the provider holds ONE message", calls.filter((c) => c.key === `acct:${a1.deliveryId}`).length === 2 && [...messages].filter((m) => m === `acct:${a1.deliveryId}`).length === 1);
  clock = new Date(clock.getTime() + 3600_000);
  await sweep();
  ok("3d later hourly runs never send it again", calls.filter((c) => c.key === `acct:${a1.deliveryId}`).length === 2);

  // ── 4. The 24 h window and the 7 attempts ──────────────────────────────────────────────────────
  console.log("4. the window and the attempt limit");
  const approvedAt = clock;
  const c1d = await approve(C);
  mode = "timeout";
  await runWithTenantContext({ businessId: C.b }, () => del.attemptDelivery(C.b, c1d.deliveryId, clock));
  let endedAt: Date | null = null;
  for (let h = 1; h <= 30; h++) {
    clock = new Date(clock.getTime() + 3600_000);
    await sweep();
    const d = await owner.accountantDelivery.findUniqueOrThrow({ where: { id: c1d.deliveryId } });
    if (d.status === "FAILED" && !endedAt) endedAt = clock;
  }
  const dC = await owner.accountantDelivery.findUniqueOrThrow({ where: { id: c1d.deliveryId } });
  ok("4a never more than 7 attempts", dC.attempts <= 7, String(dC.attempts));
  ok("4b it ends FAILED with a no-answer code inside the 24 h window", dC.status === "FAILED" && /^timeout/.test(dC.failureCode ?? "") && !!endedAt && endedAt.getTime() - approvedAt.getTime() <= 24 * 3600_000,
    `${dC.status} ${dC.failureCode} after ${endedAt ? (endedAt.getTime() - approvedAt.getTime()) / 3600_000 : "?"} h`);
  ok("4c every attempt used the same key: still ONE message at the provider", [...messages].filter((m) => m === `acct:${c1d.deliveryId}`).length === 1 && calls.filter((c) => c.key === `acct:${c1d.deliveryId}`).length === dC.attempts);

  // ── 5. Switch off ──────────────────────────────────────────────────────────────────────────────
  console.log("5. switch off");
  mode = "sent";
  delete process.env.ACCOUNTANT_DELIVERY_ENABLED;
  const before = calls.length;
  for (let h = 1; h <= 5; h++) { clock = new Date(clock.getTime() + 3600_000); const s = await sweep(); if (s.deliveriesProcessed !== 0) ok("5x no delivery processed while off", false); }
  ok("5a with the switch off, hourly runs never contact the provider", calls.length === before);
  process.env.ACCOUNTANT_DELIVERY_ENABLED = "true";

  // ── 6. Isolation ───────────────────────────────────────────────────────────────────────────────
  console.log("6. isolation");
  ok("6a a business without the feature got nothing from ~90 runs", (await owner.accountantPeriod.count({ where: { businessId: D.b } })) === 0 && (await pkgs(D.b)) === 0 && (await liveNotices(D.b)) === 0);
  ok("6b no network other than the emulator", otherNetwork === 0);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
  await owner.$disconnect();
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => process.exit());
