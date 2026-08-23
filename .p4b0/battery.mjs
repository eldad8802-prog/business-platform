/**
 * D2 / P4-B0 — Control-plane role least-privilege feasibility (PREVIEW ONLY).
 *
 * Resolves the P4-A finding: a SQL-created role is not pooler-served. Neon
 * control-plane roles ARE pooler-served but are auto-granted membership in
 * neon_superuser. This experiment proves whether such a role can be hardened
 * (REVOKE neon_superuser) and stay pooler-usable + least-privilege, with RLS
 * still enforced.
 *
 * Disposable role + schema: p4b0_runtime_lab. Role created + deleted via the
 * Neon API (control-plane). Owner/DIRECT connection is used only for SQL
 * inspection, the REVOKE, schema/table/policy/fixtures, and teardown. Nothing
 * touches public or app_runtime. No secret is printed.
 */
import { PrismaClient } from "@prisma/client";

const BASE = process.env.NEON_BASE;
const KEY = process.env.NEON_API_KEY;
const PID = process.env.P4_PROJECT_ID;
const BID = process.env.P4_BRANCH_ID;
const EID = process.env.P4_EXPECT_ENDPOINT;
const DB = process.env.P4_EXPECT_DB;
const SUFFIX = process.env.P4_EXPECT_HOST_SUFFIX;
const DENY = (process.env.P4_DENY_ENDPOINTS || "").split(/\s+/).filter(Boolean);
const ROLE = "p4b0_runtime_lab";
const LAB = "p4b0_runtime_lab";
const GUC = "app.current_business_id";
const BIZ_A = 1001, BIZ_B = 2002;

