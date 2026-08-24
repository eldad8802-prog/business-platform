/**
 * D2 / P7-W2-GATE-IMPL-1 — admin read foundation battery.
 *
 * Targets (BATTERY_TARGET):
 *   pg   — ephemeral postgres:17: full provision (tenant lab substrate, admin
 *          group+login roles, canonical migration, grants), the complete proof
 *          matrix, ROLLBACK PROOF, re-apply, cleanup.
 *   neon — Neon Preview branch: drift gates (pilot ×5, wave1 ×13, runtime
 *          posture), create-once admin login role (password rotate-only),
 *          canonical migration + grants via owner, same proof matrix against
 *          the REAL substrate, cleanup. Substrate persists on PASS.
 *
 * Proves: additive p7adm_read gives app_admin cross-tenant SELECT on the two
 * starter RLS tables while tenant isolation is bit-for-bit unchanged; admin
 * writes to tenant tables are denied; the one approved admin write
 * (PlatformAuditEvent) works; the REAL platform-admin/audit route runs on the
 * sanctioned admin client under canonical fail-closed auth; targeted admin
 * writes go through the tenant runtime role + explicit target context; loud
 * failure modes. Secrets never printed. Synthetic p7w2g-* fixtures only.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const TARGET = process.env.BATTERY_TARGET === "neon" ? "neon" : "pg";
const ADMIN_LOGIN = process.env.ADMIN_LOGIN_ROLE || (TARGET === "neon" ? "app_admin_preview" : "app_admin_lab");
const ADMIN_PW = process.env.W2G_ADMIN_PW || "p7w2g_ci_synthetic_admin_pw";
const RUNTIME_URL = process.env.RUNTIME_URL;
const MARK = "p7w2g-";

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
async function expectThrow(name, fn, patterns = []) {
  try { await fn(); ok(name, false, "no error thrown"); }
  catch (e) {
    const msg = [e?.message, e?.meta?.message, e?.code, String(e)].filter(Boolean).join(" | ");
    const matched = patterns.length === 0 || patterns.some((p) => msg.includes(p));
    ok(name, matched, matched ? "" : `unexpected error: ${msg.slice(0, 180)}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assertEndpointSafety(url, label) {
  for (const bad of ["ep-flat-brook-am4bhq1y", "ep-winter-bread-ami5o8p5"]) {
    if (url.includes(bad)) throw new Error(`DENY: ${label} forbidden endpoint`);
  }
  if (TARGET === "neon" && !url.includes("ep-wispy-dawn-amr74bwz")) {
    throw new Error(`DENY: ${label} is not the approved Preview endpoint`);
  }
}

/** Split SQL into statements, keeping $$-quoted (DO) blocks atomic. */
function splitSql(sql) {
  const out = [];
  let buf = "";
  let inDollar = false;
  for (const line of sql.split("\n")) {
    const stripped = line.replace(/--.*$/, "");
    const dollarCount = (stripped.match(/\$\$/g) || []).length;
    if (dollarCount % 2 === 1) inDollar = !inDollar;
    buf += line + "\n";
    if (!inDollar && /;\s*$/.test(stripped)) {
      const stmt = buf.replace(/^\s*--.*$/gm, "").trim();
      if (stmt) out.push(stmt.replace(/;\s*$/, ""));
      buf = "";
    }
  }
  const tail = buf.replace(/^\s*--.*$/gm, "").trim();
  if (tail) out.push(tail);
  return out;
}

