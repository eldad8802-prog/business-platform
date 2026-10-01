/**
 * Production control-plane cutover — PREFLIGHT. SCRIPT-ONLY, READ-ONLY, catalog facts and counts only.
 *
 *   OWNER_DATABASE_URL=… node_modules/.bin/tsx scripts/ops/control-plane-preflight-evidence.ts --allow-host ep-flat-brook-am4bhq1y
 *
 * What the cutover design needs to know about Production BEFORE any role or grant is written:
 *   C1  the PW-2 RLS migration (and the two foundations) are applied
 *   C2  the relevant roles: existence, LOGIN, SUPERUSER, BYPASSRLS, INHERIT, and who is a member of the
 *       app_ctlplane / app_admin / app_runtime / app_auth groups (role names only)
 *   C3  the effective privilege matrix of every relevant role on the five feature/audit tables and the
 *       two sequences, plus schema public USAGE/CREATE and any PUBLIC grants
 *   C4  RLS flags, every policy (name, command, roles, USING, WITH CHECK) and every non-internal trigger
 *   C5  default ACLs (what future tables hand to whom)
 *   C6  counts: overrides by feature/state, feature-access audit events; the QA sandbox tenant (38)
 *   C7  PlatformAuditEvent columns (the control-plane INSERT shape)
 * One owner session, READ ONLY by Postgres (verified before and after). No address, name, secret or row data.
 * Exit: 0 printed · 1 failed · 3 REFUSED · 2 usage.
 */
import { PrismaClient } from "@prisma/client";
import { assertSafeUrl, enforceReadOnly, RefusedError, verifyReadOnly } from "./runtime-rls-evidence";

