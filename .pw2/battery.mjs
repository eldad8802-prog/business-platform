/**
 * D2 / PRIVILEGED-WRITE-2 — BusinessFeatureAccess control-plane battery.
 *
 * Targets (BATTERY_TARGET):
 *   pg    ephemeral PG17 lab — full apply, matrix, rollback, re-apply
 *   neon  Preview — drift gates, apply, matrix as the real runtime/admin/ctl roles
 *
 * What this proves is not "a policy exists". It is that the ONLY way to change a
 * business's entitlements is an authorized platform-admin action running as the
 * dedicated control-plane role inside a transaction that has explicitly named
 * its target — and that every other combination is denied by the database:
 *
 *   tenant runtime  -> may read its own row, may never write any row
 *   app_admin       -> may read every row, may never write any row
 *   control plane   -> may write ONLY the business named by the GUC, only this
 *                      one table, never DELETE, and never anything else
 *
 * It also proves the three dormant defects the architecture phase identified are
 * actually fixed: the fail-open resolver, the fail-silent admin read, and the
 * false-success audit.
 *
 * VERIFY_ONLY=1: read-only substrate verification (no fixtures, no mutations).
 * Synthetic pw2-* fixtures only. ZERO real customer data. ZERO network.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  ADMIN_PW,
  ADMIN_ROLE,
  CTL_PW,
  CTL_ROLE,
  FEATURE_KEYS,
  MARK,
  RT_PW,
  RT_ROLE,
  TARGET,
  assertEndpointSafety,
  splitSql,
} from "./shared.mjs";

const VERIFY_ONLY = process.env.PW2_VERIFY_ONLY === "1";
const MIGRATION = "prisma/migrations/20260901090000_d2_pw2_business_feature_access_rls/migration.sql";
const GRANTS = "scripts/security/d2-pw2-grants.sql";
const ROLLBACK = "scripts/security/d2-pw2-rollback.sql";
const TABLE = "BusinessFeatureAccess";

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

async function throws(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

function roleUrl(base, user, pw) {
  const u = new URL(base);
  u.username = user;
  u.password = pw;
  return u.toString();
}

/** Run `fn` inside a transaction on `client`, optionally setting the tenant GUC. */
function tx(client, businessId, fn) {
  return client.$transaction(async (t) => {
    if (businessId != null) {
      await t.$queryRaw`SELECT set_config('app.current_business_id', ${String(
        businessId
      )}, true)`;
    }
    return fn(t);
  });
}

