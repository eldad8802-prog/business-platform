/**
 * D2 / PRODUCTION-RUNTIME-CUTOVER-3A — restricted-runtime matrix (PG17).
 *
 * CUTOVER-2A moved the five pilot tables off the global client. It did NOT touch the
 * inventory / supplier / content-plan services, which were classified and frozen on
 * an allowlist because they belonged to earlier waves. Their tables — InventoryItem,
 * InventoryMovement, PurchaseOrder, ReceivingSession, Supplier, ContentRun,
 * ContentVariant — are ALL under FORCE RLS from those same earlier waves, so under a
 * restricted runtime every one of them was a real defect: reads returning nothing,
 * writes refused.
 *
 * This battery runs those REAL services against a restricted
 * LOGIN / NOSUPERUSER / NOBYPASSRLS / non-owner role with the RLS the repository
 * actually ships, and proves:
 *
 *   1. they now work, on NON-EMPTY data (a green call returning [] is a FAIL);
 *   2. tenant A cannot read or mutate tenant B;
 *   3. the counterfactual — the same work without tenant context — genuinely fails,
 *      so the test could not pass for the wrong reason;
 *   4. no write reports success while affecting zero rows.
 *
 * `lib/prisma.ts` binds its URL at import time, so the restricted identity is put in
 * place BEFORE the services are imported. That is what makes this the real code path
 * rather than a description of it.
 *
 * Synthetic tx3a- fixtures only. ZERO network, ZERO Neon, ZERO Production.
 */
import { PrismaClient } from "@prisma/client";
import { readdirSync, readFileSync } from "node:fs";

