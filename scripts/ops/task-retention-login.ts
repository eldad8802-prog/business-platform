/**
 * Daily Tasks — the Production LOGIN that runs operational retention. OWNER GATE: this WRITES roles.
 * Driven only by .github/workflows/prod-task-retention-login.yml (environment production-db, owner approval).
 *
 *   OWNER_DATABASE_URL=… TASK_RETENTION_DATABASE_URL=… node_modules/.bin/tsx scripts/ops/task-retention-login.ts \
 *     --action provision|disable --allow-host ep-flat-brook-am4bhq1y
 *
 * provision  create-once (or rotate the password of) `task_retention_login`: LOGIN, NOINHERIT, NOSUPERUSER,
 *            NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, NOREPLICATION, CONNECTION LIMIT 2, member of NO role.
 *            Its whole authority is EXECUTE on the two OPERATIONAL functions of migration
 *            20261018090000_daily_tasks_foundation (task_retention_purge_request_ledger,
 *            task_retention_clear_event_digests), granted to the login directly. It deliberately does NOT join
 *            `task_maintenance`: that group also holds EXECUTE on the three H3 functions, and this login must not
 *            hold it (owner requirement, 2026-10-20). No table, sequence or other definer function is reachable.
 *            The password is the one inside TASK_RETENTION_DATABASE_URL (the production-db secret task-retention.yml
 *            uses). Neon accepts ONLY a plaintext password (run 36947430910), so it is sent as the PASSWORD
 *            literal over TLS to the verified endpoint; it is restricted to [A-Za-z0-9_-] and redacted from every
 *            error. Preconditions, the write and the post-assertions are ONE transaction: any mismatch rolls the
 *            whole thing back.
 * disable    containment: NOLOGIN, revoke both EXECUTE grants, terminate its sessions. Immediate. The role is
 *            never dropped.
 *
 * Output: booleans and counts only. Exit: 0 PASS · 1 FAIL · 3 REFUSED · 2 usage.
 */
import { PrismaClient } from "@prisma/client";
import { assertSafeUrl, RefusedError } from "./runtime-rls-evidence";

const LOGIN = "task_retention_login";
const OPERATIONAL = ["task_retention_purge_request_ledger", "task_retention_clear_event_digests"];
const NOT_ALLOWED = ["task_retention_clear_source_identifiers", "task_retention_purge_learning_events",
  "task_retention_purge_source_state", "task_retention_days", "task_retention_erase_business"];
const MIGRATION = "20261018090000_daily_tasks_foundation";
const CONNECTION_LIMIT = 2;
const SYSTEM_SCHEMA = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'`;

