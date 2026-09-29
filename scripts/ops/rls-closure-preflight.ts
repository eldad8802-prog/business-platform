/**
 * Tenant/RLS closure — Production PREFLIGHT and POST-MIGRATION proof. SCRIPT-ONLY, READ-ONLY, counts only.
 *
 *   OWNER_DATABASE_URL=… RUNTIME_DATABASE_URL=… node_modules/.bin/tsx scripts/ops/rls-closure-preflight.ts \
 *     --expected-runtime-user app_runtime_prod --allow-host ep-flat-brook-am4bhq1y
 *
 * Two identities, reusing runtime-rls-evidence.ts's fail-closed preconditions (direct URL on the
 * verified host; sessions READ ONLY by Postgres, verified; the runtime is exactly app_runtime_prod,
 * NOSUPERUSER, NOBYPASSRLS, a member of app_runtime).
 *
 *   OWNER   catalog facts (RLS / FORCE / policies / runtime privileges), whether the closure migration is
 *           applied, and TENANT-INTEGRITY counts: rows whose tenant key is NULL or points at no business,
 *           and child rows whose tenant differs from their parent's. Counts only — no id, no value.
 *   RUNTIME with NO tenant context: how many rows of each table are visible. Before the migration this
 *           measures the gap; after it, every number must be zero.
 *
 * Exit: 0 PASS · 1 integrity or isolation problem · 3 REFUSED (precondition) · 2 usage.
 */
import { PrismaClient } from "@prisma/client";
import { assertSafeUrl, enforceReadOnly, RefusedError, verifyReadOnly, verifyRuntimeIdentity } from "./runtime-rls-evidence";

const TABLES = ["InventorySale", "InventorySaleLine", "InventorySourceSaleLine", "BusinessAsset", "CouponSurfaceEvent", "ContentVariant"] as const;
const KEY: Record<string, string> = { CouponSurfaceEvent: "issuingBusinessId" };
const keyOf = (t: string) => KEY[t] ?? "businessId";
const MIGRATION = "20260929090000_tenant_rls_closure";

/** Child/parent tenant agreement. Each is a COUNT of disagreeing rows; zero is the only acceptable value. */
const INTEGRITY: Record<string, string> = {
  saleLine_vs_sale: `SELECT count(*)::int AS n FROM "InventorySaleLine" c JOIN "InventorySale" p ON p.id = c."saleId" WHERE p."businessId" <> c."businessId"`,
  saleLine_vs_item: `SELECT count(*)::int AS n FROM "InventorySaleLine" c JOIN "InventoryItem" p ON p.id = c."itemId" WHERE p."businessId" <> c."businessId"`,
  saleLine_vs_movement: `SELECT count(*)::int AS n FROM "InventorySaleLine" c JOIN "InventoryMovement" p ON p.id = c."movementId" WHERE p."businessId" <> c."businessId"`,
  sourceLine_vs_saleLine: `SELECT count(*)::int AS n FROM "InventorySourceSaleLine" c JOIN "InventorySaleLine" p ON p.id = c."saleLineId" WHERE p."businessId" <> c."businessId"`,
  sourceLine_vs_item: `SELECT count(*)::int AS n FROM "InventorySourceSaleLine" c JOIN "InventoryItem" p ON p.id = c."recognizedItemId" WHERE p."businessId" <> c."businessId"`,
  asset_vs_contentRun: `SELECT count(*)::int AS n FROM "BusinessAsset" c JOIN "ContentRun" p ON p.id = c."contentRunId" WHERE p."businessId" <> c."businessId"`,
  surface_vs_coupon: `SELECT count(*)::int AS n FROM "CouponSurfaceEvent" c JOIN "Coupon" p ON p.id = c."couponId" WHERE p."issuingBusinessId" <> c."issuingBusinessId"`,
  surface_vs_offer: `SELECT count(*)::int AS n FROM "CouponSurfaceEvent" c JOIN "Offer" p ON p.id = c."offerId" WHERE p."issuingBusinessId" <> c."issuingBusinessId"`,
  contentVariant_vs_contentRun: `SELECT count(*)::int AS n FROM "ContentVariant" c JOIN "ContentRun" p ON p.id = c."contentRunId" WHERE p."businessId" <> c."businessId"`,
  // Not repaired here (pending owner decision), measured so the decision is made on facts.
  pending_coupon_vs_offer: `SELECT count(*)::int AS n FROM "Coupon" c JOIN "Offer" p ON p.id = c."offerId" WHERE p."issuingBusinessId" <> c."issuingBusinessId"`,
};

