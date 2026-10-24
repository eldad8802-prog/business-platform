/**
 * Monthly accountant workflow — a REAL build failure is reported as a failure (regression for the outcome
 * defect found in G2 readiness: storage refusing the ZIP after it was rendered was counted as "built").
 *
 * The real sweep route and preparation run on the Production-shaped lab as app_runtime_prod, with a
 * controlled clock and a storage that refuses the package once:
 *
 *   1. the failure is reported as a failure — the preparation outcome, the sweep summary, the route's body;
 *   2. the state stays right: the month PREPARATION_FAILED, the package FAILED, no READY package;
 *   3. the owner gets exactly one live notice, the failure one, in the owner's words;
 *   4. the retry follows the rules: not inside the hour, then once — one READY package, the failure notice
 *      resolved, the month ready for review;
 *   5. nothing leaves: zero deliveries, zero network calls, no second package for the same content; and a
 *      second business in the same runs is prepared normally (one failure never stops the others).
 *
 * env: OWNER_URL, DATABASE_URL (runtime). Synthetic only. ZERO network.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.STORAGE_PROVIDER = "local";
process.env.LOCAL_STORAGE_ROOT = mkdtempSync(path.join(os.tmpdir(), "acct-bf-"));
process.env.AUTH_TOKEN_SECRET = "acct-lab-synthetic-auth-token-secret-0123456789";
process.env.APP_BASE_URL = "https://app.example.com";
delete process.env.ACCOUNTANT_DELIVERY_ENABLED;

import { PrismaClient } from "@prisma/client";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
let networkCalls = 0;
globalThis.fetch = (async () => { networkCalls++; throw new Error("network is not allowed in this battery"); }) as typeof fetch;

async function main() {
  const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
  const prep = await import("@/lib/accountant/prepare.service");
  const { runAccountantSweep, defaultSweepDeps } = await import("@/lib/accountant/sweep");
  const { putDocumentObject } = await import("@/lib/services/documents/document-storage.service");

  // Tenant-only FORCE RLS on the tables the workflow reads (the same lab setup as app-battery.ts).
  for (const t of ["FinancialRecord", "Document", "BillingDocument", "BillingAuthoritySubmission", "Notification", "NotificationDelivery", "BusinessProfile", "BusinessFeatureAccess"]) {
    const on = (await owner.$queryRawUnsafe(`SELECT relforcerowsecurity AS f FROM pg_class WHERE relname = $1`, t)) as { f: boolean }[];
    if (on[0]?.f) continue;
    await owner.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`CREATE POLICY acct_lab_tenant ON "${t}" FOR ALL
      USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
      WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)`);
  }

  // ── Fixtures: two enabled businesses, each with one approved September document (file in storage) ──
  const one = async (sql: string, ...a: unknown[]) => Number(((await owner.$queryRawUnsafe(sql, ...a)) as { id: number }[])[0].id);
  let n = 0;
  const business = async (name: string) => {
    const b = await one(`INSERT INTO "Business" ("name", "updatedAt") VALUES ($1, now()) RETURNING "id"`, name);
    await owner.$executeRawUnsafe(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") VALUES ($1, 'accountant_month_close', 'ENABLED', now())`, b);
    const basename = `doc-${Date.now()}${++n}-bf.pdf`;
    await putDocumentObject({ businessId: b, basename, body: Buffer.from(`%PDF-bf-${n}`), contentType: "application/pdf", source: "file" });
    const d = await one(`INSERT INTO "Document" ("businessId", "fileUrl", "source", "mimeType", "status", "createdAt") VALUES ($1, $2, 'file', 'application/pdf', 'approved', '2026-09-10T08:00:00') RETURNING "id"`, b, basename);
    await owner.$executeRawUnsafe(`INSERT INTO "FinancialRecord" ("documentId", "businessId", "amount", "date", "vendorName", "direction", "category") VALUES ($1, $2, 100, '2026-09-10T00:00:00', 'ספק', 'expense', 'general')`, d, b);
    return b;
  };
  const bad = await business("bf-storage-refuses");
  const good = await business("bf-healthy");

  let clock = new Date("2026-10-26T06:00:00Z");
  let refuseFor: number | null = bad;
  const deps = () => ({
    ...prep.defaultPrepareDeps,
    now: () => clock,
    putPackage: async (b: number, key: string, body: Buffer) => {
      if (b === refuseFor) throw new Error("lab: storage refused the package");
      return prep.defaultPrepareDeps.putPackage(b, key, body);
    },
  });
  const sweep = () => runAccountantSweep({
    ...defaultSweepDeps,
    now: () => clock,
    listBusinessIds: async () => [bad, good],
    prepare: (args) => prep.preparePeriod(args, deps()),
    shuffle: (a) => a,
  });
  const period = async (b: number) => ((await owner.$queryRawUnsafe(`SELECT status FROM "AccountantPeriod" WHERE "businessId" = $1 AND "periodKey" = '2026-09'`, b)) as { status: string }[])[0]?.status;
  const packages = async (b: number) => (await owner.$queryRawUnsafe(`SELECT status, "contentFingerprint" AS f FROM "AccountantPackage" WHERE "businessId" = $1 ORDER BY version`, b)) as { status: string; f: string }[];
  const notices = async (b: number) => (await owner.$queryRawUnsafe(`SELECT title, "resolvedAt" IS NULL AS live FROM "Notification" WHERE "businessId" = $1 AND "entityType" LIKE 'accountant_period%' ORDER BY id`, b)) as { title: string; live: boolean }[];

  // ── 1–3. The failure ───────────────────────────────────────────────────────────────────────────
  console.log("1–3. storage refuses the package");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const direct = await runWithTenantContext({ businessId: bad }, () => prep.preparePeriod({ businessId: bad, periodKey: "2026-09", trigger: "SCHEDULE", actor: { type: "SYSTEM" } }, deps()));
  ok("1a the preparation reports build_failed (not built)", direct.outcome === "build_failed", JSON.stringify(direct));
  ok("2a the month is PREPARATION_FAILED", (await period(bad)) === "PREPARATION_FAILED", String(await period(bad)));
  let p = await packages(bad);
  ok("2b the package is FAILED and no READY package exists", p.length === 1 && p[0].status === "FAILED", JSON.stringify(p));

  // The healthy business, in a sweep run that also meets the failing one (retry not yet due). The sweep is
  // what turns a month's state into the owner's notice (preparePeriod itself never notifies).
  clock = new Date("2026-10-26T06:30:00Z");
  let s = await sweep();
  ok("1b inside the hour the failing month is not retried; the healthy business is built in the same run", s.prepared === 1 && s.built === 1 && s.buildFailed === 0 && s.businessErrors === 0, JSON.stringify(s));
  ok("5a one failing business never stops another: the healthy one is READY_FOR_REVIEW", (await period(good)) === "READY_FOR_REVIEW", String(await period(good)));
  let nb = await notices(bad);
  ok("3a exactly one live notice — the failure one, in the owner's words", nb.filter((x) => x.live).length === 1 && /^לא הצלחנו להכין את הקובץ לרואה החשבון עבור חודש ספטמבר$/.test(nb.find((x) => x.live)!.title), JSON.stringify(nb));

  // The failure seen through the sweep — the summary the route returns to the schedulers — once the retry is
  // due and storage still refuses.
  clock = new Date("2026-10-26T07:05:00Z");
  s = await sweep();
  ok("1c the sweep summary counts the failure: buildFailed 1, built 0", s.buildFailed === 1 && s.built === 0 && s.prepared === 1, JSON.stringify(s));
  ok("2c still PREPARATION_FAILED, still no READY package", (await period(bad)) === "PREPARATION_FAILED" && (await packages(bad)).every((x) => x.status !== "READY"));
  nb = await notices(bad);
  ok("3b still one live notice (the failure is not notified twice)", nb.filter((x) => x.live).length === 1, JSON.stringify(nb));

  // ── 4. The retry ───────────────────────────────────────────────────────────────────────────────
  console.log("4. storage recovers; the retry follows the rules");
  refuseFor = null;
  clock = new Date("2026-10-26T07:30:00Z");
  s = await sweep();
  ok("4a a retry inside the hour after the last failure does not run", s.prepared === 0, JSON.stringify(s));
  clock = new Date("2026-10-26T08:10:00Z");
  s = await sweep();
  ok("4b after the hour: retried once and built", s.prepared === 1 && s.built === 1 && s.buildFailed === 0, JSON.stringify(s));
  ok("4c the month is READY_FOR_REVIEW", (await period(bad)) === "READY_FOR_REVIEW", String(await period(bad)));
  nb = await notices(bad);
  ok("4d the failure notice is resolved; the one live notice says the file is ready", nb.filter((x) => x.live).length === 1 && /מוכן לבדיקה ולשליחה/.test(nb.find((x) => x.live)!.title), JSON.stringify(nb));
  clock = new Date("2026-10-26T09:10:00Z");
  s = await sweep();
  ok("4e a later run with no change builds nothing", s.built === 0 && s.buildFailed === 0, JSON.stringify(s));

  // ── 5. Nothing leaves, nothing doubles ─────────────────────────────────────────────────────────
  console.log("5. nothing leaves, nothing doubles");
  p = await packages(bad);
  ok("5b one READY package for the failing business; the failed attempt stays FAILED", p.filter((x) => x.status === "READY").length === 1 && p.filter((x) => x.status === "FAILED").length >= 1, JSON.stringify(p));
  ok("5c one READY package for the healthy business", (await packages(good)).filter((x) => x.status === "READY").length === 1);
  const deliveries = (await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "AccountantDelivery"`)) as { n: number }[];
  ok("5d zero deliveries and zero network calls", deliveries[0].n === 0 && networkCalls === 0, `${deliveries[0].n} | ${networkCalls}`);

  await owner.$disconnect();
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => process.exit());
