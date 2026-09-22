/**
 * AD-2A — what the laboratory database actually holds, measured two ways.
 *
 * 1. BEFORE the contract: is this a fresh lab? The harness (`fresh-lab.mjs`) creates
 *    a new database and a new runtime role for every proof. This module does NOT
 *    trust that it did: it measures, and it never repairs. A dirty precondition is a
 *    failure, because a battery that tidies up and carries on can no longer say
 *    whether what it then proves came from the contract or from the leftovers.
 *
 * 2. AFTER the contract: does the live state EQUAL what was declared? Not "contains"
 *    — equals. Missing state and extra state are both failures, across every table in
 *    the schema, for RLS, FORCE, policy membership, command, roles, USING, WITH CHECK
 *    and the runtime role's table and sequence privileges.
 */
import {
  PRODUCTION_RLS_CONTRACT,
  EXPECTED_RUNTIME_TABLE_PRIVILEGES,
  EXPECTED_RUNTIME_SEQUENCE_PRIVILEGES,
} from "./production-contract.mjs";
import { deparseAll } from "./pg-deparse.mjs";

const TABLE_PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
const POLCMD = { r: "SELECT", a: "INSERT", w: "UPDATE", d: "DELETE", "*": "ALL" };

/** The fresh-lab identity the harness handed over. Missing = not run through the harness. */
export function freshLabIdentity(env = process.env) {
  const nonce = env.AD2A_FRESH_NONCE;
  const role = env.AD2A_RT_ROLE;
  const pw = env.AD2A_RT_PW;
  const db = env.AD2A_FRESH_DB;
  if (!nonce || !role || !pw || !db) return null;
  return { nonce, role, pw, db };
}

/**
 * Measure the precondition. Returns [{ name, ok, detail }] — the caller reports and
 * decides; nothing here changes the database.
 */
export async function measureCleanPrecondition(owner, id) {
  const q = (sql, ...a) => owner.$queryRawUnsafe(sql, ...a);
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

  const [{ db }] = await q(`SELECT current_database()::text AS db`);
  add("connected to the database the harness created for THIS proof", db === id.db, `db=${db} expected=${id.db}`);

  const [{ c }] = await q(
    `SELECT COALESCE(shobj_description(oid, 'pg_database'), '') AS c FROM pg_database WHERE datname = current_database()`
  );
  add("the database carries this proof's freshness nonce", c === `ad2a-fresh:${id.nonce}`, `comment=${c}`);

  const rls = await q(
    `SELECT c.relname::text AS t, c.relrowsecurity AS r, c.relforcerowsecurity AS f
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND (c.relrowsecurity OR c.relforcerowsecurity)`
  );
  add("no table has row-level security enabled or forced", rls.length === 0, rls.map((r) => r.t).join(","));

  const [{ n: pol }] = await q(
    `SELECT count(*)::int AS n FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = 'public'`
  );
  add("no policy exists", pol === 0, `policies=${pol}`);

  const [{ n: privs }] = await q(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace,
            LATERAL aclexplode(c.relacl) a
      WHERE ns.nspname = 'public' AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1)`,
    id.role
  );
  const [{ u }] = await q(`SELECT has_schema_privilege($1, 'public', 'USAGE') AS u`, id.role);
  add("the runtime role holds no privilege on any table or sequence", privs === 0, `grants=${privs}`);

  const [role] = await q(
    `SELECT rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = $1`,
    id.role
  );
  add(
    "the runtime role is this proof's own: LOGIN, not superuser, not BYPASSRLS",
    role && role.rolcanlogin && !role.rolsuper && !role.rolbypassrls && !role.rolcreaterole && !role.rolcreatedb,
    JSON.stringify(role ?? null)
  );
  // Schema USAGE comes from PUBLIC on a fresh database, so it is not a residue signal.
  void u;

  const [{ b, us }] = await q(
    `SELECT (SELECT count(*)::int FROM "Business") AS b, (SELECT count(*)::int FROM "User") AS us`
  );
  add("no proof data from any earlier run", b === 0 && us === 0, `business=${b} user=${us}`);

  const [{ fk }] = await q(
    `SELECT count(*)::int AS fk FROM pg_constraint WHERE conname = 'Message_conversationId_businessId_fkey'`
  );
  add("the AD-2A.3 composite FK is present (no mutation left behind)", fk === 1, `n=${fk}`);

  return checks;
}

/** Everything the lab holds that the exact-set compares, read from the catalog. */
export async function readLiveState(owner, rtRole) {
  const q = (sql, ...a) => owner.$queryRawUnsafe(sql, ...a);
  const rel = await q(
    `SELECT c.relname::text AS t, c.relrowsecurity AS r, c.relforcerowsecurity AS f
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')`
  );
  const pol = await q(
    `SELECT c.relname::text AS t, p.polname::text AS name, p.polcmd::text AS cmd, p.polpermissive AS perm,
            COALESCE((SELECT array_agg(CASE WHEN r = 0 THEN 'public' ELSE pg_get_userbyid(r)::text END ORDER BY 1)
                        FROM unnest(p.polroles) r), ARRAY[]::text[]) AS roles,
            pg_get_expr(p.polqual, p.polrelid) AS using, pg_get_expr(p.polwithcheck, p.polrelid) AS chk
       FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public'`
  );
  const acl = await q(
    `SELECT c.relname::text AS t, c.relkind::text AS k, a.privilege_type::text AS p
       FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace, LATERAL aclexplode(c.relacl) a
      WHERE ns.nspname = 'public' AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1)`,
    rtRole
  );
  const seqs = await q(
    `SELECT c.relname::text AS t FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public' AND c.relkind = 'S'`
  );
  return {
    rls: new Set(rel.filter((r) => r.r).map((r) => r.t)),
    force: new Set(rel.filter((r) => r.f).map((r) => r.t)),
    policies: pol.map((p) => ({
      table: p.t,
      name: p.name,
      command: POLCMD[p.cmd] ?? p.cmd,
      permissive: p.perm,
      roles: [...p.roles].sort(),
      using: p.using,
      check: p.chk,
    })),
    tablePrivs: acl.filter((a) => a.k === "r" || a.k === "p").map((a) => `${a.t}:${a.p}`),
    seqPrivs: acl.filter((a) => a.k === "S").map((a) => `${a.t}:${a.p}`),
    sequences: seqs.map((s) => s.t),
  };
}

