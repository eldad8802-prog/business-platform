/**
 * D2 / P4-B-POOLCHECK — SQL-created NOBYPASSRLS role via the Neon pooler.
 *
 * Decides ONE question firsthand: can a SQL-created LOGIN + NOBYPASSRLS +
 * least-privilege role connect reliably through the Neon POOLED endpoint after a
 * reasonable provisioning-propagation window? Neon's RLS-on-branches guide
 * documents this pattern; P4-A saw "invalid role OID" when creating-and-using in
 * the same instant. This probes the propagation timeline.
 *
 * Owner/DIRECT connection provisions + tears down only. The role is created via
 * SQL (never the Neon API). Everything under p4_poolcheck_lab.p4_*. No public
 * mutation, no app_runtime, no control-plane conversion. No secret printed.
 */
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const EXPECT_ENDPOINT = process.env.P4_EXPECT_ENDPOINT;
const EXPECT_DB = process.env.P4_EXPECT_DB;
const SUFFIX = process.env.P4_EXPECT_HOST_SUFFIX;
const DENY = (process.env.P4_DENY_ENDPOINTS || "").split(/\s+/).filter(Boolean);
const ROLE = "p4_poolcheck_runtime";
const LAB = "p4_poolcheck_lab";
const GUC = "app.current_business_id";
const BIZ_A = 1001, BIZ_B = 2002;

const R = {};
const notes = [];
const mark = (k, ok, note) => { R[k] = ok ? "PASS" : "FAIL"; if (note) notes.push("[" + k + "] " + note); };
const empty = (v) => v === null || v === "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pgcode = (e) => { const m = /Code: `([^`]+)`/.exec(String(e && e.message)); const t = /Message: `([^`]+)`/.exec(String(e && e.message)); return (m ? m[1] : "N/A") + (t ? " " + t[1].slice(0, 90) : " " + String(e && e.message ? e.message : e).slice(0, 90)); };

