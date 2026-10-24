/**
 * "מבנה אחיד" export — the tenant-context defect and its correction, measured as the real runtime role.
 *
 * Before: app/api/reports/uniform/route.ts called loadUniformExportInput with no tenant context, so the loader
 * read BillingDocument (FORCE RLS) through the global client. As a NOBYPASSRLS runtime that read sees NO row:
 * the export is a well-formed, EMPTY file. After: the route runs the loader inside the caller's tenant
 * transaction.
 *
 *   1. the old call (no context) returns zero issued documents for a business that has two (the defect);
 *   2. the corrected call (runWithTenantContext + withTenantTransaction) returns exactly those two;
 *   3. it never returns another business's documents, even when asked for that business's id;
 *   4. the route itself establishes the context (static, comments stripped).
 *
 * env: OWNER_URL (fixtures), DATABASE_URL (app_runtime_prod, NOBYPASSRLS). Synthetic only. ZERO network.
 */
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

async function main() {
  const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
  const { loadUniformExportInput } = await import("@/lib/services/billing/uniform/uniform-export-loader");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { withTenantTransaction } = await import("@/lib/tenant/transaction");

  // A lab built with `db push` records the historical migrations without running their RLS statements; the
  // table is put under the exact policies Production got from 20260902120000_d2_cutover2b_pilot_tenant_rls.
  const rls = (await owner.$queryRawUnsafe(`SELECT relforcerowsecurity AS f FROM pg_class WHERE relname = 'BillingDocument'`)) as { f: boolean }[];
  if (!rls[0]?.f) {
    await owner.$executeRawUnsafe(`ALTER TABLE "BillingDocument" ENABLE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`ALTER TABLE "BillingDocument" FORCE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`CREATE POLICY p7pilot_tenant_read ON "BillingDocument" FOR SELECT
      USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)`);
    await owner.$executeRawUnsafe(`CREATE POLICY p7pilot_tenant_insert ON "BillingDocument" FOR INSERT
      WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)`);
    await owner.$executeRawUnsafe(`CREATE POLICY p7pilot_tenant_update ON "BillingDocument" FOR UPDATE
      USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
      WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)`);
  }
  const one = async (sql: string, ...a: unknown[]) => Number(((await owner.$queryRawUnsafe(sql, ...a)) as { id: number }[])[0].id);
  const bizA = await one(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('uni-A', now()) RETURNING "id"`);
  const bizB = await one(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('uni-B', now()) RETURNING "id"`);
  const issue = (b: number, n: number) =>
    owner.$executeRawUnsafe(`INSERT INTO "BillingDocument" ("businessId", "documentType", "status", "documentNumber", "documentNumberFormatted", "issuedAt", "totalAmount", "updatedAt")
      VALUES ($1, 'RECEIPT', 'ISSUED', $2, $3, '2026-09-15T09:00:00', 100, now())`, b, n, `R-${n}`);
  await issue(bizA, 1);
  await issue(bizA, 2);
  await issue(bizB, 1);
  const range = { periodStart: "2026-09-01T00:00:00.000Z", periodEnd: "2026-09-30T23:59:59.999Z" };

  const before = await loadUniformExportInput({ businessId: bizA, ...range });
  ok("1. the old call (no tenant context) exports zero documents — the defect, reproduced", before.documents.length === 0, String(before.documents.length));

  const fixed = (businessId: number, asked: number) =>
    runWithTenantContext({ businessId }, () =>
      withTenantTransaction((tx) =>
        loadUniformExportInput({ businessId: asked, ...range, client: tx as unknown as Parameters<typeof loadUniformExportInput>[0]["client"] })
      )
    );
  const after = await fixed(bizA, bizA);
  ok("2. the corrected call exports exactly the business's two documents", after.documents.length === 2, String(after.documents.length));
  const crossed = await fixed(bizA, bizB);
  ok("3. inside A's context, asking for B returns nothing of B", crossed.documents.length === 0, String(crossed.documents.length));

  const src = fs
    .readFileSync("app/api/reports/uniform/route.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  ok("4. the route runs the loader inside runWithTenantContext + withTenantTransaction",
    /runWithTenantContext\(\{ businessId: user\.businessId \}/.test(src) && /withTenantTransaction\(\(tx\)/.test(src) && /client: tx/.test(src));

  await owner.$disconnect();
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => process.exit());