const R = {};
const notes = [];
const mark = (k, ok, note) => { R[k] = ok ? "PASS" : "FAIL"; if (note) notes.push("[" + k + "] " + note); };
const empty = (v) => v === null || v === "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Neon API (control plane). KEY/URIs never printed. ----
async function neon(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json", Accept: "application/json", ...(opts.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error("neon api " + (opts.method || "GET") + " " + path.split("?")[0] + " -> " + res.status + " " + text.slice(0, 200));
  return text ? JSON.parse(text) : {};
}
async function waitOps(ops) {
  const ids = (ops || []).map((o) => o.id).filter(Boolean);
  const deadline = Date.now() + 90000;
  for (const id of ids) {
    for (;;) {
      const o = await neon("/projects/" + PID + "/operations/" + id);
      const st = o.operation?.status;
      if (st === "finished") break;
      if (st === "failed" || st === "cancelled" || st === "error") throw new Error("operation " + id + " " + st);
      if (Date.now() > deadline) throw new Error("operation " + id + " timeout (" + st + ")");
      await sleep(1500);
    }
  }
}
function identityOk(uri) {
  const u = new URL(uri);
  if (!u.hostname.endsWith(SUFFIX)) return false;
  const first = u.hostname.split(".")[0];
  const ep = first.endsWith("-pooler") ? first.slice(0, -"-pooler".length) : first;
  if (DENY.includes(ep)) return false;
  return ep === EID && (u.pathname || "").replace(/^\//, "") === DB;
}
async function roleUri(pooled) {
  const j = await neon("/projects/" + PID + "/connection_uri?branch_id=" + BID + "&endpoint_id=" + EID +
    "&database_name=" + DB + "&role_name=" + ROLE + "&pooled=" + (pooled ? "true" : "false"));
  const uri = j.uri;
  if (!uri || !identityOk(uri)) throw new Error("role connection_uri failed identity check");
  return uri;
}
const withPgbouncer = (uri) => { const u = new URL(uri); u.searchParams.set("pgbouncer", "true"); return u.toString(); };

const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

async function attrs() {
  const a = await owner.$queryRawUnsafe(
    "SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin FROM pg_roles WHERE rolname = '" + ROLE + "'");
  const m = await owner.$queryRawUnsafe(
    "SELECT count(*)::int AS c FROM pg_auth_members me JOIN pg_roles g ON g.oid=me.roleid JOIN pg_roles r ON r.oid=me.member" +
    " WHERE r.rolname='" + ROLE + "' AND g.rolname='neon_superuser'");
  const all = await owner.$queryRawUnsafe(
    "SELECT count(*)::int AS c FROM pg_auth_members me JOIN pg_roles r ON r.oid=me.member WHERE r.rolname='" + ROLE + "'");
  const own = await owner.$queryRawUnsafe(
    "SELECT count(*)::int AS c FROM pg_tables WHERE tableowner='" + ROLE + "'");
  return { ...a[0], neon_super: Number(m[0].c), memberships: Number(all[0].c), owns: Number(own[0].c) };
}
async function pooledCurrentUser(pooled, usePgb) {
  let uri = await roleUri(pooled);
  if (usePgb) uri = withPgbouncer(uri);
  const c = new PrismaClient({ datasourceUrl: uri });
  try {
    const r = await c.$queryRaw`SELECT current_user::text AS u`;
    return { user: r[0].u, client: c };
  } catch (e) { try { await c.$disconnect(); } catch {} throw e; }
}

let roleCreated = false;
async function run() {
  // Preflight — no collision.
  const pre = await owner.$queryRawUnsafe(
    "SELECT (SELECT count(*)::int FROM pg_roles WHERE rolname='" + ROLE + "') AS role," +
    " (SELECT count(*)::int FROM information_schema.schemata WHERE schema_name='" + LAB + "') AS lab," +
    " (SELECT count(*)::int FROM information_schema.tables WHERE table_schema='public') AS pub");
  if (Number(pre[0].role) !== 0 || Number(pre[0].lab) !== 0) throw new Error("p4b0 role/schema collision");
  R._public_before = Number(pre[0].pub);
  const ownerRow = await owner.$queryRaw`SELECT current_user::text AS u`;
  R._owner = ownerRow[0].u;

  // 1. Create the role via the Neon API (control plane).
  const created = await neon("/projects/" + PID + "/branches/" + BID + "/roles", {
    method: "POST", body: JSON.stringify({ role: { name: ROLE } }),
  });
  await waitOps(created.operations);
  roleCreated = true;
  R.API_ROLE_CREATED = "YES";
  console.log("[api] role " + ROLE + " created via control plane");

  // 2. Initial attributes + neon_superuser membership.
  const a0 = await attrs();
  R.INITIAL_NEON_SUPER = a0.neon_super > 0 ? "YES" : "NO";
  notes.push("[initial-attrs] super=" + a0.rolsuper + " bypassrls=" + a0.rolbypassrls + " createrole=" + a0.rolcreaterole +
    " createdb=" + a0.rolcreatedb + " login=" + a0.rolcanlogin + " neon_superuser=" + a0.neon_super + " memberships=" + a0.memberships);

  // 3. Pooled direct-auth BEFORE hardening (no pgbouncer param first).
  try {
    const { user, client } = await pooledCurrentUser(true, false);
    await client.$disconnect();
    mark("POOLER_AUTH_PRE", user === ROLE, "current_user=" + user);
  } catch (e) { mark("POOLER_AUTH_PRE", false, "pre-hardening pooled auth threw: " + String(e.message).slice(0, 160)); }

  // 4. Hardening — REVOKE neon_superuser (only if member), then tighten attrs on the disposable role.
  if (a0.neon_super > 0) {
    try {
      await owner.$executeRawUnsafe("REVOKE neon_superuser FROM " + ROLE);
      R.NEON_SUPER_REVOKE = "PASS";
    } catch (e) { R.NEON_SUPER_REVOKE = "FAIL"; notes.push("[revoke] " + String(e.message).slice(0, 200)); }
  } else {
    R.NEON_SUPER_REVOKE = "N/A";
  }
  // Tighten any elevated attributes on the disposable role (documented).
  const before = await attrs();
  const alters = [];
  if (before.rolsuper) alters.push("NOSUPERUSER");
  if (before.rolbypassrls) alters.push("NOBYPASSRLS");
  if (before.rolcreaterole) alters.push("NOCREATEROLE");
  if (before.rolcreatedb) alters.push("NOCREATEDB");
  if (alters.length) {
    try { await owner.$executeRawUnsafe("ALTER ROLE " + ROLE + " " + alters.join(" ")); notes.push("[alter] applied " + alters.join(",")); }
    catch (e) { notes.push("[alter] failed (" + alters.join(",") + "): " + String(e.message).slice(0, 160)); }
  }

  // 5. Verify security posture after hardening.
  const a1 = await attrs();
  mark("POST_NOSUPERUSER", a1.rolsuper === false, "rolsuper=" + a1.rolsuper);
  mark("POST_NOBYPASSRLS", a1.rolbypassrls === false, "rolbypassrls=" + a1.rolbypassrls);
  R.POST_NEON_SUPER = a1.neon_super === 0 ? "ABSENT" : "PRESENT";
  notes.push("[post-attrs] super=" + a1.rolsuper + " bypassrls=" + a1.rolbypassrls + " createrole=" + a1.rolcreaterole +
    " createdb=" + a1.rolcreatedb + " neon_superuser=" + a1.neon_super + " owns=" + a1.owns);
  const postureOk = a1.rolsuper === false && a1.rolbypassrls === false && a1.rolcreaterole === false &&
    a1.rolcreatedb === false && a1.neon_super === 0 && a1.owns === 0;
  if (!postureOk) { mark("POST_HARDENING_POSTURE", false, "posture not least-privilege"); throw new Error("post-hardening posture failed — STOP"); }

  // 6. CRITICAL — pooled direct-auth AFTER hardening.
  let pooledClient = null, usedPgb = false;
  try {
    let r = null;
    try { r = await pooledCurrentUser(true, false); }
    catch (e1) {
      notes.push("[pooler-post] plain pooled failed: " + String(e1.message).slice(0, 140) + " — retrying with pgbouncer=true");
      r = await pooledCurrentUser(true, true); usedPgb = true;
    }
    pooledClient = r.client;
    mark("POOLER_AUTH_POST", r.user === ROLE, "current_user=" + r.user + (usedPgb ? " (pgbouncer=true)" : " (plain)"));
  } catch (e) { mark("POOLER_AUTH_POST", false, "post-hardening pooled auth threw: " + String(e.message).slice(0, 160)); }
  R.PGBOUNCER_REQUIRED = R.POOLER_AUTH_POST === "PASS" ? (usedPgb ? "YES" : "NO") : "UNKNOWN";

  // 7. Minimal RLS sanity via the pooled role — only if post-hardening auth PASS.
  if (R.POOLER_AUTH_POST === "PASS" && pooledClient) {
    try {
      await owner.$executeRawUnsafe("CREATE SCHEMA " + LAB);
      await owner.$executeRawUnsafe("CREATE TABLE " + LAB + ".p4b0_probe (p4_id bigserial PRIMARY KEY, p4_business_id integer NOT NULL, p4_label text NOT NULL)");
      const guc = "NULLIF(current_setting('" + GUC + "', true), '')::int";
      await owner.$executeRawUnsafe("ALTER TABLE " + LAB + ".p4b0_probe ENABLE ROW LEVEL SECURITY");
      await owner.$executeRawUnsafe("ALTER TABLE " + LAB + ".p4b0_probe FORCE ROW LEVEL SECURITY");
      await owner.$executeRawUnsafe("CREATE POLICY p4b0_tenant ON " + LAB + ".p4b0_probe USING (p4_business_id = " + guc + ") WITH CHECK (p4_business_id = " + guc + ")");
      await owner.$executeRawUnsafe("GRANT USAGE ON SCHEMA " + LAB + " TO " + ROLE);
      await owner.$executeRawUnsafe("GRANT SELECT, INSERT, UPDATE, DELETE ON " + LAB + ".p4b0_probe TO " + ROLE);
      await owner.$executeRawUnsafe("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA " + LAB + " TO " + ROLE);
      await owner.$executeRawUnsafe("INSERT INTO " + LAB + ".p4b0_probe (p4_business_id, p4_label) VALUES (" + BIZ_A + ", 'A'), (" + BIZ_B + ", 'B')");

      const tx = (biz, fn) => pooledClient.$transaction(async (t) => {
        if (biz !== null) await t.$queryRaw`SELECT set_config(${GUC}, ${String(biz)}, true)`;
        return fn(t);
      }, { maxWait: 15000, timeout: 20000 });
      const cnt = (rows) => Number(rows[0].c);

      const own = await tx(BIZ_A, async (t) => cnt(await t.$queryRawUnsafe("SELECT count(*)::int AS c FROM " + LAB + ".p4b0_probe")));
      const crossB = await tx(BIZ_A, async (t) => cnt(await t.$queryRawUnsafe("SELECT count(*)::int AS c FROM " + LAB + ".p4b0_probe WHERE p4_business_id=" + BIZ_B)));
      const noCtx = await tx(null, async (t) => cnt(await t.$queryRawUnsafe("SELECT count(*)::int AS c FROM " + LAB + ".p4b0_probe")));
      let checkRej = false;
      try { await tx(BIZ_A, async (t) => t.$executeRawUnsafe("INSERT INTO " + LAB + ".p4b0_probe (p4_business_id, p4_label) VALUES (" + BIZ_B + ", 'forge')")); }
      catch { checkRej = true; }
      mark("POOLED_RLS_SANITY", own === 1 && crossB === 0 && noCtx === 0 && checkRej,
        "own=" + own + " crossB=" + crossB + " noCtx=" + noCtx + " with_check_rejected=" + checkRej);
    } catch (e) { mark("POOLED_RLS_SANITY", false, "rls sanity threw: " + String(e.message).slice(0, 180)); }
    try { await pooledClient.$disconnect(); } catch {}
  } else {
    R.POOLED_RLS_SANITY = "NOT RUN";
  }
}

async function teardown() {
  try { await owner.$executeRawUnsafe("DROP SCHEMA IF EXISTS " + LAB + " CASCADE"); } catch (e) { notes.push("[teardown-schema] " + String(e.message).slice(0, 140)); }
  // Delete the control-plane role via the API; fall back to SQL DROP ROLE.
  if (roleCreated) {
    try {
      const del = await neon("/projects/" + PID + "/branches/" + BID + "/roles/" + ROLE, { method: "DELETE" });
      await waitOps(del.operations);
    } catch (e) {
      notes.push("[teardown-api-delete] " + String(e.message).slice(0, 140) + " — trying SQL DROP ROLE");
      try { await owner.$executeRawUnsafe("DROP OWNED BY " + ROLE); } catch {}
      try { await owner.$executeRawUnsafe("DROP ROLE IF EXISTS " + ROLE); } catch (e2) { notes.push("[teardown-sql-drop] " + String(e2.message).slice(0, 140)); }
    }
  }
  try {
    const res = await owner.$queryRawUnsafe(
      "SELECT (SELECT count(*)::int FROM pg_roles WHERE rolname='" + ROLE + "') AS role," +
      " (SELECT count(*)::int FROM information_schema.schemata WHERE schema_name='" + LAB + "') AS lab," +
      " (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname LIKE 'p4b0\\_%') AS rel," +
      " (SELECT count(*)::int FROM information_schema.tables WHERE table_schema='public') AS pub");
    const r = res[0];
    R.RESIDUE = (Number(r.role) === 0 && Number(r.lab) === 0 && Number(r.rel) === 0) ? "0" : "FAILURE";
    R._public_after = Number(r.pub);
    console.log("[teardown] role=" + r.role + " lab=" + r.lab + " rel=" + r.rel + " public=" + r.pub + " (before " + R._public_before + ")");
  } catch (e) { R.RESIDUE = "FAILURE"; notes.push("[teardown-verify] " + String(e.message).slice(0, 160)); }
}

let fatal = null;
try { await run(); } catch (e) { fatal = e; notes.push("[fatal] " + String(e && e.message ? e.message : e).slice(0, 300)); }
await teardown();
try { await owner.$disconnect(); } catch {}

const gates = ["POOLER_AUTH_PRE", "POST_NOSUPERUSER", "POST_NOBYPASSRLS", "POOLER_AUTH_POST", "POOLED_RLS_SANITY"];
const passOrNA = (v) => v === "PASS" || v === "N/A";
const verdict = R.API_ROLE_CREATED === "YES" && R.POOLER_AUTH_PRE === "PASS" && R.POST_NOSUPERUSER === "PASS" &&
  R.POST_NOBYPASSRLS === "PASS" && R.POST_NEON_SUPER === "ABSENT" && R.POOLER_AUTH_POST === "PASS" &&
  R.POOLED_RLS_SANITY === "PASS" && R.RESIDUE === "0" && !fatal;
R.P4B0 = verdict ? "PASS" : "FAIL";
const ready = verdict ? "YES" : "NO";

const L = (k, v) => k.padEnd(36) + "= " + v;
const report = [
  L("API ROLE CREATED", R.API_ROLE_CREATED || "NO"),
  L("INITIAL NEON_SUPERUSER MEMBERSHIP", R.INITIAL_NEON_SUPER || "NO"),
  L("POOLER AUTH PRE-HARDENING", R.POOLER_AUTH_PRE || "FAIL"),
  L("NEON_SUPERUSER REVOKE", R.NEON_SUPER_REVOKE || "N/A"),
  L("POST-HARDENING NOSUPERUSER", R.POST_NOSUPERUSER || "FAIL"),
  L("POST-HARDENING NOBYPASSRLS", R.POST_NOBYPASSRLS || "FAIL"),
  L("POST-HARDENING NEON_SUPERUSER", R.POST_NEON_SUPER || "PRESENT"),
  L("POOLER AUTH POST-HARDENING", R.POOLER_AUTH_POST || "FAIL"),
  L("POOLED RLS SANITY", R.POOLED_RLS_SANITY || "NOT RUN"),
  L("PGBOUNCER=true REQUIRED", R.PGBOUNCER_REQUIRED || "UNKNOWN"),
  L("PUBLIC TOUCHED", "NO (public_tables " + R._public_before + "->" + (R._public_after ?? "?") + ")"),
  L("app_runtime TOUCHED", "NO"),
  L("PRODUCTION TOUCHED", "NO"),
  L("P4-B0 RESIDUE", R.RESIDUE || "FAILURE"),
  L("P4-B0", R.P4B0),
  L("READY FOR P4-B WIRING", ready),
];
console.log("\n" + report.join("\n") + "\n--- notes ---\n" + notes.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) {
  const fs = await import("node:fs");
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "## D2 / P4-B0 — control-plane role feasibility\n\n```\n" + report.join("\n") + "\n```\n");
}
if (fatal || R.P4B0 !== "PASS") process.exit(1);
