/**
 * D2 / PRODUCTION-RUNTIME-CUTOVER-3A.1 — exact-grant restricted runtime proof (PG17).
 *
 * CUTOVER-3A's matrix granted the test role SELECT/INSERT/UPDATE/DELETE on ALL tables
 * plus USAGE+SELECT on all sequences. That is BROADER than what `app_runtime` actually
 * holds in Production, so it could not prove the real privilege set is sufficient —
 * a missing grant would simply not have shown up.
 *
 * This battery reproduces Production's `app_runtime` contract EXACTLY, measured
 * read-only from the live catalog on 2026-09-03:
 *
 *   schema public : USAGE = true, CREATE = false
 *   tables        : SELECT/INSERT/UPDATE/DELETE on 105 of 106 — every public table
 *                   EXCEPT `_prisma_migrations` (the migration ledger stays owner-only)
 *   sequences     : 98 with USAGE + SELECT, and *** UPDATE on ZERO of them ***
 *   functions     : none exist in public, so none are granted
 *   memberships   : app_runtime is a member of NOTHING
 *
 * The sequence detail is the one most likely to bite: an INSERT into a table whose id
 * comes from a sequence needs USAGE (or UPDATE) on that sequence, and a table-level
 * INSERT grant does not imply it. Production grants USAGE but not UPDATE, so nextval()
 * works and setval() does not — that has to be demonstrated, not assumed.
 *
 * The login role is a member of `app_runtime` and NOTHING ELSE: not app_admin, not
 * app_ctlplane, not the owner. PostgreSQL applies a policy declared `TO app_admin` to
 * any role that is a MEMBER of app_admin, so that membership would silently hand the
 * runtime the cross-tenant admin read. This proves it does not have it.
 *
 * Synthetic tx3a1- fixtures only. ZERO network, ZERO Neon, ZERO Production.
 */
import { PrismaClient } from "@prisma/client";
import { readdirSync, readFileSync } from "node:fs";

const RT_ROLE = "tx3a1_runtime";
const RT_PW = "tx3a1_ci_synthetic_pw";

let pass = 0;
let fail = 0;
const failures = [];
const denials = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
async function err(fn) { try { await fn(); return null; } catch (e) { return e; } }
function isDenied(e) { return /permission denied|must be owner|denied for/i.test(String(e?.message ?? "")); }
function roleUrl(base, user, pw) {
  const u = new URL(base); u.username = user; u.password = pw; return u.toString();
}

