/**
 * Derive-authority migration — Production proof. SCRIPT-ONLY, READ-ONLY, counts and booleans only.
 *
 *   OWNER_DATABASE_URL=… RUNTIME_DATABASE_URL=… node_modules/.bin/tsx scripts/ops/derive-authority-evidence.ts \
 *     --expected-runtime-user app_runtime_prod --allow-host ep-flat-brook-am4bhq1y
 *
 * Reuses runtime-rls-evidence.ts's fail-closed preconditions: direct URLs on the verified host, both
 * sessions READ ONLY by Postgres (verified before and after), the runtime exactly app_runtime_prod,
 * NOSUPERUSER, NOBYPASSRLS, a member of app_runtime.
 *
 *   OWNER    migration ledger; the knowledge_derivation feature (default OFF, policy OFF); how many
 *            businesses are enrolled (must be zero); KnowledgeDerivationRun catalog: RLS/FORCE,
 *            per-command policies, the one-running partial unique index, the finished-run guard trigger,
 *            CHECKs, the runtime's privileges, and the row count.
 *   RUNTIME  with NO tenant context, and inside ONE tenant's transaction-local context: how many runs of
 *            ANY / ANOTHER business are visible. set_config(..., true) is not a write; nothing is written.
 *
 * Exit: 0 PASS · 1 FAIL · 3 REFUSED (precondition) · 2 usage.
 */
import { PrismaClient } from "@prisma/client";
import { assertSafeUrl, enforceReadOnly, RefusedError, verifyReadOnly, verifyRuntimeIdentity } from "./runtime-rls-evidence";

const MIGRATION = "20260930090000_knowledge_derive_authority";
const T = "KnowledgeDerivationRun";
const n = async (db: PrismaClient, sql: string, ...p: unknown[]) => Number((await db.$queryRawUnsafe<{ n: number }[]>(sql, ...p))[0]?.n ?? -1);

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

    const migrationApplied = (await n(owner, `SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`, MIGRATION)) === 1;
    const [def] = await owner.$queryRawUnsafe<{ d: boolean }[]>(`SELECT "defaultEnabled" AS d FROM "PlatformFeatureDefinition" WHERE key = 'knowledge_derivation'`);
    const [pol] = await owner.$queryRawUnsafe<{ g: boolean; e: boolean }[]>(`SELECT "globalEnabled" AS g, "emergencyDisabled" AS e FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'knowledge_derivation'`);
    const enrolledAny = await n(owner, `SELECT count(*)::int AS n FROM "BusinessFeatureAccess" WHERE "featureKey" = 'knowledge_derivation'`);
    const enrolledOn = await n(owner, `SELECT count(*)::int AS n FROM "BusinessFeatureAccess" WHERE "featureKey" = 'knowledge_derivation' AND state = 'ENABLED'`);

    const [c] = await owner.$queryRawUnsafe<{ rls: boolean; force: boolean }[]>(
      `SELECT relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class WHERE relname = $1 AND relnamespace = 'public'::regnamespace`, T);
    const policies = await owner.$queryRawUnsafe<{ cmd: string; k: number }[]>(`SELECT cmd, count(*)::int AS k FROM pg_policies WHERE tablename = $1 GROUP BY cmd ORDER BY cmd`, T);
    const [g] = await owner.$queryRawUnsafe<{ sel: boolean; ins: boolean; upd: boolean; del: boolean; trunc: boolean }[]>(
      `SELECT has_table_privilege($1, 'public."KnowledgeDerivationRun"', 'SELECT') AS sel, has_table_privilege($1, 'public."KnowledgeDerivationRun"', 'INSERT') AS ins,
              has_table_privilege($1, 'public."KnowledgeDerivationRun"', 'UPDATE') AS upd, has_table_privilege($1, 'public."KnowledgeDerivationRun"', 'DELETE') AS del,
              has_table_privilege($1, 'public."KnowledgeDerivationRun"', 'TRUNCATE') AS trunc`, expected);
    const oneRunningIndex = (await n(owner, `SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = $1 AND indexname = 'KnowledgeDerivationRun_one_running_key'
      AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%WHERE%RUNNING%'`, T)) === 1;
    const guardTrigger = (await n(owner, `SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE r.relname = $1 AND NOT t.tgisinternal AND t.tgenabled = 'O' AND p.proname = 'kdr_run_guard'
        AND pg_get_functiondef(p.oid) LIKE '%KDR_IMMUTABLE%' AND pg_get_functiondef(p.oid) LIKE '%KDR_APPEND_ONLY%'`, T)) === 1;
    const checks = await n(owner, `SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid WHERE r.relname = $1 AND c.contype = 'c'`, T);
    const totalRuns = await n(owner, `SELECT count(*)::int AS n FROM "KnowledgeDerivationRun"`);
    const probeBusiness = (await owner.$queryRawUnsafe<{ id: number | null }[]>(`SELECT min(id)::int AS id FROM "Business"`))[0]?.id ?? null;

    // Runtime: no context, then ONE tenant's transaction-local context (set_config is not a write).
    const noContext = await n(runtime, `SELECT count(*)::int AS n FROM "KnowledgeDerivationRun"`);
    let crossTenant = -1;
    if (probeBusiness != null) {
      crossTenant = await runtime.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(probeBusiness));
        return Number((await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "KnowledgeDerivationRun" WHERE "businessId" <> $1`, probeBusiness))[0]?.n ?? -1);
      });
    }
    await verifyReadOnly(owner, "owner");
    await verifyReadOnly(runtime, "runtime");

    const pmap = Object.fromEntries(policies.map((p) => [p.cmd, p.k]));
    const result = {
      migrationApplied,
      runtime: { user: identity.user, superuser: identity.superuser, bypassRls: identity.bypassRls, memberOfAppRuntime: identity.memberOfAppRuntime },
      feature: { defaultEnabled: def?.d ?? null, globalEnabled: pol?.g ?? null, emergencyDisabled: pol?.e ?? null, overrides: enrolledAny, enrolled: enrolledOn },
      run: { rls: c?.rls, force: c?.force, policies: pmap, runtimePrivileges: g, oneRunningIndex, guardTrigger, checkConstraints: checks, totalRuns,
        runtimeVisibleWithoutTenant: noContext, runtimeVisibleForeignInsideTenant: crossTenant },
    };
    const pass = migrationApplied && def?.d === false && pol?.g === false && enrolledOn === 0 &&
      c?.rls === true && c?.force === true && pmap.SELECT === 1 && pmap.INSERT === 1 && pmap.UPDATE === 1 && !pmap.ALL && !pmap.DELETE &&
      g?.sel === true && g?.ins === true && g?.upd === true && g?.del === false && g?.trunc === false &&
      oneRunningIndex && guardTrigger && checks === 6 && noContext === 0 && crossTenant === 0 &&
      identity.superuser === false && identity.bypassRls === false;
    console.log(JSON.stringify({ ...result, pass }, null, 1));
    process.exitCode = pass ? 0 : 1;
  } catch (e) {
    if (e instanceof RefusedError) { console.error(`REFUSED: ${e.message}`); process.exitCode = 3; }
    else { console.error(`FAILED: ${e instanceof Error ? e.name : "unknown"} ${(e as { code?: string })?.code ?? ""}`); process.exitCode = 1; }
  } finally {
    await owner?.$disconnect();
    await runtime?.$disconnect();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/ops/derive-authority-evidence.ts")) void main();