const n = async (db: PrismaClient, sql: string) => Number((await db.$queryRawUnsafe<{ n: number }[]>(sql))[0]?.n ?? -1);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const expected = arg("--expected-runtime-user");
  const allowHost = arg("--allow-host") ?? null;
  if (!expected) { console.error("usage: --expected-runtime-user <login> [--allow-host <host>]"); process.exit(2); }
  let owner: PrismaClient | undefined;
  let runtime: PrismaClient | undefined;
  try {
    owner = new PrismaClient({ datasourceUrl: assertSafeUrl("OWNER_DATABASE_URL", process.env.OWNER_DATABASE_URL, allowHost) });
    runtime = new PrismaClient({ datasourceUrl: assertSafeUrl("RUNTIME_DATABASE_URL", process.env.RUNTIME_DATABASE_URL, allowHost) });
    await enforceReadOnly(owner, "owner");
    await enforceReadOnly(runtime, "runtime");
    const identity = await verifyRuntimeIdentity(runtime, expected);

    const applied = await n(owner, `SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE migration_name = '${MIGRATION}' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`);
    const catalog: Record<string, unknown> = {};
    const rows: Record<string, unknown> = {};
    const noContext: Record<string, number> = {};
    for (const t of TABLES) {
      const [c] = await owner.$queryRawUnsafe<{ rls: boolean; force: boolean }[]>(
        `SELECT relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class WHERE relname = $1 AND relnamespace = 'public'::regnamespace`, t);
      const pols = await owner.$queryRawUnsafe<{ cmd: string; k: number }[]>(`SELECT cmd, count(*)::int AS k FROM pg_policies WHERE tablename = $1 GROUP BY cmd ORDER BY cmd`, t);
      const [g] = await owner.$queryRawUnsafe<{ sel: boolean; ins: boolean; upd: boolean; del: boolean }[]>(
        `SELECT has_table_privilege($1, format('public.%I', $2::text), 'SELECT') AS sel, has_table_privilege($1, format('public.%I', $2::text), 'INSERT') AS ins,
                has_table_privilege($1, format('public.%I', $2::text), 'UPDATE') AS upd, has_table_privilege($1, format('public.%I', $2::text), 'DELETE') AS del`, expected, t);
      catalog[t] = { rls: c?.rls, force: c?.force, policies: Object.fromEntries(pols.map((p) => [p.cmd, p.k])), runtime: g };
      const k = keyOf(t);
      rows[t] = {
        total: await n(owner, `SELECT count(*)::int AS n FROM "${t}"`),
        businesses: await n(owner, `SELECT count(DISTINCT "${k}")::int AS n FROM "${t}"`),
        nullTenant: await n(owner, `SELECT count(*)::int AS n FROM "${t}" WHERE "${k}" IS NULL`),
        orphanTenant: await n(owner, `SELECT count(*)::int AS n FROM "${t}" x WHERE NOT EXISTS (SELECT 1 FROM "Business" b WHERE b.id = x."${k}")`),
      };
      noContext[t] = await n(runtime, `SELECT count(*)::int AS n FROM "${t}"`);
    }
    const integrity: Record<string, number> = {};
    for (const [name, sql] of Object.entries(INTEGRITY)) integrity[name] = await n(owner, sql);
    const [posDel] = await owner.$queryRawUnsafe<{ d: boolean }[]>(`SELECT has_table_privilege($1, 'public."POSApiKey"', 'DELETE') AS d`, expected);
    await verifyReadOnly(owner, "owner");
    await verifyReadOnly(runtime, "runtime");

    const integrityClean = Object.entries(integrity).filter(([k]) => !k.startsWith("pending_")).every(([, v]) => v === 0) &&
      TABLES.every((t) => (rows[t] as { nullTenant: number; orphanTenant: number }).nullTenant === 0 && (rows[t] as { orphanTenant: number }).orphanTenant === 0);
    const isolationHolds = applied === 1 ? TABLES.every((t) => noContext[t] === 0) : null;
    console.log(JSON.stringify({
      migrationApplied: applied === 1,
      runtime: { user: identity.user, superuser: identity.superuser, bypassRls: identity.bypassRls, memberOfAppRuntime: identity.memberOfAppRuntime },
      catalog, rows, integrity, runtimeVisibleWithoutTenant: noContext, posApiKeyRuntimeDelete: posDel?.d ?? null,
      integrityClean, isolationHolds,
    }, null, 1));
    process.exitCode = integrityClean && isolationHolds !== false ? 0 : 1;
  } catch (e) {
    if (e instanceof RefusedError) { console.error(`REFUSED: ${e.message}`); process.exitCode = 3; }
    else { console.error(`FAILED: ${e instanceof Error ? e.name : "unknown"}`); process.exitCode = 1; }
  } finally {
    await owner?.$disconnect();
    await runtime?.$disconnect();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/ops/rls-closure-preflight.ts")) void main();
