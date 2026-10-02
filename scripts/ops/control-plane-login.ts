/**
 * Control plane — the Production LOGIN role that joins `app_ctlplane`. OWNER GATE: this WRITES roles.
 * Driven only by .github/workflows/prod-control-plane-login.yml (environment production-db, owner approval).
 *
 *   OWNER_DATABASE_URL=… CONTROL_PLANE_DATABASE_URL=… node_modules/.bin/tsx scripts/ops/control-plane-login.ts \
 *     --action provision|disable --allow-host ep-flat-brook-am4bhq1y
 *
 * provision  create-once (or rotate the password of) `app_ctlplane_prod`: LOGIN, INHERIT, NOSUPERUSER,
 *            NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, NOREPLICATION, CONNECTION LIMIT 5, member of
 *            `app_ctlplane` and of nothing else. The password is the one inside CONTROL_PLANE_DATABASE_URL
 *            (the same value the owner stores in Vercel). Neon manages roles through its own control plane and
 *            accepts ONLY a plaintext password (it refuses a pre-hashed SCRAM verifier: run 36947430910), so the
 *            password is sent as the PASSWORD literal over the TLS session to the verified endpoint and Neon
 *            stores it hashed. It is restricted to [A-Za-z0-9_-] (no quoting, no injection) and redacted from every
 *            error message; it never appears in any log. Preconditions, the write and the
 *            post-assertions are ONE transaction: any mismatch rolls the whole thing back.
 * disable    containment: NOLOGIN, revoke the `app_ctlplane` membership, terminate its sessions. Takes
 *            effect immediately, without a deploy. The role is never dropped (the Neon pooler caches role
 *            OIDs; a recreated name would not be the same role).
 *
 * Output: booleans and codes only. Exit: 0 PASS · 1 FAIL · 3 REFUSED · 2 usage.
 */
import { PrismaClient } from "@prisma/client";
import { assertSafeUrl, RefusedError } from "./runtime-rls-evidence";

const LOGIN = "app_ctlplane_prod";
const GROUP = "app_ctlplane";
const MIGRATIONS = ["20260901090000_d2_pw2_business_feature_access_rls", "20261003090000_control_plane_production_privileges"];
const CONNECTION_LIMIT = 5;