async function main() {
  const OWNER_URL = process.env.DIRECT_URL;
  if (!OWNER_URL) throw new Error("DIRECT_URL missing");
  assertEndpointSafety(OWNER_URL, "DIRECT_URL");

  const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
  await owner.$queryRaw`SELECT 1`;
  console.log(
    `[battery] target=${TARGET} runtime=${RT_ROLE} admin=${ADMIN_ROLE} ctl=${CTL_ROLE} verify_only=${VERIFY_ONLY}`
  );

  const applySqlFile = async (path, repl = {}) => {
    let sql = readFileSync(path, "utf8");
    for (const [k, v] of Object.entries(repl)) sql = sql.replaceAll(k, v);
    for (const stmt of splitSql(sql)) await owner.$executeRawUnsafe(stmt);
  };

  const policyNames = async () =>
    (
      await owner.$queryRawUnsafe(
        `SELECT policyname FROM pg_policies WHERE tablename='${TABLE}' ORDER BY policyname`
      )
    ).map((r) => r.policyname);

  const rlsFlags = async () => {
    const r = await owner.$queryRawUnsafe(
      `SELECT relrowsecurity AS e, relforcerowsecurity AS f FROM pg_class WHERE relname='${TABLE}'`
    );
    return r[0] ?? { e: null, f: null };
  };

  // ── Phase 1: pre-state + drift gates ──────────────────────────────────────
  console.log("--- phase 1: pre-state ---");
  const preForeign = await owner.$queryRawUnsafe(
    `SELECT policyname FROM pg_policies WHERE tablename='${TABLE}'`
  );
  if (!VERIFY_ONLY && preForeign.length > 0) {
    console.log(
      `[pre-state] ${TABLE} already carries policies: ${JSON.stringify(preForeign)} — re-apply is idempotent, continuing`
    );
  }

  if (TARGET === "neon") {
    const gates = [
      ["p4b_tenant", 5],
      ["p7w1_tenant", 14],
      ["p7w2_tenant", 24],
      ["p7w3_tenant", 15],
      ["p7w4b_tenant", 5],
      ["p7w4c_tenant", 3],
      ["p7w4d_tenant", 8],
      ["p7w4ea_tenant", 4],
      ["p7w4eb2_tenant", 8],
    ];
    for (const [pol, want] of gates) {
      const c = Number(
        (
          await owner.$queryRawUnsafe(
            `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='${pol}'`
          )
        )[0].c
      );
      if (c !== want) throw new Error(`DRIFT: ${pol}=${c}, expected ${want} — STOP`);
    }
    // p7adm_read was 10 before this wave and becomes 11 with BusinessFeatureAccess.
    const adm = Number(
      (
        await owner.$queryRawUnsafe(
          `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7adm_read'`
        )
      )[0].c
    );
    if (adm !== 10 && adm !== 11) {
      throw new Error(`DRIFT: p7adm_read=${adm}, expected 10 (pre) or 11 (post) — STOP`);
    }
    for (const role of [RT_ROLE, "app_admin", ADMIN_ROLE]) {
      const r = (
        await owner.$queryRawUnsafe(
          `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='${role}'`
        )
      )[0];
      if (!r || r.rolsuper || r.rolbypassrls) throw new Error(`DRIFT: ${role} posture — STOP`);
    }
    console.log(`[pre-state] prior waves intact, p7adm_read=${adm}, postures OK`);
  }

  if (VERIFY_ONLY) {
    const names = await policyNames();
    const flags = await rlsFlags();
    ok(
      "verify-only: 4 PW-2 policies present",
      ["p7adm_read", "p7pw2_ctl_insert", "p7pw2_ctl_update", "p7pw2_tenant_read"].every((p) =>
        names.includes(p)
      ),
      names.join(",")
    );
    ok("verify-only: ENABLE + FORCE RLS", flags.e === true && flags.f === true, JSON.stringify(flags));
    ok(
      "verify-only: no DELETE policy on the table",
      (
        await owner.$queryRawUnsafe(
          `SELECT count(*)::int AS c FROM pg_policies WHERE tablename='${TABLE}' AND cmd='DELETE'`
        )
      )[0].c === 0
    );
    const g = (
      await owner.$queryRawUnsafe(
        `SELECT has_table_privilege('${RT_ROLE}', '"${TABLE}"', 'SELECT') AS rt_sel,
                has_table_privilege('${RT_ROLE}', '"${TABLE}"', 'UPDATE') AS rt_upd,
                has_table_privilege('${RT_ROLE}', '"${TABLE}"', 'INSERT') AS rt_ins,
                has_table_privilege('${RT_ROLE}', '"${TABLE}"', 'DELETE') AS rt_del,
                has_table_privilege('app_admin', '"${TABLE}"', 'SELECT') AS adm_sel,
                has_table_privilege('app_admin', '"${TABLE}"', 'INSERT') AS adm_ins,
                has_table_privilege('app_admin', '"${TABLE}"', 'UPDATE') AS adm_upd,
                has_table_privilege('app_admin', '"${TABLE}"', 'DELETE') AS adm_del,
                has_table_privilege('app_ctlplane', '"${TABLE}"', 'SELECT') AS ctl_sel,
                has_table_privilege('app_ctlplane', '"${TABLE}"', 'INSERT') AS ctl_ins,
                has_table_privilege('app_ctlplane', '"${TABLE}"', 'UPDATE') AS ctl_upd,
                has_table_privilege('app_ctlplane', '"${TABLE}"', 'DELETE') AS ctl_del`
      )
    )[0];
    ok(
      "verify-only: grant posture (tenant S only, admin S only, ctl SIU, DELETE nowhere)",
      g.rt_sel === true &&
        g.rt_upd === false &&
        g.rt_ins === false &&
        g.rt_del === false &&
        g.adm_sel === true &&
        g.adm_ins === false &&
        g.adm_upd === false &&
        g.adm_del === false &&
        g.ctl_sel === true &&
        g.ctl_ins === true &&
        g.ctl_upd === true &&
        g.ctl_del === false,
      JSON.stringify(g)
    );
    const res = Number(
      (
        await owner.$queryRawUnsafe(
          `SELECT count(*)::int AS c FROM "Business" WHERE name LIKE '${MARK}%'`
        )
      )[0].c
    );
    ok("verify-only: synthetic residue = 0", res === 0, `found ${res}`);
    await owner.$disconnect();
    console.log(`\n[battery] target=${TARGET} mode=verify-only PASS=${pass} FAIL=${fail}`);
    if (fail > 0) {
      console.log("FAILURES:\n - " + failures.join("\n - "));
      process.exit(1);
    }
    console.log("ALL CHECKS PASS");
    return;
  }

  // ── Phase 2: apply migration + grants ─────────────────────────────────────
  console.log("--- phase 2: apply ---");
  await applySqlFile(MIGRATION);
  await applySqlFile(GRANTS, { ":ROLE": RT_ROLE, ":CTL_LOGIN_ROLE": CTL_ROLE });

  const names = await policyNames();
  ok(
    "4 policies installed (tenant_read, adm_read, ctl_insert, ctl_update)",
    ["p7adm_read", "p7pw2_ctl_insert", "p7pw2_ctl_update", "p7pw2_tenant_read"].every((p) =>
      names.includes(p)
    ),
    names.join(",")
  );
  const flags = await rlsFlags();
  ok("ENABLE + FORCE RLS", flags.e === true && flags.f === true, JSON.stringify(flags));
  const delPolicies = Number(
    (
      await owner.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM pg_policies WHERE tablename='${TABLE}' AND cmd='DELETE'`
      )
    )[0].c
  );
  ok("no DELETE policy exists for any role", delPolicies === 0, `found ${delPolicies}`);

  // Idempotency: applying twice must not duplicate or fail.
  await applySqlFile(MIGRATION);
  await applySqlFile(GRANTS, { ":ROLE": RT_ROLE, ":CTL_LOGIN_ROLE": CTL_ROLE });
  ok("migration + grants are idempotent (re-apply clean)", (await policyNames()).length === 4);

  // ── Phase 3: role posture + privilege surface ─────────────────────────────
  console.log("--- phase 3: role posture ---");
  const ctlRole = (
    await owner.$queryRawUnsafe(
      `SELECT rolsuper, rolbypassrls, rolcanlogin, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname='${CTL_ROLE}'`
    )
  )[0];
  ok(
    `${CTL_ROLE}: LOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE`,
    ctlRole &&
      ctlRole.rolcanlogin === true &&
      ctlRole.rolsuper === false &&
      ctlRole.rolbypassrls === false &&
      ctlRole.rolcreatedb === false &&
      ctlRole.rolcreaterole === false,
    JSON.stringify(ctlRole)
  );
  const ctlGroup = (
    await owner.$queryRawUnsafe(
      `SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname='app_ctlplane'`
    )
  )[0];
  ok(
    "app_ctlplane group: NOLOGIN, NOSUPERUSER, NOBYPASSRLS",
    ctlGroup &&
      ctlGroup.rolcanlogin === false &&
      ctlGroup.rolsuper === false &&
      ctlGroup.rolbypassrls === false,
    JSON.stringify(ctlGroup)
  );
  const ctlOwns = Number(
    (
      await owner.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM pg_class c JOIN pg_roles r ON c.relowner=r.oid
         WHERE r.rolname IN ('app_ctlplane','${CTL_ROLE}')`
      )
    )[0].c
  );
  ok("control-plane roles own no relation", ctlOwns === 0, `owns ${ctlOwns}`);

  const priv = (
    await owner.$queryRawUnsafe(
      `SELECT has_table_privilege('${RT_ROLE}', '"${TABLE}"', 'SELECT') AS rt_sel,
              has_table_privilege('${RT_ROLE}', '"${TABLE}"', 'INSERT') AS rt_ins,
              has_table_privilege('${RT_ROLE}', '"${TABLE}"', 'UPDATE') AS rt_upd,
              has_table_privilege('${RT_ROLE}', '"${TABLE}"', 'DELETE') AS rt_del,
              has_table_privilege('app_admin', '"${TABLE}"', 'SELECT') AS adm_sel,
              has_table_privilege('app_admin', '"${TABLE}"', 'INSERT') AS adm_ins,
              has_table_privilege('app_admin', '"${TABLE}"', 'UPDATE') AS adm_upd,
              has_table_privilege('app_admin', '"${TABLE}"', 'DELETE') AS adm_del,
              has_table_privilege('app_ctlplane', '"${TABLE}"', 'SELECT') AS ctl_sel,
              has_table_privilege('app_ctlplane', '"${TABLE}"', 'INSERT') AS ctl_ins,
              has_table_privilege('app_ctlplane', '"${TABLE}"', 'UPDATE') AS ctl_upd,
              has_table_privilege('app_ctlplane', '"${TABLE}"', 'DELETE') AS ctl_del,
              has_table_privilege('app_ctlplane', '"PlatformAuditEvent"', 'SELECT') AS ctl_audit_sel,
              has_table_privilege('app_ctlplane', '"PlatformAuditEvent"', 'INSERT') AS ctl_audit_ins,
              has_table_privilege('app_ctlplane', '"PlatformAuditEvent"', 'UPDATE') AS ctl_audit_upd,
              has_table_privilege('app_ctlplane', '"PlatformAuditEvent"', 'DELETE') AS ctl_audit_del`
    )
  )[0];
  ok("tenant runtime: SELECT only on the table", priv.rt_sel === true && priv.rt_ins === false && priv.rt_upd === false && priv.rt_del === false, JSON.stringify(priv));
  ok("app_admin: SELECT only on the table (generic admin writes still 0)", priv.adm_sel === true && priv.adm_ins === false && priv.adm_upd === false && priv.adm_del === false);
  ok("control plane: SELECT+INSERT+UPDATE, never DELETE", priv.ctl_sel === true && priv.ctl_ins === true && priv.ctl_upd === true && priv.ctl_del === false);
  ok(
    "control plane: audit is APPEND-ONLY and unreadable (INSERT only; no SELECT/UPDATE/DELETE)",
    priv.ctl_audit_ins === true &&
      priv.ctl_audit_sel === false &&
      priv.ctl_audit_upd === false &&
      priv.ctl_audit_del === false,
    JSON.stringify(priv)
  );

  const ctlOther = await owner.$queryRawUnsafe(
    `SELECT table_name, privilege_type FROM information_schema.role_table_grants
     WHERE grantee='app_ctlplane' AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')
     ORDER BY table_name, privilege_type`
  );
  const allowedWrite = new Set([`${TABLE}|INSERT`, `${TABLE}|UPDATE`, "PlatformAuditEvent|INSERT"]);
  const strayWrites = ctlOther.filter((r) => !allowedWrite.has(`${r.table_name}|${r.privilege_type}`));
  ok(
    "control plane holds NO write privilege outside BusinessFeatureAccess + audit append",
    strayWrites.length === 0,
    JSON.stringify(strayWrites)
  );

  // ── Phase 4: clients ──────────────────────────────────────────────────────
  const RUNTIME_URL = TARGET === "pg" ? roleUrl(OWNER_URL, RT_ROLE, RT_PW) : process.env.RUNTIME_URL;
  const ADMIN_URL = TARGET === "pg" ? roleUrl(OWNER_URL, ADMIN_ROLE, ADMIN_PW) : process.env.ADMIN_URL;
  const CTL_URL = TARGET === "pg" ? roleUrl(OWNER_URL, CTL_ROLE, CTL_PW) : process.env.CTL_URL;
  for (const [u, l] of [[RUNTIME_URL, "RUNTIME_URL"], [ADMIN_URL, "ADMIN_URL"], [CTL_URL, "CTL_URL"]]) {
    if (!u) throw new Error(`${l} missing`);
    assertEndpointSafety(u, l);
  }
  process.env.DATABASE_URL = RUNTIME_URL;
  process.env.ADMIN_DATABASE_URL = ADMIN_URL;
  process.env.CONTROL_PLANE_DATABASE_URL = CTL_URL;

  const rt = new PrismaClient({ datasourceUrl: RUNTIME_URL });
  const adm = new PrismaClient({ datasourceUrl: ADMIN_URL });
  const ctl = new PrismaClient({ datasourceUrl: CTL_URL });
  for (const [c, want] of [[rt, RT_ROLE], [adm, ADMIN_ROLE], [ctl, CTL_ROLE]]) {
    const who = (await c.$queryRawUnsafe("SELECT current_user::text AS u"))[0].u;
    ok(`connected as ${want}`, who === want, `got ${who}`);
  }

  const { updateBusinessFeatureAccess } = await import(
    "@/lib/services/platform-admin/update-business-feature-access.service"
  );
  const { getPlatformAdminBusinessFeatures } = await import(
    "@/lib/services/platform-admin/platform-business-features.service"
  );
  const { resolveBusinessCapabilities } = await import(
    "@/lib/services/feature-access/resolve-feature-access"
  );
  const { runWithTenantContext } = await import("@/lib/tenant/context");

  // ── Phase 5: fixtures ─────────────────────────────────────────────────────
  console.log("--- phase 5: fixtures ---");
  const cleanup = async () => {
    const bids = `SELECT id FROM "Business" WHERE name LIKE '${MARK}%'`;
    await owner.$executeRawUnsafe(
      `DELETE FROM "PlatformAuditEvent" WHERE "targetId" IN (SELECT id::text FROM "Business" WHERE name LIKE '${MARK}%')`
    );
    await owner.$executeRawUnsafe(
      `DELETE FROM "PlatformAuditEvent" WHERE "actorUserId" IN (SELECT id FROM "User" WHERE email LIKE '%@pw2.test')`
    );
    await owner.$executeRawUnsafe(`DELETE FROM "${TABLE}" WHERE "businessId" IN (${bids})`);
    await owner.$executeRawUnsafe(`DELETE FROM "User" WHERE email LIKE '%@pw2.test'`);
    await owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE name LIKE '${MARK}%'`);
  };
  await cleanup();

  const bizA = await owner.business.create({ data: { name: `${MARK}A` } });
  const bizB = await owner.business.create({ data: { name: `${MARK}B` } });
  const adminUser = await owner.user.create({
    data: { email: "admin@pw2.test", password: "x", businessId: bizA.id, role: "PLATFORM_ADMIN" },
  });
  await owner.user.create({ data: { email: "a@pw2.test", password: "x", businessId: bizA.id } });
  await owner.user.create({ data: { email: "b@pw2.test", password: "x", businessId: bizB.id } });
  console.log(`[fixtures] A=${bizA.id} B=${bizB.id} actor=${adminUser.id}`);

  const seedOverride = (businessId, featureKey, state) =>
    owner.businessFeatureAccess.create({
      data: { businessId, featureKey, state, reason: `${MARK}seed`, updatedByUserId: adminUser.id },
    });
  await seedOverride(bizA.id, "documents", "DISABLED");
  await seedOverride(bizB.id, "billing", "DISABLED");

  const bothIds = { in: [bizA.id, bizB.id] };

  // ── Phase 6: tenant read matrix ───────────────────────────────────────────
  console.log("--- phase 6: tenant reads ---");
  const tenantA = await tx(rt, bizA.id, (t) =>
    t.businessFeatureAccess.findMany({ where: { businessId: bothIds } })
  );
  ok(
    "tenant A reads its own override only",
    tenantA.length === 1 && tenantA[0].businessId === bizA.id && tenantA[0].featureKey === "documents",
    `n=${tenantA.length}`
  );
  const tenantB = await tx(rt, bizB.id, (t) =>
    t.businessFeatureAccess.findMany({ where: { businessId: bothIds } })
  );
  ok(
    "tenant B reads its own override only",
    tenantB.length === 1 && tenantB[0].businessId === bizB.id,
    `n=${tenantB.length}`
  );
  const tenantNoCtx = await tx(rt, null, (t) =>
    t.businessFeatureAccess.findMany({ where: { businessId: bothIds } })
  );
  ok("tenant with NO context reads 0 rows (fail-closed)", tenantNoCtx.length === 0, `n=${tenantNoCtx.length}`);
  const tenantBadCtx = await rt.$transaction(async (t) => {
    await t.$queryRaw`SELECT set_config('app.current_business_id', 'not-a-number', true)`;
    return t.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "${TABLE}"`).catch(() => [{ c: -1 }]);
  });
  ok(
    "tenant with MALFORMED context fails closed (0 rows or error, never all rows)",
    Number(tenantBadCtx[0].c) <= 0,
    JSON.stringify(tenantBadCtx)
  );
  const rawTenant = await tx(rt, bizA.id, (t) =>
    t.$queryRawUnsafe(`SELECT "businessId" FROM "${TABLE}"`)
  );
  ok(
    "tenant raw SQL sees own rows only",
    rawTenant.every((r) => r.businessId === bizA.id),
    JSON.stringify(rawTenant)
  );

  // ── Phase 7: tenant write denial ──────────────────────────────────────────
  console.log("--- phase 7: tenant writes denied ---");
  for (const [label, fn] of [
    ["INSERT", (t) => t.businessFeatureAccess.create({ data: { businessId: bizA.id, featureKey: "inbox", state: "ENABLED" } })],
    ["UPDATE", (t) => t.businessFeatureAccess.updateMany({ where: { businessId: bizA.id }, data: { state: "ENABLED" } })],
    ["DELETE", (t) => t.businessFeatureAccess.deleteMany({ where: { businessId: bizA.id } })],
    ["self-enable own feature", (t) => t.businessFeatureAccess.create({ data: { businessId: bizA.id, featureKey: "revenue", state: "ENABLED" } })],
  ]) {
    const e = await throws(() => tx(rt, bizA.id, fn));
    ok(`tenant ${label} on its own business is denied`, e !== null, e ? "" : "no error thrown");
  }
  const stillOne = await owner.businessFeatureAccess.count({ where: { businessId: bizA.id } });
  ok("tenant write attempts changed nothing", stillOne === 1, `rows=${stillOne}`);

  // ── Phase 8: admin read matrix ────────────────────────────────────────────
  console.log("--- phase 8: admin reads ---");
  const admAll = await adm.businessFeatureAccess.findMany({ where: { businessId: bothIds } });
  ok("app_admin reads across tenants (A + B)", admAll.length === 2, `n=${admAll.length}`);
  for (const [label, fn] of [
    ["INSERT", () => adm.businessFeatureAccess.create({ data: { businessId: bizA.id, featureKey: "inbox", state: "ENABLED" } })],
    ["UPDATE", () => adm.businessFeatureAccess.updateMany({ where: { businessId: bizA.id }, data: { state: "ENABLED" } })],
    ["DELETE", () => adm.businessFeatureAccess.deleteMany({ where: { businessId: bizA.id } })],
  ]) {
    const e = await throws(fn);
    ok(`app_admin ${label} denied (read-only doctrine intact)`, e !== null, e ? "" : "no error thrown");
  }

  // ── Phase 9: control-plane write matrix (the core proof) ─────────────────
  console.log("--- phase 9: control-plane writes ---");
  const ctlUpd = await tx(ctl, bizA.id, (t) =>
    t.businessFeatureAccess.updateMany({
      where: { businessId: bizA.id, featureKey: "documents" },
      data: { reason: `${MARK}ctl-a` },
    })
  );
  ok("ctl with GUC=A updates A", ctlUpd.count === 1, `count=${ctlUpd.count}`);

  const ctlUpdB = await tx(ctl, bizB.id, (t) =>
    t.businessFeatureAccess.updateMany({
      where: { businessId: bizB.id, featureKey: "billing" },
      data: { reason: `${MARK}ctl-b` },
    })
  );
  ok("ctl with GUC=B updates B (cross-tenant IS the legitimate feature)", ctlUpdB.count === 1);

  const ctlCross = await tx(ctl, bizA.id, (t) =>
    t.businessFeatureAccess.updateMany({
      where: { businessId: bizB.id },
      data: { reason: `${MARK}should-not-happen` },
    })
  );
  ok("ctl with GUC=A cannot update B's row", ctlCross.count === 0, `count=${ctlCross.count}`);

  const ctlBroad = await tx(ctl, bizA.id, (t) =>
    t.businessFeatureAccess.updateMany({ where: {}, data: { reason: `${MARK}broad` } })
  );
  const bRow = await owner.businessFeatureAccess.findFirst({ where: { businessId: bizB.id } });
  ok(
    "ctl UPDATE with NO business predicate affects only the GUC business (blast-radius lock)",
    ctlBroad.count === 1 && bRow.reason === `${MARK}ctl-b`,
    `count=${ctlBroad.count} bReason=${bRow.reason}`
  );

  const eCheck = await throws(() =>
    tx(ctl, bizA.id, (t) =>
      t.businessFeatureAccess.create({
        data: { businessId: bizB.id, featureKey: "inbox", state: "ENABLED" },
      })
    )
  );
  ok("ctl with GUC=A cannot INSERT a row owned by B (WITH CHECK)", eCheck !== null);

  const eNoGucUpd = await tx(ctl, null, (t) =>
    t.businessFeatureAccess.updateMany({ where: {}, data: { reason: `${MARK}nog` } })
  );
  ok("ctl with NO GUC updates 0 rows", eNoGucUpd.count === 0, `count=${eNoGucUpd.count}`);
  const eNoGucIns = await throws(() =>
    tx(ctl, null, (t) =>
      t.businessFeatureAccess.create({
        data: { businessId: bizA.id, featureKey: "pricing", state: "ENABLED" },
      })
    )
  );
  ok("ctl with NO GUC cannot INSERT (so a context-less write is loud, never silent)", eNoGucIns !== null);

  const eDel = await throws(() =>
    tx(ctl, bizA.id, (t) => t.businessFeatureAccess.deleteMany({ where: { businessId: bizA.id } }))
  );
  ok("ctl DELETE is denied (no grant, no policy)", eDel !== null);

  const ctlRaw = await throws(() =>
    tx(ctl, bizA.id, (t) =>
      t.$executeRawUnsafe(`UPDATE "${TABLE}" SET reason='${MARK}raw' WHERE "businessId"=${bizB.id}`)
    )
  );
  const bAfterRaw = await owner.businessFeatureAccess.findFirst({ where: { businessId: bizB.id } });
  ok(
    "ctl raw SQL cannot reach B under GUC=A",
    bAfterRaw.reason === `${MARK}ctl-b`,
    `err=${ctlRaw ? "threw" : "none"} reason=${bAfterRaw.reason}`
  );

  // ── Phase 10: credential blast radius ─────────────────────────────────────
  console.log("--- phase 10: blast radius ---");
  const blast = [
    ["Customer", () => ctl.$executeRawUnsafe(`INSERT INTO "Customer" ("businessId","name","createdAt","updatedAt") VALUES (${bizA.id},'x',now(),now())`)],
    ["BillingDocument", () => ctl.$executeRawUnsafe(`UPDATE "BillingDocument" SET "updatedAt"=now()`)],
    ["Document", () => ctl.$executeRawUnsafe(`UPDATE "Document" SET "updatedAt"=now()`)],
    ["PaymentRequest", () => ctl.$executeRawUnsafe(`UPDATE "PaymentRequest" SET "updatedAt"=now()`)],
    ["Business", () => ctl.$executeRawUnsafe(`UPDATE "Business" SET name='hacked' WHERE id=${bizB.id}`)],
    ["User", () => ctl.$executeRawUnsafe(`UPDATE "User" SET role='PLATFORM_ADMIN'`)],
    ["PlatformFeaturePolicy", () => ctl.$executeRawUnsafe(`UPDATE "PlatformFeaturePolicy" SET "globalEnabled"=false`)],
    ["PlatformAuditEvent UPDATE", () => ctl.$executeRawUnsafe(`UPDATE "PlatformAuditEvent" SET action='x'`)],
    ["DDL (CREATE TABLE)", () => ctl.$executeRawUnsafe(`CREATE TABLE pw2_evil (id int)`)],
    ["DDL (ALTER)", () => ctl.$executeRawUnsafe(`ALTER TABLE "${TABLE}" DISABLE ROW LEVEL SECURITY`)],
    ["_prisma_migrations", () => ctl.$executeRawUnsafe(`DELETE FROM "_prisma_migrations"`)],
    ["SET ROLE escalation", () => ctl.$executeRawUnsafe(`SET ROLE app_admin`)],
  ];
  for (const [label, fn] of blast) {
    const e = await throws(fn);
    ok(`control-plane credential denied: ${label}`, e !== null, e ? "" : "SUCCEEDED — blast radius breach");
  }
  const bizNameOk = await owner.business.findUnique({ where: { id: bizB.id } });
  ok("blast-radius attempts changed no data", bizNameOk.name === `${MARK}B`, bizNameOk.name);

  // ── Phase 11: real service E2E ────────────────────────────────────────────
  console.log("--- phase 11: service E2E ---");
  const auditCount = () =>
    owner.platformAuditEvent.count({ where: { action: "PLATFORM_FEATURE_ACCESS_UPDATED" } });
  const auditBefore = await auditCount();

  const resA = await updateBusinessFeatureAccess({
    actorUserId: adminUser.id,
    businessId: bizA.id,
    featureKey: "inbox",
    state: "DISABLED",
    reason: "pw2 service e2e disable inbox for A",
  });
  ok("service: platform admin disables a feature for A", resA.changed === true && resA.business.id === bizA.id);
  const rowA = await owner.businessFeatureAccess.findUnique({
    where: { businessId_featureKey: { businessId: bizA.id, featureKey: "inbox" } },
  });
  ok("service: A row written with the right state + actor", rowA?.state === "DISABLED" && rowA?.updatedByUserId === adminUser.id);
  const bTouched = await owner.businessFeatureAccess.count({ where: { businessId: bizB.id } });
  ok("service: B untouched by A's operation", bTouched === 1, `n=${bTouched}`);

  const resB = await updateBusinessFeatureAccess({
    actorUserId: adminUser.id,
    businessId: bizB.id,
    featureKey: "inbox",
    state: "ENABLED",
    reason: "pw2 service e2e enable inbox for B",
  });
  ok("service: same admin targets B (legitimate cross-tenant control-plane action)", resB.business.id === bizB.id);

  const auditAfter = await auditCount();
  ok("service: one audit row per committed mutation", auditAfter - auditBefore === 2, `delta=${auditAfter - auditBefore}`);
  const lastAudit = await owner.platformAuditEvent.findFirst({
    where: { action: "PLATFORM_FEATURE_ACCESS_UPDATED", targetId: String(bizB.id) },
    orderBy: { id: "desc" },
  });
  ok(
    "service: audit records trusted actor + target + feature + before/after",
    lastAudit?.actorUserId === adminUser.id &&
      lastAudit?.targetType === "BUSINESS" &&
      lastAudit?.targetId === String(bizB.id) &&
      lastAudit?.metadata?.featureKey === "inbox" &&
      lastAudit?.metadata?.oldState === "INHERIT" &&
      lastAudit?.metadata?.newState === "ENABLED",
    JSON.stringify(lastAudit?.metadata)
  );

  // ── Phase 12: INHERIT instead of DELETE ───────────────────────────────────
  console.log("--- phase 12: INHERIT ---");
  await updateBusinessFeatureAccess({
    actorUserId: adminUser.id,
    businessId: bizA.id,
    featureKey: "inbox",
    state: "INHERIT",
    reason: "pw2 clear the inbox override for A",
  });
  const inheritRow = await owner.businessFeatureAccess.findUnique({
    where: { businessId_featureKey: { businessId: bizA.id, featureKey: "inbox" } },
  });
  ok("INHERIT is stored as a row state, not a delete", inheritRow?.state === "INHERIT");
  ok("INHERIT keeps the reason + actor of the un-override action", inheritRow?.reason?.includes("clear the inbox override"));

  const noChange = await throws(() =>
    updateBusinessFeatureAccess({
      actorUserId: adminUser.id,
      businessId: bizA.id,
      featureKey: "inbox",
      state: "INHERIT",
      reason: "pw2 repeat the same clear operation",
    })
  );
  ok("replay of an identical operation is a deterministic NO_CHANGE", noChange !== null && String(noChange).includes("NO_CHANGE"), String(noChange));
  const auditAfterReplay = await auditCount();
  ok("rejected replay writes no audit row", auditAfterReplay === auditAfter + 1, `n=${auditAfterReplay}`);

  // ── Phase 13: resolver fail-open regression (dormant defect A) ────────────
  console.log("--- phase 13: resolver ---");
  const capsA = await runWithTenantContext({ businessId: bizA.id }, () =>
    resolveBusinessCapabilities(bizA.id)
  );
  ok(
    "resolver under tenant context: DISABLED override stays DENIED",
    capsA.documents.allowed === false && capsA.documents.reasonCode === "BUSINESS_DISABLED",
    JSON.stringify(capsA.documents)
  );
  ok("resolver under tenant context: INHERIT falls through to catalog", capsA.inbox.allowed === true && capsA.inbox.reasonCode === "CATALOG_DEFAULT");
  const noCtxResolve = await throws(() => resolveBusinessCapabilities(bizA.id));
  ok(
    "resolver WITHOUT tenant context throws (fail-closed) instead of silently allowing",
    noCtxResolve !== null,
    noCtxResolve ? "" : "returned a result — FAIL-OPEN"
  );
  const crossCtx = await runWithTenantContext({ businessId: bizA.id }, () =>
    resolveBusinessCapabilities(bizB.id)
  );
  ok(
    "resolver cannot read another business's overrides even if handed its id",
    crossCtx.billing.allowed === true,
    JSON.stringify(crossCtx.billing)
  );

  // ── Phase 14: admin read regression (dormant defect B) ────────────────────
  console.log("--- phase 14: admin read ---");
  const adminViewA = await getPlatformAdminBusinessFeatures(bizA.id);
  const docItemA = adminViewA.features.find((f) => f.featureKey === "documents");
  ok("admin sees A's real DISABLED override (not a fail-silent blank)", docItemA?.businessOverride === "DISABLED" && docItemA?.allowed === false, JSON.stringify(docItemA?.businessOverride));
  const adminViewB = await getPlatformAdminBusinessFeatures(bizB.id);
  const billItemB = adminViewB.features.find((f) => f.featureKey === "billing");
  ok("admin sees B's real DISABLED override", billItemB?.businessOverride === "DISABLED");
  ok("admin overrideCount reflects reality", adminViewA.summary.overriddenCount >= 1 && adminViewB.summary.overriddenCount >= 1);

  // GATE 13 — the environment that will actually exist immediately after merge:
  // ADMIN_DATABASE_URL is set in no environment except one unrelated Preview
  // branch. The admin features read must work anyway, because it reads one named
  // business through the explicit-target tenant substrate and needs no
  // cross-tenant credential at all.
  const savedAdminUrl = process.env.ADMIN_DATABASE_URL;
  delete process.env.ADMIN_DATABASE_URL;
  delete globalThis.prismaAdmin;
  const postMergeA = await getPlatformAdminBusinessFeatures(bizA.id);
  const postMergeDocA = postMergeA.features.find((f) => f.featureKey === "documents");
  ok(
    "admin read works with ADMIN_DATABASE_URL ABSENT (the post-merge environment)",
    postMergeDocA?.businessOverride === "DISABLED" && postMergeDocA?.allowed === false,
    JSON.stringify(postMergeDocA?.businessOverride)
  );
  const postMergeB = await getPlatformAdminBusinessFeatures(bizB.id);
  ok(
    "admin read of a DIFFERENT business is still correct without the admin credential",
    postMergeB.features.find((f) => f.featureKey === "billing")?.businessOverride === "DISABLED"
  );
  const missingBiz = await throws(() => getPlatformAdminBusinessFeatures(999999999));
  ok("admin read of an unknown business is a clean NotFound, not a credential error",
    missingBiz !== null && !String(missingBiz.message).includes("DATABASE_URL"),
    String(missingBiz?.message).slice(0, 80)
  );
  if (savedAdminUrl) process.env.ADMIN_DATABASE_URL = savedAdminUrl;
  delete globalThis.prismaAdmin;

  // ── Phase 15: audit atomicity ─────────────────────────────────────────────
  console.log("--- phase 15: audit atomicity ---");
  // Forced AUDIT failure: revoke the append, attempt a change, expect full rollback.
  await owner.$executeRawUnsafe(`REVOKE INSERT ON "PlatformAuditEvent" FROM app_ctlplane`);
  const beforeAuditFail = await owner.businessFeatureAccess.findUnique({
    where: { businessId_featureKey: { businessId: bizA.id, featureKey: "documents" } },
  });
  const auditFailErr = await throws(() =>
    updateBusinessFeatureAccess({
      actorUserId: adminUser.id,
      businessId: bizA.id,
      featureKey: "documents",
      state: "ENABLED",
      reason: "pw2 forced audit failure should roll everything back",
    })
  );
  const afterAuditFail = await owner.businessFeatureAccess.findUnique({
    where: { businessId_featureKey: { businessId: bizA.id, featureKey: "documents" } },
  });
  ok("audit failure aborts the operation", auditFailErr !== null);
  ok("audit failure rolls the mutation back (state unchanged)", afterAuditFail.state === beforeAuditFail.state, `${beforeAuditFail.state} -> ${afterAuditFail.state}`);
  await owner.$executeRawUnsafe(`GRANT INSERT ON "PlatformAuditEvent" TO app_ctlplane`);

  // Forced MUTATION failure: revoke the write, expect no success audit.
  await owner.$executeRawUnsafe(`REVOKE INSERT, UPDATE ON "${TABLE}" FROM app_ctlplane`);
  const auditBeforeMutFail = await auditCount();
  const mutFailErr = await throws(() =>
    updateBusinessFeatureAccess({
      actorUserId: adminUser.id,
      businessId: bizA.id,
      featureKey: "documents",
      state: "ENABLED",
      reason: "pw2 forced mutation failure must not audit success",
    })
  );
  const auditAfterMutFail = await auditCount();
  ok("mutation failure aborts the operation", mutFailErr !== null);
  ok("mutation failure writes NO success audit", auditAfterMutFail === auditBeforeMutFail, `${auditBeforeMutFail} -> ${auditAfterMutFail}`);
  await owner.$executeRawUnsafe(`GRANT INSERT, UPDATE ON "${TABLE}" TO app_ctlplane`);

  // ── Phase 16: concurrency ─────────────────────────────────────────────────
  console.log("--- phase 16: concurrency ---");
  const auditBeforeConc = await auditCount();
  const ops = [];
  for (let i = 0; i < 20; i++) {
    ops.push(
      updateBusinessFeatureAccess({
        actorUserId: adminUser.id,
        businessId: i % 2 === 0 ? bizA.id : bizB.id,
        featureKey: "reports",
        state: i % 4 < 2 ? "DISABLED" : "ENABLED",
        reason: `pw2 concurrent operation number ${i}`,
      }).then(
        () => "ok",
        (e) => `err:${e?.message ?? e}`
      )
    );
  }
  const results = await Promise.all(ops);
  const successes = results.filter((r) => r === "ok").length;
  const auditAfterConc = await auditCount();
  ok(
    "concurrency: audit rows equal committed operations (no false success events)",
    auditAfterConc - auditBeforeConc === successes,
    `successes=${successes} audits=${auditAfterConc - auditBeforeConc}`
  );
  const rowsReports = await owner.businessFeatureAccess.findMany({
    where: { featureKey: "reports", businessId: bothIds },
  });
  ok(
    "concurrency: at most one row per (business, feature) — no duplicates",
    rowsReports.length <= 2 && new Set(rowsReports.map((r) => r.businessId)).size === rowsReports.length,
    `n=${rowsReports.length}`
  );
  ok(
    "concurrency: every row belongs to a business that was actually targeted",
    rowsReports.every((r) => r.businessId === bizA.id || r.businessId === bizB.id)
  );

  // ── Phase 17: credential boundary ─────────────────────────────────────────
  console.log("--- phase 17: credential boundary ---");
  const savedUrl = process.env.CONTROL_PLANE_DATABASE_URL;
  delete process.env.CONTROL_PLANE_DATABASE_URL;
  delete globalThis.prismaControlPlane;
  const loudErr = await throws(() =>
    updateBusinessFeatureAccess({
      actorUserId: adminUser.id,
      businessId: bizA.id,
      featureKey: "pricing",
      state: "DISABLED",
      reason: "pw2 must fail loud without the control-plane credential",
    })
  );
  ok(
    "missing CONTROL_PLANE_DATABASE_URL fails LOUD (no fallback credential)",
    loudErr !== null && String(loudErr.message).includes("CONTROL_PLANE_DATABASE_URL"),
    String(loudErr?.message)
  );
  const pricingRow = await owner.businessFeatureAccess.findUnique({
    where: { businessId_featureKey: { businessId: bizA.id, featureKey: "pricing" } },
  });
  ok("missing credential wrote nothing", pricingRow === null);
  // The ordinary tenant path keeps working without the control-plane credential.
  const capsWithoutCtl = await runWithTenantContext({ businessId: bizA.id }, () =>
    resolveBusinessCapabilities(bizA.id)
  );
  ok("tenant path is unaffected by the missing control-plane credential", capsWithoutCtl.documents.allowed === false);
  process.env.CONTROL_PLANE_DATABASE_URL = savedUrl;
  delete globalThis.prismaControlPlane;

  // ── Phase 17b: route-level authorization + spoofing ───────────────────────
  // The DB proves what a credential can do; only the route proves who is allowed
  // to use it. The privileged credential is deliberately UNSET for the denial
  // cases: if authorization ever stopped short-circuiting, the service would
  // throw the loud missing-credential error (500) instead of returning 401/403,
  // so a clean 401/403 is also evidence the privileged path was never entered.
  console.log("--- phase 17b: route authorization ---");
  const { PATCH } = await import(
    "@/app/api/platform-admin/businesses/[id]/features/[featureKey]/route"
  );
  const { signAuthToken } = await import("@/lib/auth-token");

  const SPOOF_FEATURE = "content";
  const callRoute = (token, targetBusinessId, body) =>
    PATCH(
      new Request("http://pw2.local/api/platform-admin/businesses/x/features/y", {
        method: "PATCH",
        headers: token
          ? { authorization: `Bearer ${token}`, "content-type": "application/json" }
          : { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: String(targetBusinessId), featureKey: SPOOF_FEATURE }) }
    );

  process.env.FEATURE_ACCESS_MUTATIONS_ENABLED = "true";
  process.env.PLATFORM_ADMIN_EMAILS = "admin@pw2.test";
  const adminToken = signAuthToken(adminUser.id);
  const tenantUser = await owner.user.findUnique({ where: { email: "a@pw2.test" } });
  const tenantToken = signAuthToken(tenantUser.id);
  const spoofBody = {
    state: "DISABLED",
    reason: "pw2 route-level spoof attempt with a forged actor and target",
    actorUserId: tenantUser.id,
    businessId: bizA.id,
    role: "PLATFORM_ADMIN",
  };

  const ctlUrlSaved = process.env.CONTROL_PLANE_DATABASE_URL;
  delete process.env.CONTROL_PLANE_DATABASE_URL;
  delete globalThis.prismaControlPlane;

  const anon = await callRoute(null, bizB.id, spoofBody);
  ok("route: unauthenticated caller is denied 401", anon.status === 401, `status=${anon.status}`);
  const asTenant = await callRoute(tenantToken, bizB.id, spoofBody);
  ok("route: ordinary tenant user is denied 403", asTenant.status === 403, `status=${asTenant.status}`);
  process.env.PLATFORM_ADMIN_EMAILS = "someone-else@pw2.test";
  const asUnlistedAdmin = await callRoute(adminToken, bizB.id, spoofBody);
  ok(
    "route: PLATFORM_ADMIN outside the email allowlist is denied 403",
    asUnlistedAdmin.status === 403,
    `status=${asUnlistedAdmin.status}`
  );
  const noWriteYet = await owner.businessFeatureAccess.count({
    where: { featureKey: SPOOF_FEATURE, businessId: bothIds },
  });
  ok("route: no denied attempt wrote anything", noWriteYet === 0, `rows=${noWriteYet}`);

  process.env.PLATFORM_ADMIN_EMAILS = "admin@pw2.test";
  process.env.CONTROL_PLANE_DATABASE_URL = ctlUrlSaved;
  delete globalThis.prismaControlPlane;
  const authorized = await callRoute(adminToken, bizB.id, spoofBody);
  ok("route: allowlisted PLATFORM_ADMIN succeeds", authorized.status === 200, `status=${authorized.status}`);
  const spoofRowB = await owner.businessFeatureAccess.findUnique({
    where: { businessId_featureKey: { businessId: bizB.id, featureKey: SPOOF_FEATURE } },
  });
  const spoofRowA = await owner.businessFeatureAccess.findUnique({
    where: { businessId_featureKey: { businessId: bizA.id, featureKey: SPOOF_FEATURE } },
  });
  ok(
    "route: the URL target wins — the body businessId is not an authority",
    spoofRowB !== null && spoofRowA === null,
    `B=${spoofRowB ? spoofRowB.state : null} A=${spoofRowA ? spoofRowA.state : null}`
  );
  ok(
    "route: the row records the AUTHENTICATED admin, not the forged actorUserId",
    spoofRowB.updatedByUserId === adminUser.id,
    `updatedBy=${spoofRowB.updatedByUserId} forged=${tenantUser.id}`
  );
  const spoofAudit = await owner.platformAuditEvent.findFirst({
    where: { action: "PLATFORM_FEATURE_ACCESS_UPDATED", targetId: String(bizB.id) },
    orderBy: { id: "desc" },
  });
  ok(
    "route: the audit actor is the authenticated admin, not the body",
    spoofAudit?.actorUserId === adminUser.id &&
      spoofAudit?.metadata?.featureKey === SPOOF_FEATURE,
    `actor=${spoofAudit?.actorUserId}`
  );

  // ── Phase 18: rollback + re-apply (pg only) ───────────────────────────────
  if (TARGET === "pg") {
    console.log("--- phase 18: rollback + re-apply ---");
    const priorPolicies = Number(
      (
        await owner.$queryRawUnsafe(
          `SELECT count(*)::int AS c FROM pg_policies WHERE policyname LIKE 'p7w%'`
        )
      )[0].c
    );
    const rowsBefore = await owner.businessFeatureAccess.count();
    const auditsBefore = await auditCount();

    await applySqlFile(ROLLBACK, { ":ROLE": RT_ROLE, ":CTL_LOGIN_ROLE": CTL_ROLE });
    const afterNames = await policyNames();
    const afterFlags = await rlsFlags();
    ok("rollback removes every PW-2 policy", afterNames.length === 0, afterNames.join(","));
    ok("rollback disables RLS on the table", afterFlags.e === false && afterFlags.f === false);
    const ctlAfter = (
      await owner.$queryRawUnsafe(
        `SELECT has_table_privilege('app_ctlplane', '"${TABLE}"', 'SELECT') AS s,
                has_table_privilege('app_ctlplane', '"${TABLE}"', 'INSERT') AS i,
                has_table_privilege('app_ctlplane', '"${TABLE}"', 'UPDATE') AS u`
      )
    )[0];
    ok("rollback revokes the control-plane grants", ctlAfter.s === false && ctlAfter.i === false && ctlAfter.u === false, JSON.stringify(ctlAfter));
    const rolesStillThere = Number(
      (
        await owner.$queryRawUnsafe(
          `SELECT count(*)::int AS c FROM pg_roles WHERE rolname IN ('app_ctlplane','${CTL_ROLE}','app_admin','${RT_ROLE}')`
        )
      )[0].c
    );
    ok("rollback drops NO role", rolesStillThere === 4, `found ${rolesStillThere}`);
    ok("rollback preserves BusinessFeatureAccess data", (await owner.businessFeatureAccess.count()) === rowsBefore);
    ok("rollback preserves PlatformAuditEvent data", (await auditCount()) === auditsBefore);
    const priorAfter = Number(
      (
        await owner.$queryRawUnsafe(
          `SELECT count(*)::int AS c FROM pg_policies WHERE policyname LIKE 'p7w%'`
        )
      )[0].c
    );
    ok("rollback preserves every prior-wave policy", priorAfter === priorPolicies, `${priorPolicies} -> ${priorAfter}`);

    await applySqlFile(MIGRATION);
    await applySqlFile(GRANTS, { ":ROLE": RT_ROLE, ":CTL_LOGIN_ROLE": CTL_ROLE });
    const reNames = await policyNames();
    const reFlags = await rlsFlags();
    ok("re-apply restores the full PW-2 posture", reNames.length === 4 && reFlags.e === true && reFlags.f === true);
    const reCross = await tx(ctl, bizA.id, (t) =>
      t.businessFeatureAccess.updateMany({ where: { businessId: bizB.id }, data: { reason: `${MARK}re` } })
    );
    ok("re-apply: cross-tenant control-plane write still denied", reCross.count === 0);
    const reTenantWrite = await throws(() =>
      tx(rt, bizA.id, (t) =>
        t.businessFeatureAccess.updateMany({ where: { businessId: bizA.id }, data: { state: "ENABLED" } })
      )
    );
    ok("re-apply: tenant self-write still denied", reTenantWrite !== null);
  }

  // ── Phase 19: residue ─────────────────────────────────────────────────────
  console.log("--- phase 19: residue ---");
  await rt.$disconnect();
  await adm.$disconnect();
  await ctl.$disconnect();
  await cleanup();
  const residue = Number(
    (
      await owner.$queryRawUnsafe(
        `SELECT (SELECT count(*)::int FROM "Business" WHERE name LIKE '${MARK}%')
              + (SELECT count(*)::int FROM "User" WHERE email LIKE '%@pw2.test') AS c`
      )
    )[0].c
  );
  ok("synthetic residue = 0", residue === 0, `found ${residue}`);

  await owner.$disconnect();
  console.log(`\n[battery] target=${TARGET} PASS=${pass} FAIL=${fail} SKIP=0`);
  if (fail > 0) {
    console.log("FAILURES:\n - " + failures.join("\n - "));
    process.exit(1);
  }
  console.log("ALL CHECKS PASS");
}

main().catch((e) => {
  console.error("[battery] FATAL:", e);
  process.exit(1);
});