/** What the lab SHOULD hold, from the declared contract alone (predicates normalised by PostgreSQL). */
export async function expectedState(owner, sequences) {
  const policies = [];
  const items = [];
  for (const spec of PRODUCTION_RLS_CONTRACT) {
    for (const p of spec.policies) {
      policies.push({
        table: spec.table,
        name: p.name,
        command: p.command,
        permissive: true,
        roles: [...(p.roles ?? ["public"])].sort(),
      });
      items.push({ table: spec.table, expr: p.using ?? null }, { table: spec.table, expr: p.check ?? null });
    }
  }
  const dep = await deparseAll(owner, items);
  policies.forEach((p, i) => {
    p.using = dep[2 * i];
    p.check = dep[2 * i + 1];
  });
  const tablePrivs = [];
  for (const [t, e] of Object.entries(EXPECTED_RUNTIME_TABLE_PRIVILEGES)) for (const v of e.verbs) tablePrivs.push(`${t}:${v}`);
  const seqPrivs = [];
  for (const s of sequences) for (const v of EXPECTED_RUNTIME_SEQUENCE_PRIVILEGES) seqPrivs.push(`${s}:${v}`);
  const tables = PRODUCTION_RLS_CONTRACT.map((s) => s.table);
  return { rls: new Set(tables), force: new Set(tables), policies, tablePrivs, seqPrivs };
}

const setDiff = (live, want) => {
  const L = new Set(live);
  const W = new Set(want);
  return { missing: [...W].filter((x) => !L.has(x)).sort(), extra: [...L].filter((x) => !W.has(x)).sort() };
};
const polKey = (p) => `${p.table}.${p.name}`;

/**
 * LIVE = EXPECTED, one dimension at a time. Returns [{ dimension, missing, extra }].
 * A dimension passes only when both lists are empty.
 */
export function diffExactSet(live, want) {
  const out = [];
  out.push({ dimension: "RLS ENABLED", ...setDiff(live.rls, want.rls) });
  out.push({ dimension: "RLS FORCE", ...setDiff(live.force, want.force) });
  out.push({ dimension: "POLICY MEMBERSHIP", ...setDiff(live.policies.map(polKey), want.policies.map(polKey)) });
  const wantBy = new Map(want.policies.map((p) => [polKey(p), p]));
  const attr = (name, f) => {
    const mismatched = [];
    for (const p of live.policies) {
      const w = wantBy.get(polKey(p));
      if (!w) continue; // membership already reports it
      const a = f(p);
      const b = f(w);
      if (JSON.stringify(a) !== JSON.stringify(b)) mismatched.push(`${polKey(p)}: live=${JSON.stringify(a)} expected=${JSON.stringify(b)}`);
    }
    out.push({ dimension: name, missing: [], extra: mismatched });
  };
  attr("POLICY COMMAND", (p) => p.command);
  attr("POLICY PERMISSIVE", (p) => p.permissive);
  attr("POLICY ROLES", (p) => p.roles);
  attr("POLICY USING", (p) => p.using);
  attr("POLICY WITH CHECK", (p) => p.check);
  out.push({ dimension: "RUNTIME TABLE PRIVILEGES", ...setDiff(live.tablePrivs, want.tablePrivs) });
  out.push({ dimension: "RUNTIME SEQUENCE PRIVILEGES", ...setDiff(live.seqPrivs, want.seqPrivs) });
  // A contract predicate PostgreSQL could not parse is its own failure.
  const broken = want.policies.filter((p) => (p.using && p.using.error) || (p.check && p.check.error));
  out.push({ dimension: "CONTRACT PREDICATES PARSE", missing: [], extra: broken.map((p) => `${polKey(p)}: ${JSON.stringify(p.using?.error ?? p.check?.error)}`) });
  return out;
}

export { TABLE_PRIVS };