/** Set once the password is parsed; every error path is scrubbed of it (and of any PASSWORD literal). */
let secretToRedact: string | null = null;
export function redact(message: string): string {
  let m = message.replace(/PASSWORD\s+'[^']*'/gi, "PASSWORD '<redacted>'");
  if (secretToRedact) m = m.split(secretToRedact).join("<redacted>");
  return m.replace(/postgres(ql)?:\/\/[^\s'"]+/gi, "<url>");
}

/**
 * The control-plane URL must name exactly this login, directly (no pooler), on the verified endpoint, with a
 * strong password — and point at the SAME host and database as the owner connection, so the credential can
 * only ever be set for, and used against, the authoritative Production database.
 */
export function parseControlPlaneUrl(raw: string | undefined, allowHost: string | null, ownerRaw?: string): { password: string } {
  const safe = assertSafeUrl("CONTROL_PLANE_DATABASE_URL", raw, allowHost); // refuses pooled / foreign hosts
  const url = new URL(safe);
  if (decodeURIComponent(url.username) !== LOGIN) throw new RefusedError(`CONTROL_PLANE_DATABASE_URL must authenticate as ${LOGIN}`);
  if (ownerRaw !== undefined) {
    const owner = new URL(assertSafeUrl("OWNER_DATABASE_URL", ownerRaw, allowHost));
    if (url.hostname.toLowerCase() !== owner.hostname.toLowerCase()) throw new RefusedError("CONTROL_PLANE_DATABASE_URL host differs from the owner connection's host");
    const db = (u: URL) => decodeURIComponent(u.pathname.replace(/^\//, ""));
    if (!db(url) || db(url) !== db(owner)) throw new RefusedError("CONTROL_PLANE_DATABASE_URL database differs from the owner connection's database");
  }
  const password = decodeURIComponent(url.password);
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(password)) {
    throw new RefusedError("the control-plane password must be 32-128 characters of [A-Za-z0-9_-] (URL-safe, no quoting)");
  }
  return { password };
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
        await tx.$executeRawUnsafe(`REVOKE ${GROUP} FROM ${LOGIN}`);
        const [s] = await tx.$queryRawUnsafe<{ login: boolean; member: boolean }[]>(
          `SELECT r.rolcanlogin AS login, pg_has_role(r.oid, '${GROUP}', 'MEMBER') AS member FROM pg_roles r WHERE r.rolname = $1`, LOGIN);
        if (s.login || s.member) throw new Error("disable did not take");
        return { existed: true, login: s.login, memberOfControlPlane: s.member };
      });
      let terminated: number | string = 0;
      try {
        const t = await owner.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE usename = $1`, LOGIN);
        terminated = t.filter((x) => x.ok).length;
      } catch (e) { terminated = `not permitted (${(e as { code?: string }).code ?? "?"}) — NOLOGIN + revoked membership already deny new work`; }
      console.log(JSON.stringify({ action, ...out, sessionsTerminated: terminated, pass: true }, null, 1));
      return;
    }

    const { password } = parseControlPlaneUrl(process.env.CONTROL_PLANE_DATABASE_URL, allowHost, process.env.OWNER_DATABASE_URL);
    // Re-asserted at the point of use: the PASSWORD literal below is only ever built from this charset.
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(password)) throw new RefusedError("password shape");
    secretToRedact = password;

    const result = await owner.$transaction(async (tx) => {
      // Preconditions.
      const applied = await tx.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE migration_name = ANY($1::text[]) AND finished_at IS NOT NULL AND rolled_back_at IS NULL`, MIGRATIONS);
      if (applied[0].n !== MIGRATIONS.length) throw new RefusedError("the control-plane migrations are not both applied");
      const [g] = await tx.$queryRawUnsafe<{ login: boolean; bypass: boolean; sup: boolean }[]>(
        `SELECT rolcanlogin AS login, rolbypassrls AS bypass, rolsuper AS sup FROM pg_roles WHERE rolname = $1`, GROUP);
      if (!g || g.login || g.bypass || g.sup) throw new RefusedError(`${GROUP} is missing or not a NOLOGIN, NOBYPASSRLS, NOSUPERUSER group`);

      const [existing] = await tx.$queryRawUnsafe<{ sup: boolean; bypass: boolean; createrole: boolean; createdb: boolean; repl: boolean }[]>(
        `SELECT rolsuper AS sup, rolbypassrls AS bypass, rolcreaterole AS createrole, rolcreatedb AS createdb, rolreplication AS repl FROM pg_roles WHERE rolname = $1`, LOGIN);
      const attrs = `LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT ${CONNECTION_LIMIT}`;
      if (existing) {
        if (existing.sup || existing.bypass || existing.createrole || existing.createdb || existing.repl) {
          throw new RefusedError(`${LOGIN} exists with an elevated attribute — refusing to reuse it`);
        }
        await tx.$executeRawUnsafe(`ALTER ROLE ${LOGIN} ${attrs} PASSWORD '${password}'`);
      } else {
        await tx.$executeRawUnsafe(`CREATE ROLE ${LOGIN} ${attrs} PASSWORD '${password}'`);
      }
      await tx.$executeRawUnsafe(`GRANT ${GROUP} TO ${LOGIN}`);

      // Post-assertions, inside the same transaction.
      const [r] = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT r.rolcanlogin AS login, r.rolinherit AS inherit, r.rolsuper AS super, r.rolbypassrls AS bypassrls, r.rolcreatedb AS createdb,
                r.rolcreaterole AS createrole, r.rolreplication AS replication, r.rolconnlimit AS connlimit,
                pg_has_role(r.oid, '${GROUP}', 'MEMBER') AS "memberOfControlPlane",
                (SELECT array_agg(g.rolname::text ORDER BY g.rolname) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid) AS groups,
                (SELECT count(*)::int FROM pg_class c WHERE c.relowner = r.oid) AS "ownedRelations"
           FROM pg_roles r WHERE r.rolname = $1`, LOGIN);
      const priv = async (t: string, p: string) =>
        (await tx.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT has_table_privilege($1, $2, $3) AS ok`, LOGIN, `public."${t}"`, p))[0].ok;
      const col = async (t: string, c: string, p: string) =>
        (await tx.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT has_column_privilege($1, $2, $3, $4) AS ok`, LOGIN, `public."${t}"`, c, p))[0].ok;
      const expect: [string, boolean][] = [
        ["BFA SELECT", await priv("BusinessFeatureAccess", "SELECT")],
        ["BFA INSERT", await priv("BusinessFeatureAccess", "INSERT")],
        ["BFA UPDATE state", await col("BusinessFeatureAccess", "state", "UPDATE")],
        ["audit INSERT", await priv("PlatformAuditEvent", "INSERT")],
        ["Business SELECT name", await col("Business", "name", "SELECT")],
        ["policy SELECT", await priv("PlatformFeaturePolicy", "SELECT")],
      ];
      const forbid: [string, boolean][] = [
        ["BFA DELETE", await priv("BusinessFeatureAccess", "DELETE")],
        ["BFA TRUNCATE", await priv("BusinessFeatureAccess", "TRUNCATE")],
        ["BFA UPDATE businessId", await col("BusinessFeatureAccess", "businessId", "UPDATE")],
        ["BFA UPDATE featureKey", await col("BusinessFeatureAccess", "featureKey", "UPDATE")],
        ["audit SELECT", await priv("PlatformAuditEvent", "SELECT")],
        ["audit UPDATE", await priv("PlatformAuditEvent", "UPDATE")],
        ["audit DELETE", await priv("PlatformAuditEvent", "DELETE")],
        ["Business UPDATE", await priv("Business", "UPDATE")],
        ["Business SELECT deletedAt", await col("Business", "deletedAt", "SELECT")],
        ["policy UPDATE", await priv("PlatformFeaturePolicy", "UPDATE")],
        ["definition INSERT", await priv("PlatformFeatureDefinition", "INSERT")],
        ["User SELECT", await priv("User", "SELECT")],
        ["migrations SELECT", await priv("_prisma_migrations", "SELECT")],
      ];
      const [schema] = await tx.$queryRawUnsafe<{ c: boolean }[]>(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS c`, LOGIN);
      const missing = expect.filter(([, ok]) => !ok).map(([k]) => k);
      const leaked = forbid.filter(([, ok]) => ok).map(([k]) => k);
      const groups = (r.groups as string[] | null) ?? [];
      const roleOk = r.login === true && r.inherit === true && r.super === false && r.bypassrls === false && r.createdb === false &&
        r.createrole === false && r.replication === false && r.connlimit === CONNECTION_LIMIT && r.memberOfControlPlane === true &&
        groups.length === 1 && groups[0] === GROUP && r.ownedRelations === 0 && schema.c === false;
      if (!roleOk || missing.length || leaked.length) {
        throw new Error(`post-assertion failed: role=${roleOk} missing=[${missing.join(",")}] leaked=[${leaked.join(",")}]`);
      }
      return { created: !existing, rotated: !!existing, role: { ...r, groups }, required: missing.length === 0, forbiddenHeld: leaked, schemaCreate: schema.c };
    }, { timeout: 30_000 });

    console.log(JSON.stringify({ action, ...result, pass: true }, null, 1));
  } catch (e) {
    if (e instanceof RefusedError) { console.error(`REFUSED: ${redact(e.message)}`); process.exitCode = 3; }
    else { console.error(`FAILED: ${e instanceof Error ? redact(e.message) : "unknown"}`); process.exitCode = 1; }
  } finally {
    await owner?.$disconnect();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/ops/control-plane-login.ts")) void main();