/** Set once the password is parsed; every error path is scrubbed of it (and of any PASSWORD literal). */
let secretToRedact: string | null = null;
export function registerSecretForRedaction(secret: string): void { secretToRedact = secret; }
export function redact(message: string): string {
  let m = message.replace(/PASSWORD\s+'[^']*'/gi, "PASSWORD '<redacted>'");
  if (secretToRedact) m = m.split(secretToRedact).join("<redacted>");
  return m.replace(/postgres(ql)?:\/\/[^\s'"]+/gi, "<url>");
}

/**
 * The retention URL must name exactly this login, directly (no pooler), on the verified endpoint, with a strong
 * password, on the SAME host and database as the owner connection.
 */
export function parseRetentionUrl(raw: string | undefined, allowHost: string | null, ownerRaw?: string): { password: string } {
  const safe = assertSafeUrl("TASK_RETENTION_DATABASE_URL", raw, allowHost);
  const url = new URL(safe);
  if (decodeURIComponent(url.username) !== LOGIN) throw new RefusedError(`TASK_RETENTION_DATABASE_URL must authenticate as ${LOGIN}`);
  if (ownerRaw !== undefined) {
    const owner = new URL(assertSafeUrl("OWNER_DATABASE_URL", ownerRaw, allowHost));
    if (url.hostname.toLowerCase() !== owner.hostname.toLowerCase()) throw new RefusedError("TASK_RETENTION_DATABASE_URL host differs from the owner connection's host");
    const db = (u: URL) => decodeURIComponent(u.pathname.replace(/^\//, ""));
    if (!db(url) || db(url) !== db(owner)) throw new RefusedError("TASK_RETENTION_DATABASE_URL database differs from the owner connection's database");
  }
  const password = decodeURIComponent(url.password);
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(password)) {
    throw new RefusedError("the retention password must be 32-128 characters of [A-Za-z0-9_-] (URL-safe, no quoting)");
  }
  return { password };
}

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/** What the login can reach. Every count except `operationalExecutable` must be 0. */
async function reach(tx: Tx) {
  const [r] = await tx.$queryRawUnsafe<Record<string, number>[]>(
    `SELECT
       (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = ANY($2::text[]) AND has_function_privilege($1, p.oid, 'EXECUTE')) AS "operationalExecutable",
       (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = ANY($3::text[]) AND has_function_privilege($1, p.oid, 'EXECUTE')) AS "notAllowedExecutable",
       (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE ${SYSTEM_SCHEMA} AND p.prosecdef AND NOT (n.nspname = 'public' AND p.proname = ANY($2::text[]))
           AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
           AND has_function_privilege($1, p.oid, 'EXECUTE')) AS "otherDefinerExecutable",
       (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE ${SYSTEM_SCHEMA}
           AND CASE WHEN c.relkind IN ('r', 'p', 'v', 'm', 'f')
                    THEN has_table_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                         OR has_any_column_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
                    ELSE false END) AS "tablesReachable",
       (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE ${SYSTEM_SCHEMA}
           AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege($1, c.oid, 'USAGE, SELECT, UPDATE') ELSE false END) AS "sequencesReachable",
       (SELECT count(*)::int FROM pg_namespace n WHERE ${SYSTEM_SCHEMA} AND has_schema_privilege($1, n.oid, 'CREATE')) AS "schemasCreatable",
       (CASE WHEN has_database_privilege($1, current_database(), 'CREATE') THEN 1 ELSE 0 END) AS "databaseCreate"`,
    LOGIN, OPERATIONAL, NOT_ALLOWED);
  return r;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const action = arg("--action");
  const allowHost = arg("--allow-host") ?? null;
  if (action !== "provision" && action !== "disable") { console.error("usage: --action provision|disable --allow-host <host>"); process.exit(2); }
  let owner: PrismaClient | undefined;
  try {
    owner = new PrismaClient({ datasourceUrl: assertSafeUrl("OWNER_DATABASE_URL", process.env.OWNER_DATABASE_URL, allowHost) });

    if (action === "disable") {
      const out = await owner.$transaction(async (tx) => {
        const [r] = await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1`, LOGIN);
        if (!r || r.n === 0) return { existed: false };
        await tx.$executeRawUnsafe(`ALTER ROLE ${LOGIN} NOLOGIN`);
        for (const f of OPERATIONAL) await tx.$executeRawUnsafe(`REVOKE EXECUTE ON FUNCTION public.${f}() FROM ${LOGIN}`);
        const [s] = await tx.$queryRawUnsafe<{ login: boolean }[]>(`SELECT rolcanlogin AS login FROM pg_roles WHERE rolname = $1`, LOGIN);
        const after = await reach(tx);
        if (s.login || after.operationalExecutable !== 0) throw new Error("disable did not take");
        return { existed: true, login: s.login, operationalExecutable: after.operationalExecutable };
      });
      let terminated: number | string = 0;
      try {
        const t = await owner.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE usename = $1`, LOGIN);
        terminated = t.filter((x) => x.ok).length;
      } catch (e) { terminated = `not permitted (${(e as { code?: string }).code ?? "?"}) — NOLOGIN + revoked EXECUTE already deny new work`; }
      console.log(JSON.stringify({ action, ...out, sessionsTerminated: terminated, pass: true }, null, 1));
      return;
    }

    const { password } = parseRetentionUrl(process.env.TASK_RETENTION_DATABASE_URL, allowHost, process.env.OWNER_DATABASE_URL);
    // Re-asserted at the point of use: the PASSWORD literal below is only ever built from this charset.
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(password)) throw new RefusedError("password shape");
    registerSecretForRedaction(password);

    const result = await owner.$transaction(async (tx) => {
      // Preconditions: the migration is applied and the two functions are the owner's own definer functions.
      const [applied] = await tx.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`, MIGRATION);
      if (applied.n !== 1) throw new RefusedError(`migration ${MIGRATION} is not applied`);
      const [fns] = await tx.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = ANY($1::text[]) AND p.pronargs = 0 AND p.prosecdef
            AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)`, OPERATIONAL);
      if (fns.n !== OPERATIONAL.length) throw new RefusedError("the operational retention functions are missing or not the owner's definer functions");

      const [existing] = await tx.$queryRawUnsafe<{ elevated: boolean; groups: number }[]>(
        `SELECT (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication) AS elevated,
                (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS groups
           FROM pg_roles r WHERE rolname = $1`, LOGIN);
      if (existing && (existing.elevated || existing.groups > 0)) {
        throw new RefusedError(`${LOGIN} exists with an elevated attribute or a role membership — refusing to reuse it`);
      }
      const attrs = `LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT ${CONNECTION_LIMIT}`;
      // Rotation names only what a CREATEROLE (non-superuser) owner may change: PostgreSQL 16+ refuses an ALTER ROLE
      // that mentions SUPERUSER / REPLICATION / BYPASSRLS / CREATEDB at all without holding them. The precondition above
      // already refused an existing role holding any of them, and the post-assertions re-check every attribute.
      const rotateAttrs = `LOGIN NOINHERIT CONNECTION LIMIT ${CONNECTION_LIMIT}`;
      if (existing) await tx.$executeRawUnsafe(`ALTER ROLE ${LOGIN} ${rotateAttrs} PASSWORD '${password}'`);
      else await tx.$executeRawUnsafe(`CREATE ROLE ${LOGIN} ${attrs} PASSWORD '${password}'`);
      for (const f of OPERATIONAL) await tx.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION public.${f}() TO ${LOGIN}`);

      // Post-assertions, inside the same transaction.
      const [r] = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT r.rolcanlogin AS login, r.rolinherit AS inherit, r.rolsuper AS super, r.rolbypassrls AS bypassrls,
                r.rolcreatedb AS createdb, r.rolcreaterole AS createrole, r.rolreplication AS replication,
                r.rolconnlimit AS connlimit,
                (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS groups,
                (SELECT count(*)::int FROM pg_class c WHERE c.relowner = r.oid)
                  + (SELECT count(*)::int FROM pg_proc p WHERE p.proowner = r.oid) AS "ownedObjects"
           FROM pg_roles r WHERE r.rolname = $1`, LOGIN);
      const reachable = await reach(tx);
      const roleOk = r.login === true && r.inherit === false && r.super === false && r.bypassrls === false &&
        r.createdb === false && r.createrole === false && r.replication === false && r.connlimit === CONNECTION_LIMIT &&
        r.groups === 0 && r.ownedObjects === 0;
      const reachOk = reachable.operationalExecutable === OPERATIONAL.length && reachable.notAllowedExecutable === 0 &&
        reachable.otherDefinerExecutable === 0 && reachable.tablesReachable === 0 && reachable.sequencesReachable === 0 &&
        reachable.schemasCreatable === 0 && reachable.databaseCreate === 0;
      if (!roleOk || !reachOk) {
        throw new Error(`post-assertion failed: role=${roleOk} reach=${JSON.stringify(reachable)}`);
      }
      return { created: !existing, rotated: !!existing, role: r, reach: reachable };
    }, { timeout: 30_000 });

    console.log(JSON.stringify({ action, ...result, pass: true }, null, 1));
  } catch (e) {
    if (e instanceof RefusedError) { console.error(`REFUSED: ${redact(e.message)}`); process.exitCode = 3; }
    else { console.error(`FAILED: ${e instanceof Error ? redact(e.message) : "unknown"}`); process.exitCode = 1; }
  } finally {
    await owner?.$disconnect();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/ops/task-retention-login.ts")) void main();