function identity(raw, name) {
  const u = new URL(raw);
  const first = u.hostname.split(".")[0];
  const ep = first.endsWith("-pooler") ? first.slice(0, -"-pooler".length) : first;
  if (DENY.includes(ep)) throw new Error(name + ": DENY endpoint");
  if (ep !== EXPECT_ENDPOINT) throw new Error(name + ": endpoint " + ep + " != " + EXPECT_ENDPOINT);
  if (!u.hostname.endsWith(SUFFIX)) throw new Error(name + ": suffix mismatch");
  if ((u.pathname || "").replace(/^\//, "") !== EXPECT_DB) throw new Error(name + ": db mismatch");
  return { pooled: first.endsWith("-pooler") };
}
const pool = identity(process.env.DATABASE_URL, "DATABASE_URL");
identity(process.env.DIRECT_URL, "DIRECT_URL");
console.log("[identity] pooled endpoint=" + EXPECT_ENDPOINT + " db=" + EXPECT_DB + " (DATABASE_URL pooled=" + pool.pooled + ")");

const PW = "p4pc" + randomBytes(18).toString("base64url");
function withRole(raw, pgbouncer) {
  const u = new URL(raw);
  u.username = ROLE; u.password = PW;
  if (pgbouncer) u.searchParams.set("pgbouncer", "true");
  return u.toString();
}
const roleDirectUrl = withRole(process.env.DIRECT_URL, false);
const rolePooledUrl = withRole(process.env.DATABASE_URL, false);
const rolePooledUrlPgb = withRole(process.env.DATABASE_URL, true);

const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
const exec = (c, sql) => c.$executeRawUnsafe(sql);

async function attrs() {
  const a = await owner.$queryRawUnsafe("SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin FROM pg_roles WHERE rolname='" + ROLE + "'");
  const ns = await owner.$queryRawUnsafe("SELECT count(*)::int AS c FROM pg_auth_members me JOIN pg_roles g ON g.oid=me.roleid JOIN pg_roles r ON r.oid=me.member WHERE r.rolname='" + ROLE + "' AND g.rolname='neon_superuser'");
  const own = await owner.$queryRawUnsafe("SELECT count(*)::int AS c FROM pg_tables WHERE tableowner='" + ROLE + "'");
  return { ...a[0], neon_super: Number(ns[0].c), owns: Number(own[0].c) };
}

let roleCreated = false, pooledClient = null, usedPgb = false;

async function run() {
  const pre = await owner.$queryRawUnsafe(
    "SELECT (SELECT count(*)::int FROM pg_roles WHERE rolname='" + ROLE + "') AS role," +
    " (SELECT count(*)::int FROM information_schema.schemata WHERE schema_name='" + LAB + "') AS lab," +
    " (SELECT count(*)::int FROM information_schema.tables WHERE table_schema='public') AS pub");
  if (Number(pre[0].role) !== 0 || Number(pre[0].lab) !== 0) throw new Error("p4_poolcheck collision");
  R._public_before = Number(pre[0].pub);

  // 1. Create the role via SQL (never the Neon API).
  await exec(owner, "CREATE ROLE " + ROLE + " LOGIN PASSWORD '" + PW +
    "' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT");
  roleCreated = true;
  R.SQL_ROLE_CREATED = "YES";
  const t0 = Date.now();
  console.log("[create] role " + ROLE + " created via SQL");

  // 2. Attributes + memberships.
  const a = await attrs();
  mark("NOBYPASSRLS", a.rolbypassrls === false, "rolbypassrls=" + a.rolbypassrls);
  R.NEON_SUPER = a.neon_super === 0 ? "ABSENT" : "PRESENT";
  notes.push("[attrs] super=" + a.rolsuper + " bypassrls=" + a.rolbypassrls + " createrole=" + a.rolcreaterole + " createdb=" + a.rolcreatedb + " login=" + a.rolcanlogin + " neon_superuser=" + a.neon_super + " owns=" + a.owns);
  const leastPriv = a.rolsuper === false && a.rolbypassrls === false && a.rolcreaterole === false && a.rolcreatedb === false && a.neon_super === 0 && a.owns === 0;
  mark("LEAST_PRIVILEGE", leastPriv);

  // 3. DIRECT auth control.
  try {
    const c = new PrismaClient({ datasourceUrl: roleDirectUrl });
    const r = await c.$queryRaw`SELECT current_user::text AS u`;
    await c.$disconnect();
    mark("DIRECT_AUTH", r[0].u === ROLE, "current_user=" + r[0].u);
  } catch (e) { mark("DIRECT_AUTH", false, "direct auth failed: " + pgcode(e)); }
  if (R.DIRECT_AUTH !== "PASS") throw new Error("direct auth failed — provisioning broken, STOP");

  // 4. Pooler propagation timeline (plain pooled string; no pgbouncer param yet).
  const marks = [0, 2, 5, 10, 20, 30, 60];
  const timeline = [];
  let firstSuccess = null;
  for (const m of marks) {
    const waitMs = t0 + m * 1000 - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const c = new PrismaClient({ datasourceUrl: rolePooledUrl });
    try {
      const r = await c.$queryRaw`SELECT current_user::text AS u`;
      if (r[0].u === ROLE) { timeline.push(elapsed + "s OK"); firstSuccess = Number(elapsed); pooledClient = c; break; }
      timeline.push(elapsed + "s wrong-user=" + r[0].u); await c.$disconnect();
    } catch (e) { timeline.push(elapsed + "s FAIL " + pgcode(e)); try { await c.$disconnect(); } catch {} }
  }
  R._timeline = timeline.join(" | ");
  notes.push("[pooler-timeline] " + R._timeline);
  mark("POOLER_AUTH", firstSuccess !== null, firstSuccess !== null ? "current_user=" + ROLE + " at ~" + firstSuccess + "s" : "no pooled success within 60s");
  R.TIME_TO_FIRST = firstSuccess !== null ? firstSuccess + "s" : "never";
  R.POOLER_AVAILABILITY = firstSuccess === null ? "NEVER AVAILABLE" : (marks[0] === 0 && firstSuccess < 2 && timeline[0].includes("OK") ? "IMMEDIATE" : "PROPAGATION OBSERVED");

  if (R.POOLER_AUTH !== "PASS") { R.POOLED_RLS_SANITY = "NOT RUN"; R.PGBOUNCER_REQUIRED = "UNKNOWN"; R.BACKEND_GUC_LEAK = "UNKNOWN"; return; }

  // 5. Provision synthetic RLS lab (owner).
  await exec(owner, "CREATE SCHEMA " + LAB);
  await exec(owner, "CREATE TABLE " + LAB + ".p4_probe (p4_id bigserial PRIMARY KEY, p4_business_id integer NOT NULL, p4_label text NOT NULL)");
  const gucExpr = "NULLIF(current_setting('" + GUC + "', true), '')::int";
  await exec(owner, "ALTER TABLE " + LAB + ".p4_probe ENABLE ROW LEVEL SECURITY");
  await exec(owner, "ALTER TABLE " + LAB + ".p4_probe FORCE ROW LEVEL SECURITY");
  await exec(owner, "CREATE POLICY p4_tenant ON " + LAB + ".p4_probe USING (p4_business_id = " + gucExpr + ") WITH CHECK (p4_business_id = " + gucExpr + ")");
  await exec(owner, "GRANT USAGE ON SCHEMA " + LAB + " TO " + ROLE);
  await exec(owner, "GRANT SELECT, INSERT, UPDATE, DELETE ON " + LAB + ".p4_probe TO " + ROLE);
  await exec(owner, "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA " + LAB + " TO " + ROLE);
  await exec(owner, "INSERT INTO " + LAB + ".p4_probe (p4_business_id, p4_label) VALUES (" + BIZ_A + ", 'A'), (" + BIZ_B + ", 'B')");

  // 6. Pooled RLS sanity. Try plain first; fall back to pgbouncer=true only if needed.
  async function sanity(client) {
    const tx = (biz, fn) => client.$transaction(async (t) => {
      if (biz !== null) await t.$queryRaw`SELECT set_config(${GUC}, ${String(biz)}, true)`;
      return fn(t);
    }, { maxWait: 15000, timeout: 20000 });
    const one = (rows) => Number(rows[0].c);
    const seesA = await tx(BIZ_A, async (t) => one(await t.$queryRawUnsafe("SELECT count(*)::int AS c FROM " + LAB + ".p4_probe WHERE p4_business_id=" + BIZ_A)));
    const seesB = await tx(BIZ_A, async (t) => one(await t.$queryRawUnsafe("SELECT count(*)::int AS c FROM " + LAB + ".p4_probe WHERE p4_business_id=" + BIZ_B)));
    const broad = await tx(BIZ_A, async (t) => one(await t.$queryRawUnsafe("SELECT count(*)::int AS c FROM " + LAB + ".p4_probe")));
    let rej = false;
    try { await tx(BIZ_A, async (t) => t.$executeRawUnsafe("INSERT INTO " + LAB + ".p4_probe (p4_business_id, p4_label) VALUES (" + BIZ_B + ", 'forge')")); } catch { rej = true; }
    const noCtx = await tx(null, async (t) => one(await t.$queryRawUnsafe("SELECT count(*)::int AS c FROM " + LAB + ".p4_probe")));
    const residue = await client.$queryRaw`SELECT current_setting(${GUC}, true) AS v`;
    return { seesA, seesB, broad, rej, noCtx, guc: residue[0].v };
  }
  try {
    let out;
    try { out = await sanity(pooledClient); }
    catch (e1) {
      notes.push("[rls-sanity] plain pooled failed: " + pgcode(e1) + " — retrying with pgbouncer=true");
      try { await pooledClient.$disconnect(); } catch {}
      pooledClient = new PrismaClient({ datasourceUrl: rolePooledUrlPgb }); usedPgb = true;
      out = await sanity(pooledClient);
    }
    mark("POOLED_RLS_SANITY", out.seesA === 1 && out.seesB === 0 && out.broad === 1 && out.rej === true && out.noCtx === 0 && empty(out.guc),
      "A=" + out.seesA + " B=" + out.seesB + " broad=" + out.broad + " with_check_rejected=" + out.rej + " no_ctx=" + out.noCtx + " commit_guc=" + JSON.stringify(out.guc));
  } catch (e) { mark("POOLED_RLS_SANITY", false, "rls sanity threw: " + pgcode(e)); }
  R.PGBOUNCER_REQUIRED = R.POOLED_RLS_SANITY === "PASS" ? (usedPgb ? "YES" : "NO") : "UNKNOWN";

  // 7. Backend reuse + GUC leak: sample pids; if one repeats, GUC must be empty pre-set.
  try {
    const seen = new Map(); let reuse = false, leak = false;
    for (let i = 0; i < 12; i++) {
      const r = await pooledClient.$queryRaw`SELECT pg_backend_pid() AS pid, current_setting(${GUC}, true) AS v`;
      const pid = Number(r[0].pid);
      if (seen.has(pid)) { reuse = true; if (!empty(r[0].v)) { leak = true; break; } }
      seen.set(pid, true);
    }
    R.BACKEND_GUC_LEAK = reuse ? (leak ? "FAILURE" : "0") : "UNKNOWN";
    notes.push("[backend-reuse] distinct_pids=" + seen.size + " reuse_observed=" + reuse + " leak=" + leak);
  } catch (e) { R.BACKEND_GUC_LEAK = "UNKNOWN"; notes.push("[backend-reuse] " + pgcode(e)); }
}

async function teardown() {
  try { if (pooledClient) await pooledClient.$disconnect(); } catch {}
  try { await exec(owner, "DROP SCHEMA IF EXISTS " + LAB + " CASCADE"); } catch (e) { notes.push("[td-schema] " + pgcode(e)); }
  if (roleCreated) {
    try { await exec(owner, "DROP OWNED BY " + ROLE); } catch {}
    try { await exec(owner, "DROP ROLE IF EXISTS " + ROLE); } catch (e) { notes.push("[td-role] " + pgcode(e)); }
  }
  try {
    const res = await owner.$queryRawUnsafe(
      "SELECT (SELECT count(*)::int FROM pg_roles WHERE rolname='" + ROLE + "') AS role," +
      " (SELECT count(*)::int FROM information_schema.schemata WHERE schema_name='" + LAB + "') AS lab," +
      " (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname LIKE 'p4\\_%' AND n.nspname='" + LAB + "') AS rel," +
      " (SELECT count(*)::int FROM information_schema.tables WHERE table_schema='public') AS pub");
    const r = res[0];
    R.RESIDUE = (Number(r.role) === 0 && Number(r.lab) === 0 && Number(r.rel) === 0) ? "0" : "FAILURE";
    R._public_after = Number(r.pub);
    console.log("[teardown] role=" + r.role + " lab=" + r.lab + " rel=" + r.rel + " public=" + r.pub + " (before " + R._public_before + ")");
  } catch (e) { R.RESIDUE = "FAILURE"; notes.push("[td-verify] " + pgcode(e)); }
}

let fatal = null;
try { await run(); } catch (e) { fatal = e; notes.push("[fatal] " + String(e && e.message ? e.message : e).slice(0, 300)); }
await teardown();
try { await owner.$disconnect(); } catch {}

const verdict = R.SQL_ROLE_CREATED === "YES" && R.DIRECT_AUTH === "PASS" && R.NOBYPASSRLS === "PASS" &&
  R.NEON_SUPER === "ABSENT" && R.POOLER_AUTH === "PASS" && R.POOLED_RLS_SANITY === "PASS" &&
  R.BACKEND_GUC_LEAK !== "FAILURE" && R.RESIDUE === "0" && !fatal;
R.P4BPC = verdict ? "PASS" : "FAIL";
const ready = verdict ? "YES" : "NO";

const L = (k, v) => k.padEnd(32) + "= " + v;
const report = [
  L("SQL ROLE CREATED", R.SQL_ROLE_CREATED || "NO"),
  L("DIRECT AUTH", R.DIRECT_AUTH || "FAIL"),
  L("POOLER AUTH", R.POOLER_AUTH || "FAIL"),
  L("POOLER AVAILABILITY", R.POOLER_AVAILABILITY || "NEVER AVAILABLE"),
  L("TIME TO FIRST POOLED SUCCESS", R.TIME_TO_FIRST || "never"),
  L("NOBYPASSRLS", R.NOBYPASSRLS || "FAIL"),
  L("NEON_SUPERUSER MEMBERSHIP", R.NEON_SUPER || "PRESENT"),
  L("POOLED RLS SANITY", R.POOLED_RLS_SANITY || "NOT RUN"),
  L("PGBOUNCER=true REQUIRED", R.PGBOUNCER_REQUIRED || "UNKNOWN"),
  L("POOLER BACKEND GUC LEAK", R.BACKEND_GUC_LEAK || "UNKNOWN"),
  L("PUBLIC TOUCHED", "NO (public_tables " + R._public_before + "->" + (R._public_after ?? "?") + ")"),
  L("app_runtime TOUCHED", "NO"),
  L("PRODUCTION TOUCHED", "NO"),
  L("P4-B-POOLCHECK RESIDUE", R.RESIDUE || "FAILURE"),
  L("P4-B-POOLCHECK", R.P4BPC),
  L("READY FOR P4-B WIRING", ready),
];
console.log("\n" + report.join("\n") + "\n--- notes ---\n" + notes.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) {
  const fs = await import("node:fs");
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "## D2 / P4-B-POOLCHECK\n\n```\n" + report.join("\n") + "\n```\n");
}
if (fatal || R.P4BPC !== "PASS") process.exit(1);