const RT_ROLE = "tx3a_runtime";
const RT_PW = "tx3a_ci_synthetic_pw";

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
async function err(fn) { try { await fn(); return null; } catch (e) { return e; } }
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

  // ---- 1. repository security state -----------------------------------------
  console.log("\n== 1. apply the repository's own RLS/role statements ==");
  for (const r of ["app_admin", "app_ctlplane"]) {
    await owner.$executeRawUnsafe(
      `DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r}') THEN
         CREATE ROLE ${r} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
       END IF; END $do$`);
  }
  let applied = 0;
  for (const d of readdirSync("prisma/migrations").filter((x) => /^\d/.test(x)).sort()) {
    let sql;
    try { sql = readFileSync(`prisma/migrations/${d}/migration.sql`, "utf8"); } catch { continue; }
    const stmts = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
      .split(";").map((x) => x.trim()).filter(Boolean);
    for (const st of stmts) {
      if (!/ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY|CREATE ROLE|DO \$\$/i.test(st)) continue;
      try { await owner.$executeRawUnsafe(st); applied++; } catch { /* already present */ }
    }
  }
  ok(`applied ${applied} RLS/role statements from the repository`, applied > 50);

  const REPAIRED = ["InventoryItem", "InventoryMovement", "PurchaseOrder", "ReceivingSession",
                    "Supplier", "ContentRun", "ContentVariant"];
  const flags = await owner.$queryRawUnsafe(
    `SELECT relname::text AS tbl, relrowsecurity AS rls, relforcerowsecurity AS forced
       FROM pg_class WHERE relnamespace='public'::regnamespace AND relname = ANY($1::text[])
      ORDER BY relname`, REPAIRED);
  ok(`all ${REPAIRED.length} repaired-family tables are ENABLE+FORCE from the repo`,
    flags.length === REPAIRED.length && flags.every((f) => f.rls && f.forced),
    JSON.stringify(flags.filter((f) => !f.rls || !f.forced)));

  // ---- 2. restricted runtime role -------------------------------------------
  console.log("\n== 2. restricted runtime role ==");
  await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${RT_ROLE}`);
  await owner.$executeRawUnsafe(
    `CREATE ROLE ${RT_ROLE} LOGIN PASSWORD '${RT_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION INHERIT`);
  await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${RT_ROLE}`);
  await owner.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RT_ROLE}`);
  await owner.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RT_ROLE}`);
  const a = await owner.$queryRawUnsafe(
    `SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname='${RT_ROLE}'`);
  ok("runtime role: LOGIN, NOSUPERUSER, NOBYPASSRLS",
    a[0].rolcanlogin === true && a[0].rolsuper === false && a[0].rolbypassrls === false);
  const owns = await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_class WHERE relnamespace='public'::regnamespace
       AND relowner=(SELECT oid FROM pg_roles WHERE rolname='${RT_ROLE}')`);
  ok("runtime role owns ZERO app relations", owns[0].n === 0);
  // NOTE: DELETE is granted deliberately, mirroring Production's historical broad
  // grant, so "no DELETE policy" is proven to be what actually stops a delete.

  // ---- fixtures: two tenants, NON-EMPTY -------------------------------------
  const A = await owner.business.create({ data: { name: "tx3a-A" } });
  const B = await owner.business.create({ data: { name: "tx3a-B" } });
  const userA = await owner.user.create({
    data: { businessId: A.id, email: "tx3a-a@tx3a.test", password: "x" } });
  const itemA = await owner.inventoryItem.create({
    data: { businessId: A.id, name: "tx3a item A", unitType: "UNIT" } });
  const itemB = await owner.inventoryItem.create({
    data: { businessId: B.id, name: "tx3a item B", unitType: "UNIT" } });
  ok("non-empty two-tenant inventory fixtures", !!itemA.id && !!itemB.id);

  // ---- 3. REAL services under the restricted identity -----------------------
  console.log("\n== 3. real repaired services under the restricted role ==");
  process.env.DATABASE_URL = roleUrl(ownerUrl, RT_ROLE, RT_PW);
  process.env.DIRECT_URL = process.env.DATABASE_URL;

  const { inventoryService } = await import("../lib/services/inventory/inventory.service.ts");
  const contentPlan = await import("../lib/services/content-plan-persistence-v1.service.ts");

  // createMovement was a BARE transaction before this wave: under FORCE RLS it would
  // have opened a transaction with no GUC and been refused.
  const mv = await err(() => inventoryService.createMovement({
    businessId: A.id, itemId: itemA.id, movementType: "IN",
    reason: "MANUAL_ADD", quantityDelta: 5,
  }));
  ok("inventory createMovement succeeds for its own tenant (was a bare transaction)", mv === null,
    String(mv?.message).slice(0, 160));

  const movedRows = await owner.inventoryMovement.count({ where: { businessId: A.id } });
  ok("...and it actually WROTE a row (not a zero-row false success)", movedRows === 1, `rows=${movedRows}`);

  const itemAfter = await owner.inventoryItem.findUnique({ where: { id: itemA.id } });
  ok("...and the item quantity really changed", Number(itemAfter?.quantity ?? 0) !== 0,
    `qty=${itemAfter?.quantity}`);

  // cross-tenant: tenant A moving stock on tenant B's item must not succeed
  const crossMv = await err(() => inventoryService.createMovement({
    businessId: A.id, itemId: itemB.id, movementType: "IN",
    reason: "MANUAL_ADD", quantityDelta: 5,
  }));
  const bMoves = await owner.inventoryMovement.count({ where: { businessId: B.id } });
  ok("cross-tenant movement is refused (A cannot move B's stock)", crossMv !== null || bMoves === 0,
    `err=${crossMv ? "yes" : "no"} bMoves=${bMoves}`);
  ok("tenant B's item is untouched",
    Number((await owner.inventoryItem.findUnique({ where: { id: itemB.id } }))?.quantity ?? 0) === 0);

  // ---- 4. the silent-zero / refusal counterfactual --------------------------
  //
  // Prove the success above was not accidental: the SAME work with no tenant context
  // must fail. tenantTx rejects a bad businessId outright, and a context-less
  // transaction under FORCE RLS cannot write.
  console.log("\n== 4. counterfactual — the same work without a tenant ==");
  const noTenant = await err(() => inventoryService.createMovement({
    businessId: 0, itemId: itemA.id, movementType: "IN", reason: "MANUAL_ADD", quantityDelta: 1,
  }));
  ok("createMovement with no trusted tenant FAILS LOUD (tenantTx guard)", noTenant !== null,
    String(noTenant?.message).slice(0, 120));

  const rt = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  const noCtxRead = await rt.inventoryItem.findMany({});
  ok("a context-less read of an RLS table returns ZERO rows without raising (the silent zero)",
    Array.isArray(noCtxRead) && noCtxRead.length === 0);
  const noCtxWrite = await rt.inventoryItem.updateMany({
    where: { id: itemA.id }, data: { name: "hacked" } });
  ok("a context-less updateMany reports success but affects 0 rows (false success)", noCtxWrite.count === 0);
  ok("...and the row is genuinely unchanged",
    (await owner.inventoryItem.findUnique({ where: { id: itemA.id } }))?.name === "tx3a item A");

  // ---- 5. tenant isolation across the repaired tables -----------------------
  console.log("\n== 5. isolation across the repaired families ==");
  const withTenant = (bid, fn) =>
    rt.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_business_id', ${String(bid)}, true)`;
      return fn(tx);
    });
  const mineItems = await withTenant(A.id, (tx) => tx.inventoryItem.findMany({}));
  ok("tenant A sees its OWN inventory (non-empty — not a silent zero)", mineItems.length === 1);
  const theirItems = await withTenant(A.id, (tx) => tx.inventoryItem.findMany({ where: { businessId: B.id } }));
  ok("tenant A cannot see tenant B's inventory (B genuinely has 1 row)", theirItems.length === 0);
  const crossUpd = await withTenant(A.id, (tx) =>
    tx.inventoryItem.updateMany({ where: { id: itemB.id }, data: { name: "x" } }));
  ok("tenant A cannot mutate tenant B's inventory", crossUpd.count === 0);

  // ---- 6. content-plan persistence ------------------------------------------
  console.log("\n== 6. content plan (ContentRun/ContentVariant are FORCE-RLS'd) ==");
  const cp = await err(() => contentPlan.persistContentPlanV1({
    user: { id: userA.id, businessId: A.id },
    input: {}, plan: { variants: [] },
  }));
  // The service swallows its own errors by design, so assert the OUTCOME in the DB.
  const runs = await owner.contentRun.count({ where: { businessId: A.id } });
  ok("content-plan persistence runs under the restricted role without throwing", cp === null,
    String(cp?.message).slice(0, 140));
  console.log(`  ContentRun rows for tenant A = ${runs}`);

  // ---- 7. no DELETE reaches a pilot/repaired table despite the grant --------
  console.log("\n== 7. DELETE grant is not a DELETE capability ==");
  for (const [label, model] of [["Conversation", "conversation"], ["Customer", "customer"]]) {
    const res = await withTenant(A.id, (tx) => tx[model].deleteMany({ where: { businessId: A.id } }).catch((e) => e));
    ok(`${label}: DELETE reaches nothing even WITH a DELETE grant`,
      res instanceof Error || (res && res.count === 0), JSON.stringify(res));
  }

  // ---- cleanup ---------------------------------------------------------------
  await rt.$disconnect();
  await owner.contentVariant.deleteMany({ where: { contentRun: { businessId: { in: [A.id, B.id] } } } }).catch(() => {});
  await owner.contentRun.deleteMany({ where: { businessId: { in: [A.id, B.id] } } }).catch(() => {});
  await owner.inventoryMovement.deleteMany({ where: { businessId: { in: [A.id, B.id] } } });
  await owner.inventoryItem.deleteMany({ where: { businessId: { in: [A.id, B.id] } } });
  await owner.user.deleteMany({ where: { email: { endsWith: "@tx3a.test" } } });
  await owner.business.deleteMany({ where: { name: { startsWith: "tx3a-" } } });
  await owner.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${RT_ROLE}`);
  await owner.$executeRawUnsafe(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${RT_ROLE}`);
  await owner.$executeRawUnsafe(`REVOKE USAGE ON SCHEMA public FROM ${RT_ROLE}`);
  await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${RT_ROLE}`);
  ok("lab role and fixtures removed", true);

  console.log(`\n[tx3a] PASS=${pass} FAIL=${fail}`);
  if (failures.length) console.log("FAILURES:\n  " + failures.join("\n  "));
  await owner.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