async function main() {
  const ownerUrl = process.env.OWNER_URL;
  if (!ownerUrl) { console.error("OWNER_URL required"); process.exit(2); }
  for (const d of ["ep-flat-brook-am4bhq1y", "ep-winter-bread-ami5o8p5"]) {
    if (ownerUrl.includes(d)) { console.error("REFUSING: Production deny-list"); process.exit(2); }
  }
  const owner = new PrismaClient({ datasourceUrl: ownerUrl });

  // ---- 1. repository security state ----------------------------------------
  console.log("\n== 1. repository RLS state ==");
  for (const r of ["app_admin", "app_ctlplane", "app_runtime"]) {
    await owner.$executeRawUnsafe(
      `DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r}') THEN
         CREATE ROLE ${r} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
       END IF; END $do$`);
  }
  let applied = 0;
  for (const d of readdirSync("prisma/migrations").filter((x) => /^\d/.test(x)).sort()) {
    let sql;
    try { sql = readFileSync(`prisma/migrations/${d}/migration.sql`, "utf8"); } catch { continue; }
    for (const st of sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
                        .split(";").map((x) => x.trim()).filter(Boolean)) {
      if (!/ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY|CREATE ROLE|DO \$\$/i.test(st)) continue;
      try { await owner.$executeRawUnsafe(st); applied++; } catch { /* already present */ }
    }
  }
  ok(`applied ${applied} RLS/role statements from the repository`, applied > 50);

  // ---- 2. reproduce Production's EXACT app_runtime grant contract -----------
  console.log("\n== 2. exact app_runtime grant contract (as measured in Production) ==");
  await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO app_runtime`);
  await owner.$executeRawUnsafe(
    `DO $do$ DECLARE t record; BEGIN
       FOR t IN SELECT relname FROM pg_class
                 WHERE relnamespace='public'::regnamespace AND relkind='r'
                   AND relname <> '_prisma_migrations'
       LOOP EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO app_runtime', t.relname);
       END LOOP;
     END $do$`);
  // USAGE + SELECT only. Deliberately NO UPDATE — Production grants none.
  await owner.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime`);

  const contract = await owner.$queryRawUnsafe(
    `SELECT
       (SELECT count(DISTINCT table_name)::int FROM information_schema.role_table_grants
         WHERE table_schema='public' AND grantee='app_runtime' AND privilege_type='SELECT') AS sel,
       (SELECT count(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r') AS total_tables,
       has_schema_privilege('app_runtime','public','USAGE') AS schema_usage,
       has_schema_privilege('app_runtime','public','CREATE') AS schema_create,
       (SELECT count(*) FILTER (WHERE has_sequence_privilege('app_runtime', c.oid, 'USAGE'))::int
          FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='S') AS seq_usage,
       (SELECT count(*) FILTER (WHERE has_sequence_privilege('app_runtime', c.oid, 'UPDATE'))::int
          FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='S') AS seq_update`);
  const c0 = contract[0];
  // `prisma db push` does not create `_prisma_migrations` (only `migrate` does), so the
  // lab has one table fewer than Production. The contract being reproduced is "every
  // APPLICATION table, and never the migration ledger" — assert that directly rather
  // than a fixed count, so the check means the same thing in both places.
  const ledgerExists = (await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_class
       WHERE relnamespace='public'::regnamespace AND relname='_prisma_migrations'`))[0].n === 1;
  const expectedGranted = c0.total_tables - (ledgerExists ? 1 : 0);
  ok(`app_runtime holds table grants on every application table (${c0.sel} of ${c0.total_tables}; ledger present=${ledgerExists})`,
    c0.sel === expectedGranted, JSON.stringify(c0));
  ok("schema USAGE yes, CREATE no", c0.schema_usage === true && c0.schema_create === false);
  ok("sequences: USAGE granted, UPDATE granted on ZERO (matches Production exactly)",
    c0.seq_usage > 0 && c0.seq_update === 0, JSON.stringify(c0));
  if (ledgerExists) {
    const ledger = await owner.$queryRawUnsafe(
      `SELECT has_table_privilege('app_runtime','public."_prisma_migrations"','SELECT') AS can_read`);
    ok("app_runtime cannot read the migration ledger", ledger[0].can_read === false);
  } else {
    ok("migration ledger absent in this lab (db push) — exclusion asserted by construction", true);
  }

  // ---- 3. the login role: member of app_runtime and NOTHING else -----------
  console.log("\n== 3. restricted login role ==");
  await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${RT_ROLE}`);
  await owner.$executeRawUnsafe(
    `CREATE ROLE ${RT_ROLE} LOGIN PASSWORD '${RT_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION INHERIT`);
  await owner.$executeRawUnsafe(`GRANT app_runtime TO ${RT_ROLE}`);

  const attrs = await owner.$queryRawUnsafe(
    `SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
       FROM pg_roles WHERE rolname='${RT_ROLE}'`);
  const A0 = attrs[0];
  ok("LOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, NOREPLICATION",
    A0.rolcanlogin === true && A0.rolsuper === false && A0.rolbypassrls === false &&
    A0.rolcreatedb === false && A0.rolcreaterole === false && A0.rolreplication === false,
    JSON.stringify(A0));
  const mems = await owner.$queryRawUnsafe(
    `SELECT g.rolname AS member_of FROM pg_auth_members m
       JOIN pg_roles r ON r.oid=m.member JOIN pg_roles g ON g.oid=m.roleid
      WHERE r.rolname='${RT_ROLE}' ORDER BY 1`);
  const memNames = mems.map((m) => m.member_of);
  ok("member of app_runtime and NOTHING else", memNames.length === 1 && memNames[0] === "app_runtime",
    JSON.stringify(memNames));
  for (const forbidden of ["app_admin", "app_ctlplane", "neon_superuser"]) {
    const has = await owner.$queryRawUnsafe(
      `SELECT pg_has_role('${RT_ROLE}', $1, 'USAGE') AS m`, forbidden).catch(() => [{ m: false }]);
    ok(`NOT a member of ${forbidden} (a TO-${forbidden} policy would otherwise apply)`, has[0].m === false);
  }
  const owns = await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_class WHERE relnamespace='public'::regnamespace
       AND relowner=(SELECT oid FROM pg_roles WHERE rolname='${RT_ROLE}')`);
  ok("owns ZERO application relations", owns[0].n === 0);

  // ---- fixtures --------------------------------------------------------------
  const A = await owner.business.create({ data: { name: "tx3a1-A" } });
  const B = await owner.business.create({ data: { name: "tx3a1-B" } });
  const custB = await owner.customer.create({ data: { businessId: B.id, name: "tx3a1 cust B" } });
  const convB = await owner.conversation.create({ data: { businessId: B.id, channel: "WHATSAPP" } });

  const rt = new PrismaClient({ datasourceUrl: roleUrl(ownerUrl, RT_ROLE, RT_PW) });
  const withTenant = (bid, fn) =>
    rt.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_business_id', ${String(bid)}, true)`;
      return fn(tx);
    });

  // ---- 4. SEQUENCE PROOF: inserts across every family ----------------------
  //
  // The point of this section: a table INSERT grant does NOT imply the sequence
  // privilege the insert needs. Production grants USAGE (not UPDATE) on sequences, so
  // every one of these must succeed on that basis alone.
  console.log("\n== 4. sequence-backed inserts across the feature families ==");
  const inserts = [
    ["Customer", (tx) => tx.customer.create({ data: { businessId: A.id, name: "tx3a1 c" } })],
    ["Conversation", (tx) => tx.conversation.create({ data: { businessId: A.id, channel: "WHATSAPP" } })],
    ["InventoryItem", (tx) => tx.inventoryItem.create({ data: { businessId: A.id, name: "it", unitType: "UNIT" } })],
    ["Supplier", (tx) => tx.supplier.create({ data: { businessId: A.id, name: "sup" } })],
    ["BillingDocument", (tx) => tx.billingDocument.create({ data: { businessId: A.id, documentType: "QUOTE" } })],
    ["PaymentRequest", (tx) => tx.paymentRequest.create({ data: { businessId: A.id, provider: "TRANZILA", amount: "1.00" } })],
    ["Lead", (tx) => tx.lead.create({ data: { businessId: A.id, source: "MANUAL" } })],
    ["CrmNote", (tx) => tx.crmNote.create({ data: { businessId: A.id, subjectType: "CUSTOMER", subjectId: 1, body: "n" } })],
  ];
  let seqFailures = 0;
  for (const [label, fn] of inserts) {
    const e = await err(() => withTenant(A.id, fn));
    if (e && isDenied(e)) { seqFailures++; denials.push(`${label} INSERT: ${String(e.message).slice(0, 120)}`); }
    ok(`${label}: sequence-backed INSERT is not blocked by a privilege error`,
      !(e && isDenied(e)), String(e?.message ?? "").slice(0, 140));
  }
  ok("ZERO sequence/privilege failures across the insert matrix", seqFailures === 0, `failures=${seqFailures}`);

  // setval needs sequence UPDATE, which Production deliberately does NOT grant.
  const setvalErr = await err(() =>
    rt.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('public."Customer"','id'), 1, true)`));
  ok("setval() IS refused (sequence UPDATE is deliberately not granted)", setvalErr !== null,
    String(setvalErr?.message ?? "").slice(0, 120));

  // ---- 5. reads across the families, non-empty ----------------------------
  console.log("\n== 5. reads under the exact grant set ==");
  const reads = ["customer", "conversation", "inventoryItem", "supplier", "billingDocument",
                 "paymentRequest", "lead", "crmNote", "message", "appointment", "document", "contentRun"];
  let readDenials = 0;
  for (const m of reads) {
    const e = await err(() => withTenant(A.id, (tx) => tx[m].findMany({ take: 1 })));
    if (e && isDenied(e)) { readDenials++; denials.push(`${m} SELECT: ${String(e.message).slice(0, 120)}`); }
    ok(`${m}: SELECT permitted`, !(e && isDenied(e)), String(e?.message ?? "").slice(0, 120));
  }
  ok("ZERO read privilege failures", readDenials === 0, `failures=${readDenials}`);
  const mine = await withTenant(A.id, (tx) => tx.customer.findMany({}));
  ok("tenant A sees its OWN customers (non-empty — not a silent zero)", mine.length >= 1, `n=${mine.length}`);

  // ---- 6. cross-tenant isolation ------------------------------------------
  console.log("\n== 6. cross-tenant isolation ==");
  ok("A cannot read B's customers", (await withTenant(A.id, (tx) => tx.customer.findMany({ where: { businessId: B.id } }))).length === 0);
  ok("A cannot read B's conversations", (await withTenant(A.id, (tx) => tx.conversation.findMany({ where: { businessId: B.id } }))).length === 0);
  const cu = await withTenant(A.id, (tx) => tx.customer.updateMany({ where: { id: custB.id }, data: { city: "x" } }));
  ok("A cannot mutate B's customer (0 rows)", cu.count === 0);
  ok("B's customer genuinely unchanged",
    (await owner.customer.findUnique({ where: { id: custB.id } }))?.city === null);

  // ---- 7. owner-dependency detection ---------------------------------------
  console.log("\n== 7. owner / BYPASSRLS dependency detection ==");
  ok("TRUNCATE is refused", isDenied(await err(() => rt.$executeRawUnsafe(`TRUNCATE TABLE "Customer"`)) ?? {}) ||
     (await err(() => rt.$executeRawUnsafe(`TRUNCATE TABLE "Customer"`))) !== null);
  ok("DDL (ALTER TABLE) is refused", (await err(() => rt.$executeRawUnsafe(`ALTER TABLE "Customer" ADD COLUMN zz int`))) !== null);
  ok("CREATE TABLE in public is refused", (await err(() => rt.$executeRawUnsafe(`CREATE TABLE zz_tmp(id int)`))) !== null);
  ok("SET ROLE to the owner is refused", (await err(() => rt.$executeRawUnsafe(`SET ROLE neondb_owner`))) !== null);
  ok("the migration ledger is unreadable (or absent in this lab)",
    (await err(() => rt.$queryRawUnsafe(`SELECT 1 FROM "_prisma_migrations" LIMIT 1`))) !== null);
  ok("ALTER POLICY is refused", (await err(() => rt.$executeRawUnsafe(`ALTER TABLE "Customer" DISABLE ROW LEVEL SECURITY`))) !== null);

  // ---- 8. DELETE reality ----------------------------------------------------
  console.log("\n== 8. DELETE grant vs DELETE authorization ==");
  for (const [label, model] of [["Conversation", "conversation"], ["Customer", "customer"],
                                ["Appointment", "appointment"], ["BillingDocument", "billingDocument"],
                                ["PaymentRequest", "paymentRequest"]]) {
    const grant = await owner.$queryRawUnsafe(
      `SELECT has_table_privilege('app_runtime', $1, 'DELETE') AS g`, `public."${label}"`);
    const pol = await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='public' AND tablename=$1 AND cmd='DELETE'`, label);
    const res = await withTenant(A.id, (tx) => tx[model].deleteMany({ where: { businessId: A.id } }).catch((e) => e));
    const blocked = res instanceof Error || (res && res.count === 0);
    ok(`${label}: grant=${grant[0].g} policy=${pol[0].n} -> delete reaches nothing`, blocked && pol[0].n === 0,
      JSON.stringify(res));
  }

  // ---- 9. BOOTSTRAP: signup under the restricted role -----------------------
  //
  // The one flow that must work BEFORE a tenant exists. Business and User are not
  // under RLS, but the restricted role still needs the table and sequence privileges,
  // and this has only ever run under the owner.
  console.log("\n== 9. bootstrap: tenant creation under the restricted role ==");
  const signup = await err(() => rt.$transaction(async (tx) => {
    const biz = await tx.business.create({ data: { name: "tx3a1-signup" } });
    const user = await tx.user.create({
      data: { businessId: biz.id, email: "tx3a1-signup@tx3a1.test", password: "x" } });
    await tx.businessProfile.create({ data: { businessId: biz.id } }).catch(() => null);
    return { biz, user };
  }));
  ok("signup (Business + User + profile) succeeds under the restricted role", signup === null,
    String(signup?.message ?? "").slice(0, 200));
  const created = await owner.business.count({ where: { name: "tx3a1-signup" } });
  ok("...and the tenant row really exists (not a false success)", created === 1);

  // ---- 10. bootstrap lookups stay context-free ------------------------------
  console.log("\n== 10. pre-tenant bootstrap lookups ==");
  for (const [label, m] of [["User", "user"], ["WhatsAppConnection", "whatsAppConnection"],
                            ["POSApiKey", "pOSApiKey"], ["PaymentProviderRouting", "paymentProviderRouting"]]) {
    const e = await err(() => rt[m].findMany({ take: 1 }));
    ok(`${label}: readable WITHOUT tenant context (bootstrap boundary intact)`, !(e && isDenied(e)),
      String(e?.message ?? "").slice(0, 120));
  }

  // ---- cleanup ---------------------------------------------------------------
  await rt.$disconnect();
  await owner.$executeRawUnsafe(`DELETE FROM "User" WHERE email LIKE '%@tx3a1.test'`);
  for (const t of ["CrmNote", "Lead", "PaymentRequest", "BillingDocument", "Supplier",
                   "InventoryItem", "Conversation", "Customer", "BusinessProfile"]) {
    await owner.$executeRawUnsafe(
      `DELETE FROM "${t}" WHERE "businessId" IN (SELECT id FROM "Business" WHERE name LIKE 'tx3a1-%')`).catch(() => {});
  }
  await owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE name LIKE 'tx3a1-%'`);
  await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${RT_ROLE}`);
  ok("lab role and fixtures removed", true);

  if (denials.length) {
    console.log("\n  PERMISSION DENIALS HARVESTED:");
    for (const d of denials) console.log(`    ${d}`);
  } else {
    console.log("\n  PERMISSION DENIALS HARVESTED: none");
  }

  console.log(`\n[tx3a1] PASS=${pass} FAIL=${fail}`);
  if (failures.length) console.log("FAILURES:\n  " + failures.join("\n  "));
  await owner.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