async function main() {
  if (!process.env.DIRECT_URL) throw new Error("DIRECT_URL missing");
  if (!RUNTIME_URL) throw new Error("RUNTIME_URL missing");
  assertEndpointSafety(process.env.DIRECT_URL, "DIRECT_URL");
  assertEndpointSafety(RUNTIME_URL, "RUNTIME_URL");

  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  await owner.$queryRaw`SELECT 1`;
  console.log(`[battery] target=${TARGET} adminLogin=${ADMIN_LOGIN}`);

  const applySqlFile = async (path, loginRole = null) => {
    let sql = readFileSync(path, "utf8");
    if (loginRole) sql = sql.replaceAll(":LOGIN_ROLE", loginRole);
    const statements = splitSql(sql);
    for (const stmt of statements) await owner.$executeRawUnsafe(stmt);
    return statements.length;
  };

  // ---------- Phase 1: pre-state + drift gates ----------
  const prePol = await owner.$queryRawUnsafe(
    `SELECT tablename, policyname FROM pg_policies WHERE tablename IN ('Conversation','BillingDocument')`
  );
  const unexpected = prePol.filter((r) => !["p4b_tenant", "p7adm_read"].includes(r.policyname));
  if (unexpected.length > 0) {
    throw new Error(`DRIFT: unexpected policies on starter tables: ${JSON.stringify(unexpected)} — STOP`);
  }
  if (TARGET === "neon") {
    const pilot = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p4b_tenant'`))[0].c);
    if (pilot !== 5) throw new Error(`DRIFT: pilot p4b_tenant=${pilot}, expected 5 — STOP`);
    const w1 = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w1_tenant'`))[0].c);
    if (w1 !== 13) throw new Error(`DRIFT: wave1 p7w1_tenant=${w1}, expected 13 — STOP`);
    const rt = (await owner.$queryRawUnsafe(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='app_runtime_preview_p4b'`))[0];
    if (!rt || rt.rolsuper || rt.rolbypassrls) throw new Error("DRIFT: tenant runtime role posture — STOP");
    console.log("[pre-state] pilot=5, wave1=13, tenant runtime posture OK");
  }

  // ---------- Phase 2 (pg only): tenant lab substrate ----------
  const RT_ROLE = TARGET === "pg" ? "wave1_runtime" : "app_runtime_preview_p4b";
  if (TARGET === "pg") {
    const rtExists = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_roles WHERE rolname='${RT_ROLE}'`))[0].c) > 0;
    if (!rtExists) {
      await owner.$executeRawUnsafe(`CREATE ROLE ${RT_ROLE} LOGIN PASSWORD 'p7w1_ci_synthetic_pw' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT`);
    }
    await owner.$executeRawUnsafe(`GRANT SELECT ON "User", "Business" TO ${RT_ROLE}`);
    await owner.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON "Customer" TO ${RT_ROLE}`);
    await owner.$executeRawUnsafe(`GRANT USAGE, SELECT ON SEQUENCE "Customer_id_seq" TO ${RT_ROLE}`);
    await owner.$executeRawUnsafe(`GRANT SELECT ON "Conversation", "BillingDocument" TO ${RT_ROLE}`);
    // Pilot-equivalent tenant policies + FORCE on the two starter tables + Customer.
    for (const t of ["Conversation", "BillingDocument", "Customer"]) {
      await owner.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
      await owner.$executeRawUnsafe(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
      await owner.$executeRawUnsafe(`DROP POLICY IF EXISTS p4b_tenant ON "${t}"`);
      await owner.$executeRawUnsafe(
        `CREATE POLICY p4b_tenant ON "${t}" USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int) WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)`
      );
    }
    // A tenant-RLS'd table the admin group is NOT granted (loud-deny proof).
    await owner.$executeRawUnsafe(`ALTER TABLE "Task" ENABLE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`ALTER TABLE "Task" FORCE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`DROP POLICY IF EXISTS p7w1_tenant ON "Task"`);
    await owner.$executeRawUnsafe(
      `CREATE POLICY p7w1_tenant ON "Task" USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int) WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)`
    );
  }

  // ---------- Phase 3: admin login role (create-once, rotate-only) ----------
  const adminExists = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_roles WHERE rolname='${ADMIN_LOGIN}'`))[0].c) > 0;
  if (!adminExists) {
    await owner.$executeRawUnsafe(
      `CREATE ROLE ${ADMIN_LOGIN} LOGIN PASSWORD '${ADMIN_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION INHERIT`
    );
    console.log(`[roles] created login role ${ADMIN_LOGIN} (create-once)`);
  } else {
    await owner.$executeRawUnsafe(`ALTER ROLE ${ADMIN_LOGIN} LOGIN PASSWORD '${ADMIN_PW}'`);
    console.log(`[roles] ${ADMIN_LOGIN} exists — password rotated only (OID preserved)`);
  }

  // ---------- Phase 4: canonical migration + per-env grants ----------
  const nMig = await applySqlFile("prisma/migrations/20260825090000_d2_p7_w2gate_admin_read/migration.sql");
  const nGrants = await applySqlFile("scripts/security/d2-p7-w2gate-admin-grants.sql", ADMIN_LOGIN);
  console.log(`[apply] migration statements=${nMig} grant statements=${nGrants}`);

  // Posture proofs (owner-verified).
  const grp = (await owner.$queryRawUnsafe(`SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname='app_admin'`))[0];
  ok("app_admin group: NOLOGIN + no super/bypass/create", grp && !grp.rolcanlogin && !grp.rolsuper && !grp.rolbypassrls && !grp.rolcreaterole && !grp.rolcreatedb, JSON.stringify(grp));
  const lg = (await owner.$queryRawUnsafe(`SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit FROM pg_roles WHERE rolname='${ADMIN_LOGIN}'`))[0];
  ok("admin login role posture (LOGIN, INHERIT, NOBYPASSRLS)", lg && lg.rolcanlogin && lg.rolinherit && !lg.rolsuper && !lg.rolbypassrls && !lg.rolcreaterole && !lg.rolcreatedb, JSON.stringify(lg));
  const owns = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_tables WHERE tableowner IN ('app_admin','${ADMIN_LOGIN}')`))[0].c);
  ok("admin roles own zero tables", owns === 0, `owns=${owns}`);
  const memb = Number((await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='${ADMIN_LOGIN}' AND g.rolname='app_admin'`
  ))[0].c);
  ok("login role is member of app_admin", memb === 1);
  const ns = Number((await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid JOIN pg_roles r ON r.oid=m.member WHERE r.rolname IN ('app_admin','${ADMIN_LOGIN}') AND g.rolname='neon_superuser'`
  ))[0].c);
  ok("no neon_superuser membership", ns === 0, `found ${ns}`);
  const admPol = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7adm_read'`))[0].c);
  ok("2 additive p7adm_read policies installed", admPol === 2, `found ${admPol}`);

  // ---------- Phase 5: fixtures ----------
  const cleanup = async () => {
    const bids = `SELECT id FROM "Business" WHERE name LIKE '${MARK}%'`;
    await owner.$executeRawUnsafe(`DELETE FROM "PlatformAuditEvent" WHERE "actorUserId" IN (SELECT id FROM "User" WHERE email LIKE '%@p7w2g.test') OR action LIKE '${MARK}%'`);
    for (const t of ["Conversation", "BillingDocument", "Customer", "Task"]) {
      await owner.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "businessId" IN (${bids})`);
    }
    await owner.$executeRawUnsafe(`DELETE FROM "User" WHERE email LIKE '%@p7w2g.test'`);
    await owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE name LIKE '${MARK}%'`);
  };
  await cleanup();

  const bizA = await owner.business.create({ data: { name: `${MARK}A` } });
  const bizB = await owner.business.create({ data: { name: `${MARK}B` } });
  const adminUser = await owner.user.create({ data: { email: "admin@p7w2g.test", password: "x", businessId: bizA.id, role: "PLATFORM_ADMIN" } });
  const otherAdmin = await owner.user.create({ data: { email: "admin2@p7w2g.test", password: "x", businessId: bizA.id, role: "PLATFORM_ADMIN" } });
  const normalUser = await owner.user.create({ data: { email: "user@p7w2g.test", password: "x", businessId: bizB.id, role: "USER" } });
  const custA = await owner.customer.create({ data: { businessId: bizA.id, name: `${MARK}cust-A` } });
  const custB = await owner.customer.create({ data: { businessId: bizB.id, name: `${MARK}cust-B` } });
  await owner.conversation.create({ data: { businessId: bizA.id, channel: "WHATSAPP" } });
  await owner.conversation.create({ data: { businessId: bizB.id, channel: "WHATSAPP" } });
  // Raw inserts + narrow selects for BillingDocument: the Preview branch DB
  // lags some additive main migrations (e.g. signedPdf* columns), and a full
  // Prisma model row would P2022. The battery only needs (id, businessId).
  await owner.$executeRawUnsafe(
    `INSERT INTO "BillingDocument" ("businessId","documentType","updatedAt") VALUES (${bizA.id},'TAX_INVOICE',now()),(${bizB.id},'TAX_INVOICE',now())`
  );
  await owner.task.create({ data: { businessId: bizA.id, title: `${MARK}task` } });
  await owner.platformAuditEvent.create({ data: { actorUserId: adminUser.id, action: `${MARK}seed-1` } });
  await owner.platformAuditEvent.create({ data: { actorUserId: adminUser.id, action: `${MARK}seed-2` } });
  console.log(`[fixtures] A=${bizA.id} B=${bizB.id}`);

  // ---------- Phase 6: connections ----------
  const rtUrl = new URL(RUNTIME_URL);
  const adminUrlObj = new URL(RUNTIME_URL);
  adminUrlObj.username = ADMIN_LOGIN;
  adminUrlObj.password = ADMIN_PW;
  const ADMIN_URL = adminUrlObj.toString();

  const rt = new PrismaClient({ datasourceUrl: RUNTIME_URL });
  for (let i = 0; i < 6; i++) { try { await rt.$queryRaw`SELECT 1`; break; } catch (e) { if (i === 5) throw e; await sleep(2000); } }
  const adm = new PrismaClient({ datasourceUrl: ADMIN_URL });
  for (let i = 0; i < 6; i++) { try { await adm.$queryRaw`SELECT 1`; break; } catch (e) { if (i === 5) throw e; await sleep(2000); } }

  const rtWho = (await rt.$queryRawUnsafe(`SELECT current_user::text AS u`))[0].u;
  ok(`tenant runtime connects as ${RT_ROLE}`, rtWho === RT_ROLE, `current_user=${rtWho}`);
  const admWho = (await adm.$queryRawUnsafe(`SELECT current_user::text AS u`))[0].u;
  ok(`admin connects as ${ADMIN_LOGIN}`, admWho === ADMIN_LOGIN, `current_user=${admWho}`);

  const rtx = (client, businessId, fn) =>
    client.$transaction(async (t) => {
      if (businessId != null) {
        await t.$queryRaw`SELECT set_config('app.current_business_id', ${String(businessId)}, true)`;
      }
      return fn(t);
    });

  // ---------- Phase 7: proof matrix ----------
  console.log("--- tenant isolation unchanged ---");
  const tConv = await rtx(rt, bizA.id, (t) => t.conversation.findMany({ where: { businessId: { in: [bizA.id, bizB.id] } } }));
  ok("tenant role sees only A conversations", tConv.length === 1 && tConv[0].businessId === bizA.id, `got ${tConv.length}`);
  const tNoCtx = await rt.conversation.findMany({ where: { businessId: { in: [bizA.id, bizB.id] } } });
  ok("tenant role without context sees zero", tNoCtx.length === 0);

  console.log("--- admin global read (A+B) ---");
  const aConv = await adm.conversation.findMany({ where: { businessId: { in: [bizA.id, bizB.id] } } });
  ok("admin reads Conversation across tenants", aConv.length === 2, `got ${aConv.length}`);
  const aBill = await adm.billingDocument.findMany({
    where: { businessId: { in: [bizA.id, bizB.id] } },
    select: { id: true, businessId: true },
  });
  ok("admin reads BillingDocument across tenants", aBill.length === 2, `got ${aBill.length}`);
  const aUsers = await adm.user.findMany({ where: { email: { endsWith: "@p7w2g.test" } } });
  ok("admin reads User (bootstrap-global)", aUsers.length === 3, `got ${aUsers.length}`);
  const aBiz = await adm.business.findMany({ where: { name: { startsWith: MARK } } });
  ok("admin reads Business (bootstrap-global)", aBiz.length === 2);
  await adm.platformFeaturePolicy.findMany({ take: 1 });
  ok("admin reads PlatformFeaturePolicy (global config)", true);
  const rawAdm = await adm.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "Conversation" WHERE "businessId" IN (${bizA.id},${bizB.id})`);
  ok("raw SQL as admin follows same policy (A+B)", Number(rawAdm[0].c) === 2, `got ${rawAdm[0].c}`);

  console.log("--- admin denials (loud, not silent) ---");
  await expectThrow("admin UPDATE on Conversation denied (42501)", () =>
    adm.conversation.updateMany({ where: { businessId: bizA.id }, data: { status: "CLOSED" } }), ["permission denied", "42501"]);
  await expectThrow("admin DELETE on BillingDocument denied", () =>
    adm.billingDocument.deleteMany({ where: { businessId: bizA.id } }), ["permission denied", "42501"]);
  await expectThrow("admin UPDATE on Customer denied (no grant)", () =>
    adm.customer.updateMany({ where: { businessId: bizA.id }, data: { name: "evil" } }), ["permission denied", "42501"]);
  await expectThrow("admin read of ungranted RLS table (Task) = permission denied, not zero", () =>
    adm.task.findMany({}), ["permission denied", "42501"]);
  await expectThrow("admin DDL denied", () => adm.$executeRawUnsafe(`CREATE TABLE p7w2g_evil (id int)`), ["permission denied", "42501"]);
  await expectThrow("admin _prisma_migrations denied", () =>
    adm.$queryRawUnsafe(`SELECT count(*) FROM _prisma_migrations`), ["permission denied", "does not exist", "42501", "42P01"]);

  console.log("--- approved admin write: PlatformAuditEvent ---");
  const auditIns = await adm.platformAuditEvent.create({ data: { actorUserId: adminUser.id, action: `${MARK}admin-write` } });
  ok("admin INSERT PlatformAuditEvent allowed", auditIns.id > 0);
  const auditCount = await adm.platformAuditEvent.count({ where: { action: { startsWith: MARK } } });
  ok("admin SELECT PlatformAuditEvent allowed (global aggregate != 0)", auditCount === 3, `got ${auditCount}`);

  console.log("--- concurrent tenant/admin sessions ---");
  const [cT, cA] = await Promise.all([
    rtx(rt, bizA.id, async (t) => { await t.$executeRawUnsafe("SELECT pg_sleep(0.05)"); return t.conversation.findMany({ where: { businessId: { in: [bizA.id, bizB.id] } } }); }),
    (async () => { await adm.$executeRawUnsafe("SELECT pg_sleep(0.02)"); return adm.conversation.findMany({ where: { businessId: { in: [bizA.id, bizB.id] } } }); })(),
  ]);
  ok("concurrent: tenant saw only A", cT.length === 1 && cT[0].businessId === bizA.id);
  ok("concurrent: admin saw A+B", cA.length === 2);
  const admAfter = await adm.conversation.count({ where: { businessId: { in: [bizA.id, bizB.id] } } });
  ok("no GUC/role contamination after concurrency", admAfter === 2);

  // ---------- Phase 8: real-code paths (env-dependent imports) ----------
  console.log("--- loud failure: ADMIN_DATABASE_URL missing ---");
  delete process.env.ADMIN_DATABASE_URL;
  const { getPrismaAdmin } = await import("@/lib/prisma-admin");
  await expectThrow("getPrismaAdmin throws without ADMIN_DATABASE_URL", async () => getPrismaAdmin(), ["ADMIN_DATABASE_URL is not configured"]);

  process.env.ADMIN_DATABASE_URL = ADMIN_URL;
  process.env.DATABASE_URL = RUNTIME_URL; // canonical tenant singleton -> runtime role
  globalThis.prismaAdmin = undefined;
  const sanctioned = getPrismaAdmin();
  const sWho = (await sanctioned.$queryRawUnsafe(`SELECT current_user::text AS u`))[0].u;
  ok(`sanctioned admin client current_user = ${ADMIN_LOGIN}`, sWho === ADMIN_LOGIN, `got ${sWho}`);

  console.log("--- targeted admin write (runtime role + explicit target context) ---");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { withTenantTransaction } = await import("@/lib/tenant/transaction");
  const targetWrite = await runWithTenantContext({ businessId: bizA.id }, () =>
    withTenantTransaction((tx) =>
      tx.customer.updateMany({ where: { id: custA.id, businessId: bizA.id }, data: { name: `${MARK}cust-A-renamed` } })
    )
  );
  ok("targeted write to A succeeded", targetWrite.count === 1);
  const bUntouched = await owner.customer.findUnique({ where: { id: custB.id } });
  ok("B untouched by targeted write (owner verify)", bUntouched?.name === `${MARK}cust-B`);
  await expectThrow("targeted write without tenant context fails closed", () =>
    withTenantTransaction((tx) => tx.customer.updateMany({ where: { id: custA.id }, data: { name: "evil" } })),
    ["no tenant context"]);

  console.log("--- REAL platform-admin/audit route (canonical auth + admin client) ---");
  const { NextRequest } = await import("next/server");
  const { signAuthToken } = await import("@/lib/auth-token");
  const auditRoute = await import("@/app/api/platform-admin/audit/route");
  const call = async (token) => auditRoute.GET(new NextRequest("http://p7w2g.local/api/platform-admin/audit?limit=30", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }));

  process.env.PLATFORM_ADMIN_EMAILS = "admin@p7w2g.test";
  let res = await call(signAuthToken(adminUser.id));
  const body = res.status === 200 ? await res.json() : null;
  ok("allowlisted PLATFORM_ADMIN -> 200", res.status === 200, `status=${res.status}`);
  ok("audit list is admin-visible, not silent-zero", (body?.pagination?.total ?? 0) >= 3, `total=${body?.pagination?.total}`);
  const appended = await owner.platformAuditEvent.count({ where: { actorUserId: adminUser.id, action: "PLATFORM_ADMIN_AUDIT_VIEWED" } });
  ok("route appended AUDIT_VIEWED via admin role", appended >= 1, `found ${appended}`);

  res = await call(signAuthToken(otherAdmin.id));
  ok("PLATFORM_ADMIN not in allowlist -> 403", res.status === 403, `status=${res.status}`);
  res = await call(signAuthToken(normalUser.id));
  ok("ordinary USER -> 403", res.status === 403, `status=${res.status}`);
  process.env.PLATFORM_ADMIN_EMAILS = "";
  res = await call(signAuthToken(adminUser.id));
  ok("empty allowlist -> 403 (fail closed)", res.status === 403, `status=${res.status}`);
  res = await call(null);
  ok("no token -> 401", res.status === 401, `status=${res.status}`);
  process.env.PLATFORM_ADMIN_EMAILS = "admin@p7w2g.test";

  await rt.$disconnect(); await adm.$disconnect();

  // ---------- Phase 9 (pg only): rollback proof + re-apply ----------
  if (TARGET === "pg") {
    console.log("--- rollback proof ---");
    await applySqlFile("scripts/security/d2-p7-w2gate-admin-rollback.sql", ADMIN_LOGIN);
    const polAfter = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7adm_read'`))[0].c);
    ok("rollback: 0 p7adm_read policies remain", polAfter === 0, `found ${polAfter}`);
    const canSel = (await owner.$queryRawUnsafe(`SELECT has_table_privilege('app_admin', '"Conversation"', 'SELECT') AS p`))[0].p;
    ok("rollback: admin grants revoked", canSel === false);
    const tenantPol = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p4b_tenant' AND tablename IN ('Conversation','BillingDocument')`))[0].c);
    ok("rollback: tenant policies intact", tenantPol === 2, `found ${tenantPol}`);
    await applySqlFile("prisma/migrations/20260825090000_d2_p7_w2gate_admin_read/migration.sql");
    await applySqlFile("scripts/security/d2-p7-w2gate-admin-grants.sql", ADMIN_LOGIN);
    const polRe = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7adm_read'`))[0].c);
    ok("re-apply after rollback (idempotency)", polRe === 2, `found ${polRe}`);
  }

  // ---------- Phase 10: cleanup + integrity ----------
  await cleanup();
  const residue = await owner.$queryRawUnsafe(
    `SELECT (SELECT count(*)::int FROM "Business" WHERE name LIKE '${MARK}%') AS biz,
            (SELECT count(*)::int FROM "User" WHERE email LIKE '%@p7w2g.test') AS usr,
            (SELECT count(*)::int FROM "PlatformAuditEvent" WHERE action LIKE '${MARK}%') AS aud`
  );
  ok("synthetic residue = 0", Number(residue[0].biz) === 0 && Number(residue[0].usr) === 0 && Number(residue[0].aud) === 0, JSON.stringify(residue[0]));

  if (TARGET === "neon") {
    const pilotAfter = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p4b_tenant'`))[0].c);
    const w1After = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w1_tenant'`))[0].c);
    ok("pilot + wave1 substrate intact after admin foundation", pilotAfter === 5 && w1After === 13, `pilot=${pilotAfter} w1=${w1After}`);
  }

  await owner.$disconnect();
  console.log(`\n[battery] target=${TARGET} PASS=${pass} FAIL=${fail}`);
  if (fail > 0) { console.log("FAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
  console.log("ALL CHECKS PASS");
}

main().catch(async (e) => {
  const { inspect } = await import("node:util");
  console.error("[battery] FATAL:", inspect(e, { depth: 4 }).slice(0, 2000));
  process.exit(1);
});