const ROLES = ["app_ctlplane", "app_ctlplane_prod", "app_admin", "app_runtime", "app_runtime_prod", "app_auth", "app_auth_prod"];
const TABLES = ["BusinessFeatureAccess", "PlatformFeaturePolicy", "PlatformFeatureDefinition", "PlatformAuditEvent", "Business"];
const SEQUENCES = ["BusinessFeatureAccess_id_seq", "PlatformAuditEvent_id_seq"];
const PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;
const ABBR: Record<(typeof PRIVS)[number], string> = { SELECT: "r", INSERT: "a", UPDATE: "w", DELETE: "d", TRUNCATE: "D", REFERENCES: "x", TRIGGER: "t" };
const QA_BUSINESS_ID = 38;
const QA_BUSINESS_NAME = "QA COLLECTION SANDBOX — אין להשתמש";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--allow-host");
  const allowHost = i >= 0 ? argv[i + 1] : null;
  let db: PrismaClient | undefined;
  try {
    db = new PrismaClient({ datasourceUrl: assertSafeUrl("OWNER_DATABASE_URL", process.env.OWNER_DATABASE_URL, allowHost) });
    await enforceReadOnly(db, "owner");
    const errors: Record<string, string> = {};
    const q = async <T>(label: string, sql: string, ...p: unknown[]): Promise<T[]> => {
      try { return await db!.$queryRawUnsafe<T[]>(sql, ...p); }
      catch (e) {
        const m = (e as { meta?: { code?: string; message?: string } }).meta;
        errors[label] = `${m?.code ?? "?"} ${(m?.message ?? "").slice(0, 200)}`;
        return [];
      }
    };

    const migration = await q<Record<string, unknown>>("C1",
      `SELECT migration_name AS name, (finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied FROM "_prisma_migrations"
        WHERE migration_name IN ('20260901090000_d2_pw2_business_feature_access_rls', '20260527120000_platform_admin_foundation',
                                 '20260528120000_platform_feature_access_foundation', '20261003090000_control_plane_production_privileges') ORDER BY 1`);

    const roles = await q<{ role: string } & Record<string, unknown>>("C2roles",
      `SELECT rolname AS role, rolcanlogin AS login, rolsuper AS super, rolbypassrls AS bypassrls, rolinherit AS inherit,
              rolcreaterole AS createrole, rolcreatedb AS createdb, rolconnlimit AS connlimit
         FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY 1`, ROLES);
    const members = await q<Record<string, unknown>>("C2members",
      `SELECT g.rolname AS "group", m.rolname AS member, m.rolcanlogin AS "memberCanLogin", m.rolbypassrls AS "memberBypassRls"
         FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
        WHERE g.rolname IN ('app_ctlplane', 'app_admin', 'app_runtime', 'app_auth') ORDER BY 1, 2`);
    const existing = new Set(roles.map((r) => r.role));

    // Effective privileges (membership included). r=SELECT a=INSERT w=UPDATE d=DELETE D=TRUNCATE x=REFERENCES t=TRIGGER.
    const matrix: Record<string, Record<string, string>> = {};
    for (const r of ROLES.filter((x) => existing.has(x))) {
      matrix[r] = {};
      for (const t of TABLES) {
        const [row] = await q<Record<string, boolean>>(`C3 ${r}.${t}`,
          `SELECT ${PRIVS.map((p) => `has_table_privilege($1, 'public."${t}"', '${p}') AS "${p}"`).join(", ")}`, r);
        matrix[r][t] = row ? PRIVS.filter((p) => row[p]).map((p) => ABBR[p]).join("") || "-" : "?";
      }
      for (const s of SEQUENCES) {
        const [row] = await q<{ u: boolean; s: boolean; w: boolean }>(`C3 ${r}.${s}`,
          `SELECT has_sequence_privilege($1, 'public."${s}"', 'USAGE') AS u, has_sequence_privilege($1, 'public."${s}"', 'SELECT') AS s,
                  has_sequence_privilege($1, 'public."${s}"', 'UPDATE') AS w`, r);
        matrix[r][s] = row ? `${row.u ? "U" : ""}${row.s ? "r" : ""}${row.w ? "w" : ""}` || "-" : "?";
      }
      const [sc] = await q<{ u: boolean; c: boolean }>(`C3 ${r}.schema`,
        `SELECT has_schema_privilege($1, 'public', 'USAGE') AS u, has_schema_privilege($1, 'public', 'CREATE') AS c`, r);
      matrix[r]["schema public"] = sc ? `${sc.u ? "USAGE" : ""}${sc.c ? "+CREATE" : ""}` || "-" : "?";
    }
    const publicGrants = await q<Record<string, unknown>>("C3public",
      `SELECT table_name AS t, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs FROM information_schema.role_table_grants
        WHERE grantee = 'PUBLIC' AND table_schema = 'public' AND table_name = ANY($1::text[]) GROUP BY 1 ORDER BY 1`, TABLES);

    const rls = await q<Record<string, unknown>>("C4rls",
      `SELECT relname AS t, relrowsecurity AS rls, relforcerowsecurity AS force, pg_get_userbyid(relowner) AS owner
         FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[]) ORDER BY 1`, TABLES);
    const policies = await q<Record<string, unknown>>("C4policies",
      `SELECT tablename AS t, policyname AS name, cmd, permissive, roles::text AS roles, qual, with_check AS "withCheck"
         FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1::text[]) ORDER BY 1, 2`, TABLES);
    const triggers = await q<Record<string, unknown>>("C4triggers",
      `SELECT c.relname AS t, t.tgname AS name, t.tgenabled AS enabled, p.proname AS fn FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1::text[]) ORDER BY 1, 2`, TABLES);

    const defaultAcls = await q<Record<string, unknown>>("C5",
      `SELECT pg_get_userbyid(d.defaclrole) AS grantor, d.defaclobjtype AS objtype, coalesce(n.nspname, '*') AS schema, d.defaclacl::text AS acl
         FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace ORDER BY 1, 2`);

    const overrides = await q<Record<string, unknown>>("C6overrides",
      `SELECT "featureKey" AS feature, state::text AS state, count(*)::int AS n FROM "BusinessFeatureAccess" GROUP BY 1, 2 ORDER BY 1, 2`);
    const featureAudit = await q<Record<string, unknown>>("C6audit",
      `SELECT count(*)::int AS n FROM "PlatformAuditEvent" WHERE action = 'PLATFORM_FEATURE_ACCESS_UPDATED'`);
    const qa = await q<Record<string, unknown>>("C6qa",
      `SELECT b.id, (b.name = $2) AS "nameMatchesQaConstant", (b."deletionRequestedAt" IS NULL AND b."deletedAt" IS NULL) AS active,
              (SELECT count(*)::int FROM "BusinessFeatureAccess" f WHERE f."businessId" = b.id) AS overrides,
              (SELECT count(*)::int FROM "User" u WHERE u."businessId" = b.id) AS users
         FROM "Business" b WHERE b.id = $1`, QA_BUSINESS_ID, QA_BUSINESS_NAME);

    const auditColumns = await q<Record<string, unknown>>("C7",
      `SELECT column_name AS c, data_type AS type, is_nullable AS nullable, column_default IS NOT NULL AS "hasDefault"
         FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'PlatformAuditEvent' ORDER BY ordinal_position`);

    // C8 — column-scoped privileges (has_table_privilege cannot see them): which columns each role may
    // UPDATE on the overrides and SELECT on Business.
    const columnPrivileges: Record<string, Record<string, string[]>> = {};
    for (const r of ["app_ctlplane", "app_runtime", "app_runtime_prod"].filter((x) => existing.has(x))) {
      const cols = async (t: string, p: string) => (await q<{ c: string }>(`C8 ${r}.${t}.${p}`,
        `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $2
            AND has_column_privilege($1, 'public."' || $2 || '"', column_name, $3) ORDER BY ordinal_position`, r, t, p)).map((x) => x.c);
      columnPrivileges[r] = {
        "BusinessFeatureAccess UPDATE": await cols("BusinessFeatureAccess", "UPDATE"),
        "BusinessFeatureAccess INSERT": await cols("BusinessFeatureAccess", "INSERT"),
        "Business SELECT": await cols("Business", "SELECT"),
      };
    }

    // C9 — the most recently applied migrations, with their finish time (which run applied what).
    const recentMigrations = await q<Record<string, unknown>>("C9",
      `SELECT migration_name AS name, finished_at AS "finishedAt", (rolled_back_at IS NOT NULL) AS "rolledBack"
         FROM "_prisma_migrations" ORDER BY finished_at DESC NULLS FIRST LIMIT 4`);

    await verifyReadOnly(db, "owner");
    console.log(JSON.stringify({ migration, recentMigrations, roles, members, privilegeMatrix: matrix, columnPrivileges, publicGrants, rls, policies,
      triggers, defaultAcls, overrides, featureAudit: featureAudit[0] ?? null, qaSandbox: qa[0] ?? null, auditColumns, errors }, null, 1));
  } catch (e) {
    if (e instanceof RefusedError) { console.error(`REFUSED: ${e.message}`); process.exitCode = 3; }
    else { console.error(`FAILED: ${e instanceof Error ? e.name : "unknown"} ${(e as { code?: string })?.code ?? ""}`); process.exitCode = 1; }
  } finally {
    await db?.$disconnect();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/ops/control-plane-preflight-evidence.ts")) void main();
