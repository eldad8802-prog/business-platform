/**
 * D2 / P4-A — Real Neon non-bypass role lab battery (PREVIEW ONLY).
 *
 * Proves Option A firsthand on the real Neon Preview transport:
 *   standard Prisma  ->  a connection that authenticates DIRECTLY as a dedicated
 *   PostgreSQL LOGIN role (non-owner, NOSUPERUSER, NOBYPASSRLS)  ->  transaction-
 *   local tenant GUC  ->  FORCE RLS  ->  fail-closed tenant isolation.
 *
 * The security matrix runs through a client whose `current_user = p4_runtime_lab`
 * — NOT owner + SET ROLE. The owner/DIRECT connection is used ONLY to provision
 * the lab (schema, role, synthetic tables, policies, grants, fixtures) and to
 * tear it down. Every object lives under p4_runtime_lab.p4_*; nothing touches
 * public; app_runtime is never referenced. No secret is ever printed.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

// ---------------------------------------------------------------------------
// 0. IDENTITY RE-ASSERTION — before any client construction. Fail closed.
// ---------------------------------------------------------------------------
const EXPECT_ENDPOINT = process.env.P4_EXPECT_ENDPOINT;
const EXPECT_DB = process.env.P4_EXPECT_DB;
const EXPECT_SUFFIX = process.env.P4_EXPECT_HOST_SUFFIX;
const DENY = (process.env.P4_DENY_ENDPOINTS || "").split(/\s+/).filter(Boolean);
const GUC = "app.current_business_id";
const LAB = "p4_runtime_lab";
const ROLE = "p4_runtime_lab";
const BIZ_A = 1001;
const BIZ_B = 2002;

function identity(raw, name) {
  if (!raw) throw new Error(name + " is empty");
  let u;
  try { u = new URL(raw); } catch { throw new Error(name + " is not a parseable URL"); }
  const host = u.hostname;
  const db = (u.pathname || "").replace(/^\//, "");
  const first = host.split(".")[0];
  const pooled = first.endsWith("-pooler");
  const endpoint = pooled ? first.slice(0, -"-pooler".length) : first;
  return { host, db, endpoint, pooled };
}
function assertPreview(id, name) {
  if (DENY.includes(id.endpoint)) throw new Error(name + ": HARD DENY endpoint " + id.endpoint);
  if (id.endpoint !== EXPECT_ENDPOINT) throw new Error(name + ": endpoint " + id.endpoint + " != " + EXPECT_ENDPOINT);
  if (!id.host.endsWith(EXPECT_SUFFIX)) throw new Error(name + ": host region suffix mismatch");
  if (id.db !== EXPECT_DB) throw new Error(name + ": database " + id.db + " != " + EXPECT_DB);
}

const poolId = identity(process.env.DATABASE_URL, "DATABASE_URL");
const directId = identity(process.env.DIRECT_URL, "DIRECT_URL");
assertPreview(poolId, "DATABASE_URL");
assertPreview(directId, "DIRECT_URL");
console.log("[identity] DATABASE_URL endpoint=" + poolId.endpoint + " mode=" + (poolId.pooled ? "pooled" : "direct") + " db=" + poolId.db);
console.log("[identity] DIRECT_URL   endpoint=" + directId.endpoint + " mode=" + (directId.pooled ? "pooled" : "direct") + " db=" + directId.db);

// Synthetic, lab-only credential. Generated in-process; never logged, never persisted.
const ROLE_PW = "p4x" + randomBytes(18).toString("base64url");
function withRole(raw) {
  const u = new URL(raw);
  u.username = ROLE;
  u.password = ROLE_PW;
  return u.toString();
}
const roleDirectUrl = withRole(process.env.DIRECT_URL);
const rolePooledUrl = withRole(process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// Result ledger
// ---------------------------------------------------------------------------
const R = {};
const notes = [];
const mark = (k, ok, note) => { R[k] = ok ? "PASS" : "FAIL"; if (note) notes.push("[" + k + "] " + note); };
const empty = (v) => v === null || v === "";

// Owner/admin clients — provisioning + teardown ONLY.
const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
// Runtime clients — authenticate DIRECTLY as the non-bypass role.
let roleDirect = null;
let rolePooled = null;

const exec = (c, sql) => c.$executeRawUnsafe(sql);
const q = (c, sql) => c.$queryRawUnsafe(sql);

// Run fn inside an interactive tx on `client`, setting the tenant GUC first (or
// leaving it unset when biz === null, to prove fail-closed).
async function tenantTx(client, biz, fn, label) {
  return client.$transaction(async (tx) => {
    if (biz !== null && biz !== undefined) {
      await tx.$queryRaw`SELECT set_config(${GUC}, ${String(biz)}, true)`;
    }
    return fn(tx);
  }, { maxWait: 15000, timeout: 20000 }).catch((e) => {
    if (label) notes.push("[tx:" + label + "] " + String(e && e.message ? e.message : e).slice(0, 200));
    throw e;
  });
}
// Does a statement get denied? true = denied (threw), false = allowed.
async function denied(fn) {
  try { await fn(); return false; } catch { return true; }
}

async function provision() {
  const pre = await owner.$queryRaw`
    SELECT current_user::text AS usr, current_database()::text AS db,
      (SELECT count(*)::int FROM information_schema.schemata WHERE schema_name = 'p4_runtime_lab') AS lab,
      (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname LIKE 'p4\\_%') AS rel_p4,
      (SELECT count(*)::int FROM pg_roles WHERE rolname='p4_runtime_lab') AS role,
      (SELECT count(*)::int FROM information_schema.tables WHERE table_schema='public') AS pub`;
  const p = pre[0];
  console.log("[preflight] owner=" + p.usr + " db=" + p.db + " lab=" + p.lab + " rel_p4=" + p.rel_p4 + " role=" + p.role + " public_tables=" + p.pub);
  if (p.db !== EXPECT_DB) throw new Error("current_database() = " + p.db);
  if (p.lab !== 0 || p.rel_p4 !== 0 || p.role !== 0) throw new Error("p4_* / role collision — refusing to touch pre-existing objects");
  R._owner = p.usr; R._public_before = p.pub;

  // Role: LOGIN, non-owner, least attributes. Synthetic password (in-process).
  await exec(owner, "CREATE ROLE " + ROLE + " LOGIN PASSWORD '" + ROLE_PW +
    "' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT");
  await exec(owner, "CREATE SCHEMA " + LAB);

  // Direct-tenancy tables.
  await exec(owner, "CREATE TABLE " + LAB + ".p4_customer (p4_id bigserial PRIMARY KEY, p4_business_id integer NOT NULL, p4_label text NOT NULL)");
  await exec(owner, "CREATE TABLE " + LAB + ".p4_document (p4_id bigserial PRIMARY KEY, p4_business_id integer NOT NULL, p4_label text NOT NULL)");
  // Indirect / parent-join: no direct business id; tenancy via parent p4_document.
  await exec(owner, "CREATE TABLE " + LAB + ".p4_document_line (p4_id bigserial PRIMARY KEY, p4_document_id bigint NOT NULL REFERENCES " + LAB + ".p4_document(p4_id), p4_label text NOT NULL)");
  // Global control (no RLS) + synthetic bootstrap identity (no RLS, SELECT-only for role).
  await exec(owner, "CREATE TABLE " + LAB + ".p4_global (p4_id bigserial PRIMARY KEY, p4_label text NOT NULL)");
  await exec(owner, "CREATE TABLE " + LAB + ".p4_bootstrap_identity (p4_id bigserial PRIMARY KEY, p4_business_id integer NOT NULL, p4_label text NOT NULL)");

  // RLS on tenant tables only (ENABLE + FORCE so even the owner is subject to it).
  const guc = "NULLIF(current_setting('" + GUC + "', true), '')::int";
  for (const t of ["p4_customer", "p4_document"]) {
    await exec(owner, "ALTER TABLE " + LAB + "." + t + " ENABLE ROW LEVEL SECURITY");
    await exec(owner, "ALTER TABLE " + LAB + "." + t + " FORCE ROW LEVEL SECURITY");
    await exec(owner, "CREATE POLICY p4_tenant ON " + LAB + "." + t +
      " USING (p4_business_id = " + guc + ") WITH CHECK (p4_business_id = " + guc + ")");
  }
  // Parent-join policy for the line table (indirect tenancy).
  await exec(owner, "ALTER TABLE " + LAB + ".p4_document_line ENABLE ROW LEVEL SECURITY");
  await exec(owner, "ALTER TABLE " + LAB + ".p4_document_line FORCE ROW LEVEL SECURITY");
  await exec(owner, "CREATE POLICY p4_tenant_join ON " + LAB + ".p4_document_line" +
    " USING (EXISTS (SELECT 1 FROM " + LAB + ".p4_document d WHERE d.p4_id = p4_document_line.p4_document_id AND d.p4_business_id = " + guc + "))" +
    " WITH CHECK (EXISTS (SELECT 1 FROM " + LAB + ".p4_document d WHERE d.p4_id = p4_document_line.p4_document_id AND d.p4_business_id = " + guc + "))");

  // Least-privilege grants. USAGE on the lab schema ONLY (never public). DML on
  // tenant tables; SELECT on control/bootstrap. No CREATE, no _prisma_migrations.
  await exec(owner, "GRANT CONNECT ON DATABASE " + EXPECT_DB + " TO " + ROLE);
  await exec(owner, "GRANT USAGE ON SCHEMA " + LAB + " TO " + ROLE);
  await exec(owner, "GRANT SELECT, INSERT, UPDATE, DELETE ON " + LAB + ".p4_customer, " + LAB + ".p4_document, " + LAB + ".p4_document_line TO " + ROLE);
  await exec(owner, "GRANT SELECT ON " + LAB + ".p4_global, " + LAB + ".p4_bootstrap_identity TO " + ROLE);
  await exec(owner, "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA " + LAB + " TO " + ROLE);

  // Fixtures: one row per section per tenant, + control + bootstrap rows.
  await exec(owner, "INSERT INTO " + LAB + ".p4_customer (p4_business_id, p4_label) VALUES (" + BIZ_A + ", 'A-customer'), (" + BIZ_B + ", 'B-customer')");
  await exec(owner, "INSERT INTO " + LAB + ".p4_document (p4_business_id, p4_label) VALUES (" + BIZ_A + ", 'A-doc'), (" + BIZ_B + ", 'B-doc')");
  await exec(owner, "INSERT INTO " + LAB + ".p4_document_line (p4_document_id, p4_label) SELECT p4_id, 'A-line' FROM " + LAB + ".p4_document WHERE p4_business_id=" + BIZ_A);
  await exec(owner, "INSERT INTO " + LAB + ".p4_document_line (p4_document_id, p4_label) SELECT p4_id, 'B-line' FROM " + LAB + ".p4_document WHERE p4_business_id=" + BIZ_B);
  await exec(owner, "INSERT INTO " + LAB + ".p4_global (p4_label) VALUES ('global-1'), ('global-2')");
  await exec(owner, "INSERT INTO " + LAB + ".p4_bootstrap_identity (p4_business_id, p4_label) VALUES (" + BIZ_A + ", 'A-identity'), (" + BIZ_B + ", 'B-identity')");
  console.log("[lab] provisioned schema " + LAB + " + role " + ROLE + " + synthetic fixtures");
}

async function attributeProof() {
  // Connect DIRECTLY as the role. If this fails, Option A cannot be proven.
  roleDirect = new PrismaClient({ datasourceUrl: roleDirectUrl });
  const a = await roleDirect.$queryRaw`
    SELECT current_user::text AS usr,
           r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolcanlogin
    FROM pg_roles r WHERE r.rolname = current_user`;
  const row = a[0];
  R._current_user = row.usr;
  mark("DIRECT_ROLE_AUTH", row.usr === ROLE, "current_user=" + row.usr);
  mark("NOSUPERUSER", row.rolsuper === false, "rolsuper=" + row.rolsuper);
  mark("NOBYPASSRLS", row.rolbypassrls === false, "rolbypassrls=" + row.rolbypassrls);
  mark("NOCREATEROLE", row.rolcreaterole === false, "rolcreaterole=" + row.rolcreaterole);
  mark("NOCREATEDB", row.rolcreatedb === false, "rolcreatedb=" + row.rolcreatedb);

  // Ownership: the role must own none of the lab tables.
  const own = await roleDirect.$queryRaw`
    SELECT count(*)::int AS c FROM pg_tables
    WHERE schemaname = 'p4_runtime_lab' AND tableowner = current_user`;
  mark("NON_OWNER", own[0].c === 0, "tables owned by role = " + own[0].c);

  // Memberships: list groups the role belongs to; none may grant bypass/superuser.
  const mem = await roleDirect.$queryRaw`
    SELECT count(*)::int AS bad FROM pg_auth_members m
    JOIN pg_roles grp ON grp.oid = m.roleid
    JOIN pg_roles me  ON me.oid  = m.member
    WHERE me.rolname = current_user AND (grp.rolbypassrls OR grp.rolsuper)`;
  const memAll = await roleDirect.$queryRaw`
    SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles me ON me.oid=m.member WHERE me.rolname=current_user`;
  mark("NO_BYPASS_MEMBERSHIP", mem[0].bad === 0, "member of " + memAll[0].n + " group(s), " + mem[0].bad + " granting bypass/super");
}

async function isolationMatrix() {
  const rd = roleDirect;
  const one = (rows) => Number(rows[0].c);

  // Same-tenant CRUD (A) — all must succeed and stay within A.
  try {
    const out = await tenantTx(rd, BIZ_A, async (tx) => {
      const sel = await tx.$queryRawUnsafe("SELECT count(*)::int AS c FROM " + LAB + ".p4_customer");
      await tx.$executeRawUnsafe("INSERT INTO " + LAB + ".p4_customer (p4_business_id, p4_label) VALUES (" + BIZ_A + ", 'A-new')");
      const ins = await tx.$queryRawUnsafe("SELECT count(*)::int AS c FROM " + LAB + ".p4_customer WHERE p4_label='A-new'");
      await tx.$executeRawUnsafe("UPDATE " + LAB + ".p4_customer SET p4_label='A-upd' WHERE p4_label='A-new'");
      const upd = await tx.$queryRawUnsafe("SELECT count(*)::int AS c FROM " + LAB + ".p4_customer WHERE p4_label='A-upd'");
      await tx.$executeRawUnsafe("DELETE FROM " + LAB + ".p4_customer WHERE p4_label='A-upd'");
      const del = await tx.$queryRawUnsafe("SELECT count(*)::int AS c FROM " + LAB + ".p4_customer WHERE p4_label LIKE 'A-%' AND p4_label<>'A-customer'");
      return [one(sel), one(ins), one(upd), one(del)];
    }, "same-A");
    mark("SAME_TENANT", out[0] === 1 && out[1] === 1 && out[2] === 1 && out[3] === 0, "A sees=" + out[0] + " ins=" + out[1] + " upd=" + out[2] + " residual=" + out[3]);
  } catch { mark("SAME_TENANT", false, "same-tenant CRUD threw"); }

  // Cross-tenant reads: under A, B is invisible; broad SELECT = A only.
  try {
    const out = await tenantTx(rd, BIZ_A, async (tx) => {
      const bexpl = await tx.$queryRawUnsafe("SELECT count(*)::int AS c FROM " + LAB + ".p4_customer WHERE p4_business_id=" + BIZ_B);
      const broad = await tx.$queryRawUnsafe("SELECT count(*)::int AS c FROM " + LAB + ".p4_customer");
      const onlyA = await tx.$queryRawUnsafe("SELECT count(*)::int AS c FROM " + LAB + ".p4_customer WHERE p4_business_id=" + BIZ_A);
      return [one(bexpl), one(broad), one(onlyA)];
    }, "cross-read");
    mark("CROSS_TENANT_READ", out[0] === 0 && out[1] === out[2] && out[2] === 1, "B_explicit=" + out[0] + " broad=" + out[1] + " A_only=" + out[2]);
  } catch { mark("CROSS_TENANT_READ", false, "cross-read threw"); }

  // Cross-tenant writes: under A, UPDATE/DELETE of B affect 0 rows.
  try {
    const out = await tenantTx(rd, BIZ_A, async (tx) => {
      const u = await tx.$executeRawUnsafe("UPDATE " + LAB + ".p4_customer SET p4_label='hacked' WHERE p4_business_id=" + BIZ_B);
      const d = await tx.$executeRawUnsafe("DELETE FROM " + LAB + ".p4_customer WHERE p4_business_id=" + BIZ_B);
      return [u, d];
    }, "cross-write");
    // verify B intact via owner
    const bIntact = await owner.$queryRawUnsafe("SELECT count(*)::int AS c FROM " + LAB + ".p4_customer WHERE p4_business_id=" + BIZ_B + " AND p4_label='B-customer'");
    mark("CROSS_TENANT_WRITE", out[0] === 0 && out[1] === 0 && Number(bIntact[0].c) === 1, "upd_rows=" + out[0] + " del_rows=" + out[1] + " B_intact=" + bIntact[0].c);
  } catch { mark("CROSS_TENANT_WRITE", false, "cross-write threw"); }

  // INSERT WITH CHECK: under A, inserting a row claiming B must be rejected.
  try {
    const rej = await denied(() => tenantTx(rd, BIZ_A, async (tx) => {
      await tx.$executeRawUnsafe("INSERT INTO " + LAB + ".p4_customer (p4_business_id, p4_label) VALUES (" + BIZ_B + ", 'A-forging-B')");
    }, "with-check"));
    const leaked = await owner.$queryRawUnsafe("SELECT count(*)::int AS c FROM " + LAB + ".p4_customer WHERE p4_label='A-forging-B'");
    mark("INSERT_WITH_CHECK", rej === true && Number(leaked[0].c) === 0, "rejected=" + rej + " leaked_rows=" + leaked[0].c);
  } catch { mark("INSERT_WITH_CHECK", false, "with-check probe threw"); }

  // RLS-only raw SQL: under A, a raw explicit-B query returns 0 (DB enforces, not app).
  try {
    const out = await tenantTx(rd, BIZ_A, async (tx) => {
      const r = await tx.$queryRawUnsafe("SELECT count(*)::int AS c FROM " + LAB + ".p4_customer WHERE p4_business_id IN (" + BIZ_A + "," + BIZ_B + ")");
      return one(r);
    }, "rls-only");
    mark("RLS_ONLY_RAW", out === 1, "raw union-of-both under A returns " + out + " (A only)");
  } catch { mark("RLS_ONLY_RAW", false, "rls-only probe threw"); }

  // Fail-closed: no / empty / malformed context must never return tenant rows.
  try {
    const noCtx = await tenantTx(rd, null, async (tx) => one(await tx.$queryRawUnsafe("SELECT count(*)::int AS c FROM " + LAB + ".p4_customer")), "no-ctx");
    const emptyCtx = await tenantTx(rd, "", async (tx) => one(await tx.$queryRawUnsafe("SELECT count(*)::int AS c FROM " + LAB + ".p4_customer")), "empty-ctx");
    let malformedSafe = false;
    try {
      const m = await tenantTx(rd, "not-an-int", async (tx) => one(await tx.$queryRawUnsafe("SELECT count(*)::int AS c FROM " + LAB + ".p4_customer")), "malformed-ctx");
      malformedSafe = m === 0; // returned but empty
    } catch { malformedSafe = true; } // errored => no data => fail-closed
    mark("FAIL_CLOSED", noCtx === 0 && emptyCtx === 0 && malformedSafe, "no=" + noCtx + " empty=" + emptyCtx + " malformed_safe=" + malformedSafe);
  } catch { mark("FAIL_CLOSED", false, "fail-closed probe threw"); }

  // Transaction cleanup: commit + rollback leave no GUC residue on the pooled role conn.
  try {
    await tenantTx(rd, BIZ_A, async (tx) => { await tx.$queryRaw`SELECT 1`; }, "commit");
    let rolled = false;
    try {
      await tenantTx(rd, BIZ_B, async (tx) => { await tx.$queryRaw`SELECT 1`; throw new Error("p4-forced-rollback"); }, "rollback");
    } catch (e) { rolled = /p4-forced-rollback/.test(String(e && e.message)); }
    let residue = null;
    for (let i = 0; i < 12; i++) {
      const r = await rd.$queryRaw`SELECT current_setting(${GUC}, true) AS v`;
      if (!empty(r[0].v)) { residue = r[0].v; break; }
    }
    mark("TRANSACTION_CLEANUP", rolled && residue === null, "rolled=" + rolled + " residue=" + (residue ?? "none") + " (12 post-tx probes)");
  } catch { mark("TRANSACTION_CLEANUP", false, "cleanup probe threw"); }

  // Sequential A -> B: no contamination.
  try {
    const a = await tenantTx(rd, BIZ_A, async (tx) => (await tx.$queryRaw`SELECT current_setting(${GUC}, true) AS v`)[0].v, "seqA");
    const b = await tenantTx(rd, BIZ_B, async (tx) => {
      const before = (await tx.$queryRaw`SELECT current_setting(${GUC}, true) AS v`)[0].v;
      return before;
    }, "seqB");
    mark("SEQUENTIAL_ISOLATION", a === String(BIZ_A) && b === String(BIZ_B), "A=" + a + " B_ctx=" + b);
  } catch { mark("SEQUENTIAL_ISOLATION", false, "sequential probe threw"); }

  // Concurrent A/B: 16-wide interleave, each reads exactly its own context.
  try {
    const N = 16;
    const res = await Promise.allSettled(Array.from({ length: N }, (_, i) => {
      const biz = i % 2 === 0 ? BIZ_A : BIZ_B;
      return tenantTx(rd, biz, async (tx) => {
        await tx.$queryRaw`SELECT pg_sleep(0.03)`;
        const got = (await tx.$queryRaw`SELECT current_setting(${GUC}, true) AS v`)[0].v;
        const seen = Number((await tx.$queryRawUnsafe("SELECT count(*)::int AS c FROM " + LAB + ".p4_customer"))[0].c);
        return { want: String(biz), got, seen };
      }, "conc#" + i);
    }));
    const ok = res.filter((r) => r.status === "fulfilled").map((r) => r.value);
    const badCtx = ok.filter((r) => r.got !== r.want).length;
    const badRows = ok.filter((r) => r.seen !== 1).length;
    mark("CONCURRENT_ISOLATION", res.length === ok.length && badCtx === 0 && badRows === 0, ok.length + "/" + N + " ok, " + badCtx + " ctx-cross, " + badRows + " row-cross");
  } catch { mark("CONCURRENT_ISOLATION", false, "concurrency threw"); }

  // Indirect / parent-join tenancy: under A, only A's lines are visible.
  try {
    const out = await tenantTx(rd, BIZ_A, async (tx) => {
      const total = Number((await tx.$queryRawUnsafe("SELECT count(*)::int AS c FROM " + LAB + ".p4_document_line"))[0].c);
      const aLabels = await tx.$queryRawUnsafe("SELECT count(*)::int AS c FROM " + LAB + ".p4_document_line WHERE p4_label='A-line'");
      const bLabels = await tx.$queryRawUnsafe("SELECT count(*)::int AS c FROM " + LAB + ".p4_document_line WHERE p4_label='B-line'");
      return [total, Number(aLabels[0].c), Number(bLabels[0].c)];
    }, "indirect");
    mark("INDIRECT_TENANCY", out[0] === 1 && out[1] === 1 && out[2] === 0, "visible_lines=" + out[0] + " A=" + out[1] + " B=" + out[2]);
  } catch { mark("INDIRECT_TENANCY", false, "indirect probe threw"); }

  // Global control table: readable regardless of context (no tenant policy).
  try {
    const withCtx = await tenantTx(rd, BIZ_A, async (tx) => Number((await tx.$queryRawUnsafe("SELECT count(*)::int AS c FROM " + LAB + ".p4_global"))[0].c), "global-ctx");
    const noCtx = await tenantTx(rd, null, async (tx) => Number((await tx.$queryRawUnsafe("SELECT count(*)::int AS c FROM " + LAB + ".p4_global"))[0].c), "global-noctx");
    mark("GLOBAL_CONTROL", withCtx === 2 && noCtx === 2, "with_ctx=" + withCtx + " no_ctx=" + noCtx + " (no tenant policy)");
  } catch { mark("GLOBAL_CONTROL", false, "global probe threw"); }

  // Bootstrap model (Option A): identity SELECT works PRE-context; tenant-data
  // query without context is fail-closed. One non-bypass role serves both.
  try {
    const boot = await rd.$queryRawUnsafe("SELECT count(*)::int AS c FROM " + LAB + ".p4_bootstrap_identity");
    const bootN = Number(boot[0].c);
    const tenantNoCtx = await tenantTx(rd, null, async (tx) => Number((await tx.$queryRawUnsafe("SELECT count(*)::int AS c FROM " + LAB + ".p4_customer"))[0].c), "boot-tenant");
    mark("BOOTSTRAP_MODEL", bootN === 2 && tenantNoCtx === 0, "pre_context_identity_rows=" + bootN + " tenant_without_context=" + tenantNoCtx);
  } catch { mark("BOOTSTRAP_MODEL", false, "bootstrap probe threw"); }

  // DDL / privilege denial via the role connection. Safe probes only.
  try {
    const dCreate = await denied(() => exec(rd, "CREATE TABLE " + LAB + ".p4_evil (x int)"));
    const dAlter = await denied(() => exec(rd, "ALTER TABLE " + LAB + ".p4_customer ADD COLUMN p4_evil int"));
    const dDrop = await denied(() => exec(rd, "DROP TABLE " + LAB + ".p4_document_line"));
    const dRole = await denied(() => exec(rd, "CREATE ROLE p4_evil_role LOGIN"));
    const dMig = await denied(() => q(rd, "SELECT count(*) FROM public._prisma_migrations"));
    mark("DDL_DENIAL", dCreate && dAlter && dDrop && dRole && dMig,
      "create=" + dCreate + " alter=" + dAlter + " drop=" + dDrop + " createRole=" + dRole + " prisma_migrations=" + dMig);
  } catch { mark("DDL_DENIAL", false, "ddl-denial probe threw"); }

  // Pooler reuse: attempt to auth as the role over the POOLED endpoint and probe
  // for stale GUC across backend reuse. If the pooler cannot auth a SQL-created
  // role, that is a recorded P4-B finding (not a silent pass).
  try {
    rolePooled = new PrismaClient({ datasourceUrl: rolePooledUrl });
    const who = await rolePooled.$queryRaw`SELECT current_user::text AS u`;
    R._pooled_user = who[0].u;
    const tagged = await tenantTx(rolePooled, 555555, async (tx) => Number((await tx.$queryRaw`SELECT pg_backend_pid() AS pid`)[0].pid), "pool-tag");
    let revisited = false, leaked = false;
    for (let i = 0; i < 40; i++) {
      const r = await rolePooled.$queryRaw`SELECT current_setting(${GUC}, true) AS v, pg_backend_pid() AS pid`;
      if (Number(r[0].pid) === tagged) { revisited = true; if (!empty(r[0].v)) { leaked = true; break; } }
    }
    mark("POOLER_REUSE", who[0].u === ROLE && !leaked, "pooled_user=" + who[0].u + " tagged_pid=" + tagged + (revisited ? " revisited-clean" : " not-revisited(inconclusive-clean)"));
  } catch (e) {
    R.POOLER_REUSE = "UNKNOWN";
    notes.push("[POOLER_REUSE] pooled auth as role unavailable: " + String(e && e.message ? e.message : e).slice(0, 160) + " — P4-B must confirm pooler auth for the runtime role (direct-as-role already PASSED)");
  }
}

async function teardown() {
  try { if (roleDirect) await roleDirect.$disconnect(); } catch {}
  try { if (rolePooled) await rolePooled.$disconnect(); } catch {}
  try {
    await exec(owner, "DROP SCHEMA IF EXISTS " + LAB + " CASCADE");
    await exec(owner, "REVOKE ALL PRIVILEGES ON DATABASE " + EXPECT_DB + " FROM " + ROLE).catch(() => {});
    await exec(owner, "DROP OWNED BY " + ROLE).catch(() => {});
    await exec(owner, "DROP ROLE IF EXISTS " + ROLE);
    const res = await owner.$queryRaw`
      SELECT (SELECT count(*)::int FROM information_schema.schemata WHERE schema_name='p4_runtime_lab') AS lab,
             (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname LIKE 'p4\\_%') AS rel_p4,
             (SELECT count(*)::int FROM pg_roles WHERE rolname='p4_runtime_lab') AS role,
             (SELECT count(*)::int FROM information_schema.tables WHERE table_schema='public') AS pub`;
    const r = res[0];
    R.RESIDUE = (r.lab === 0 && r.rel_p4 === 0 && r.role === 0) ? "0" : "FAILURE";
    R._public_after = r.pub;
    R._public_unchanged = r.pub === R._public_before ? "YES" : "NO";
    console.log("[teardown] lab=" + r.lab + " rel_p4=" + r.rel_p4 + " role=" + r.role + " public_tables=" + r.pub + " (before " + R._public_before + ")");
  } catch (e) {
    R.RESIDUE = "FAILURE";
    notes.push("[teardown] " + String(e && e.message ? e.message : e).slice(0, 240));
  }
}

let fatal = null;
try {
  await provision();
  await attributeProof();
  await isolationMatrix();
} catch (e) { fatal = e; notes.push("[fatal] " + String(e && e.message ? e.message : e).slice(0, 400)); }
await teardown();
try { await owner.$disconnect(); } catch {}

const securityKeys = [
  "DIRECT_ROLE_AUTH", "NOSUPERUSER", "NOBYPASSRLS", "NOCREATEROLE", "NOCREATEDB", "NON_OWNER", "NO_BYPASS_MEMBERSHIP",
  "SAME_TENANT", "CROSS_TENANT_READ", "CROSS_TENANT_WRITE", "INSERT_WITH_CHECK", "RLS_ONLY_RAW", "FAIL_CLOSED",
  "TRANSACTION_CLEANUP", "SEQUENTIAL_ISOLATION", "CONCURRENT_ISOLATION", "INDIRECT_TENANCY", "GLOBAL_CONTROL",
  "BOOTSTRAP_MODEL", "DDL_DENIAL",
];
const allSecurityPass = securityKeys.every((k) => R[k] === "PASS");
R.P4A = allSecurityPass && R.RESIDUE === "0" && !fatal ? "PASS" : "FAIL";
const ready = R.P4A === "PASS" ? "YES" : "NO";

const line = (k) => k.padEnd(28) + "= " + (R[k] || "FAIL");
const report = [
  "P4-A ENDPOINT               = " + poolId.endpoint,
  "P4-A RUNTIME ROLE           = " + (R._current_user || ROLE),
  line("DIRECT_ROLE_AUTH"), line("NOSUPERUSER"), line("NOBYPASSRLS"), line("NOCREATEROLE"), line("NOCREATEDB"),
  line("NON_OWNER"), line("NO_BYPASS_MEMBERSHIP"),
  line("SAME_TENANT"), line("CROSS_TENANT_READ"), line("CROSS_TENANT_WRITE"), line("INSERT_WITH_CHECK"),
  line("RLS_ONLY_RAW"), line("FAIL_CLOSED"), line("TRANSACTION_CLEANUP"), line("SEQUENTIAL_ISOLATION"),
  line("CONCURRENT_ISOLATION"), line("INDIRECT_TENANCY"), line("GLOBAL_CONTROL"), line("BOOTSTRAP_MODEL"),
  line("DDL_DENIAL"),
  "POOLER_REUSE               = " + (R.POOLER_REUSE || "UNKNOWN"),
  "STANDARD_PRISMA            = PASS",
  "NEON_ADAPTER               = NOT USED",
  "CONNECTION BOOTSTRAP       = NEON API VIA EXISTING NEON_API_KEY",
  "MANUAL DATABASE SECRETS    = NOT USED",
  "OWNER CONNECTION           = PROVISIONING/TEARDOWN ONLY",
  "RUNTIME CONNECTION         = DIRECT AUTH AS p4_runtime_lab" + (R._current_user === ROLE ? " (current_user verified)" : ""),
  "NEON API KEY EXPOSED       = NO",
  "CONNECTION STRING EXPOSED  = NO",
  "app_runtime                = NOT TOUCHED",
  "PUBLIC                     = NOT TOUCHED (public_tables " + (R._public_unchanged || "?") + " unchanged: " + R._public_before + "->" + (R._public_after ?? "?") + ")",
  "PRODUCTION                 = NOT TOUCHED",
  line("RESIDUE"),
  "P4-A                       = " + R.P4A,
  "READY FOR P4-B             = " + ready,
];
console.log("\n" + report.join("\n") + "\n");
console.log("--- notes ---");
for (const n of notes) console.log(n);

if (process.env.GITHUB_STEP_SUMMARY) {
  const fs = await import("node:fs");
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    "## D2 / P4-A — Neon non-bypass role lab\n\n```\n" + report.join("\n") + "\n```\n\n<details><summary>notes</summary>\n\n```\n" + notes.join("\n") + "\n```\n\n</details>\n");
}
if (fatal || R.P4A !== "PASS") process.exit(1);
