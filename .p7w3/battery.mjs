/**
 * D2 / P7 Wave 3 — Inventory / Suppliers / POS adversarial battery.
 *
 * Targets (BATTERY_TARGET): pg (ephemeral PG17, full provision + rollback
 * proof + re-apply) | neon (Preview branch: drift gates, additive catch-up of
 * missing already-merged tables, apply, same matrix on the real substrate).
 *
 * Beyond the standard direct/indirect matrix, Wave 3 proves RELATIONAL
 * cross-tenant attacks (movement→foreign item, PO line→foreign item,
 * receiving→foreign PO, category→foreign item, pending-match→foreign item,
 * approval→foreign draft) and the full POS TRUST MODEL (key→business lock,
 * malicious body businessId ignored, per-tenant replay idempotency, foreign
 * SKU cannot mutate the other tenant's stock, bad key 401).
 * Synthetic p7w3-* fixtures only; secrets never printed.
 */
import { readFileSync, readdirSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const TARGET = process.env.BATTERY_TARGET === "neon" ? "neon" : "pg";
const RT_ROLE = TARGET === "neon" ? "app_runtime_preview_p4b" : "wave1_runtime";
const ADMIN_LOGIN = process.env.ADMIN_LOGIN_ROLE || (TARGET === "neon" ? "app_admin_preview" : "app_admin_lab");
const ADMIN_PW = process.env.W2G_ADMIN_PW || "p7w2g_ci_synthetic_admin_pw";
const RUNTIME_URL = process.env.RUNTIME_URL;
const MARK = "p7w3-";
const POS_KEY_A = "p7w3_pos_key_A_synthetic";

const DIRECT = ["InventoryCategory","InventoryItem","InventoryMovement","InventoryAlert","InventoryDraft","InventoryPendingMatch","InventoryExternalSale","POSProductMapping","SupplierPurchaseDraft","Supplier","PurchaseOrder","ReceivingSession"];
const INDIRECT = ["SupplierPurchaseDraftLine","PurchaseOrderLine","ReceivingLine"];
const WAVE3 = [...DIRECT, ...INDIRECT];

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
    throw new Error(`DENY: ${label} not the approved Preview endpoint`);
  }
}

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

const VERIFY_ONLY = process.env.W3_VERIFY_ONLY === "1";

async function main() {
  if (!process.env.DIRECT_URL) throw new Error("DIRECT_URL missing");
  if (!RUNTIME_URL && !VERIFY_ONLY) throw new Error("RUNTIME_URL missing");
  assertEndpointSafety(process.env.DIRECT_URL, "DIRECT_URL");
  if (RUNTIME_URL) assertEndpointSafety(RUNTIME_URL, "RUNTIME_URL");

  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  await owner.$queryRaw`SELECT 1`;
  console.log(`[battery] target=${TARGET} runtime=${RT_ROLE}`);

  const applySqlFile = async (path, repl = {}) => {
    let sql = readFileSync(path, "utf8");
    for (const [k, v] of Object.entries(repl)) sql = sql.replaceAll(k, v);
    const statements = splitSql(sql);
    for (const stmt of statements) await owner.$executeRawUnsafe(stmt);
    return statements.length;
  };

  // ---------- Phase 1: pre-state + drift gates ----------
  const prePol = await owner.$queryRawUnsafe(
    `SELECT tablename, policyname FROM pg_policies WHERE tablename IN (${WAVE3.map((t) => `'${t}'`).join(",")})`
  );
  const foreign = prePol.filter((r) => r.policyname !== "p7w3_tenant");
  if (foreign.length > 0) throw new Error(`DRIFT: unexpected policies on Wave-3 tables: ${JSON.stringify(foreign)} — STOP`);
  if (TARGET === "neon") {
    const pilot = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p4b_tenant'`))[0].c);
    if (pilot !== 5) throw new Error(`DRIFT: pilot=${pilot} — STOP`);
    const w1 = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w1_tenant'`))[0].c);
    if (w1 !== 14) throw new Error(`DRIFT: wave1=${w1}, expected 14 — STOP`);
    const w2 = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w2_tenant'`))[0].c);
    if (w2 !== 24) throw new Error(`DRIFT: wave2=${w2}, expected 24 — STOP`);
    const adm = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7adm_read'`))[0].c);
    if (adm !== 3) throw new Error(`DRIFT: admin=${adm}, expected 3 — STOP`);
    const rt0 = (await owner.$queryRawUnsafe(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='${RT_ROLE}'`))[0];
    if (!rt0 || rt0.rolsuper || rt0.rolbypassrls) throw new Error("DRIFT: runtime posture — STOP");
    console.log("[pre-state] pilot=5, wave1=14, wave2=24, admin=3, runtime posture OK");

    // Step-14 catch-up: create any missing already-merged Wave-3 tables.
    const missing = [];
    for (const t of [...WAVE3, "POSApiKey"]) {
      const reg = (await owner.$queryRawUnsafe(`SELECT to_regclass('public."${t}"')::text AS r`))[0].r;
      if (!reg) missing.push(t);
    }
    if (missing.length > 0) {
      console.log(`[catch-up] missing Wave-3 tables on Preview: ${missing.join(", ")}`);
      const dirs = readdirSync("prisma/migrations", { withFileTypes: true })
        .filter((d) => d.isDirectory()).map((d) => d.name).sort();
      for (const dir of dirs) {
        let sql;
        try { sql = readFileSync(`prisma/migrations/${dir}/migration.sql`, "utf8"); } catch { continue; }
        const creates = [...sql.matchAll(/CREATE TABLE "?([A-Za-z]+)"?/g)].map((m) => m[1]);
        const needed = creates.filter((t) => missing.includes(t));
        if (needed.length === 0) continue;
        const still = [];
        for (const t of needed) {
          const reg = (await owner.$queryRawUnsafe(`SELECT to_regclass('public."${t}"')::text AS r`))[0].r;
          if (!reg) still.push(t);
        }
        if (still.length === 0) continue;
        console.log(`[catch-up] applying canonical migration ${dir} (creates: ${needed.join(", ")})`);
        await applySqlFile(`prisma/migrations/${dir}/migration.sql`);
      }
      const after = [];
      for (const t of missing) {
        const reg = (await owner.$queryRawUnsafe(`SELECT to_regclass('public."${t}"')::text AS r`))[0].r;
        if (!reg) after.push(t);
      }
      if (after.length > 0) throw new Error(`catch-up incomplete — still missing: ${after.join(", ")}`);
      console.log("[catch-up] all Wave-3 tables now present");
    } else {
      console.log("[catch-up] all Wave-3 tables already present");
    }
  }

  // READ-ONLY substrate verification (merge-closure checks).
  if (VERIFY_ONLY) {
    const w3 = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w3_tenant'`))[0].c);
    ok("verify-only: 15 Wave-3 policies present", w3 === 15, `found ${w3}`);
    const forcedV = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_class WHERE relname IN (${WAVE3.map((t) => `'${t}'`).join(",")}) AND relrowsecurity AND relforcerowsecurity`
    ))[0].c);
    ok("verify-only: 15 tables ENABLE+FORCE", forcedV === 15, `found ${forcedV}`);
    const posNoRls = (await owner.$queryRawUnsafe(`SELECT relrowsecurity AS r FROM pg_class WHERE relname='POSApiKey'`))[0];
    ok("verify-only: POSApiKey stays non-RLS (special)", posNoRls?.r === false);
    const resV = await owner.$queryRawUnsafe(
      `SELECT (SELECT count(*)::int FROM "Business" WHERE name LIKE '${MARK}%') AS biz, (SELECT count(*)::int FROM "User" WHERE email LIKE '%@p7w3.test') AS usr`
    );
    ok("verify-only: synthetic residue = 0", Number(resV[0].biz) === 0 && Number(resV[0].usr) === 0, JSON.stringify(resV[0]));
    const g = (await owner.$queryRawUnsafe(`SELECT has_table_privilege('${RT_ROLE}', '"InventoryItem"', 'SELECT') AS a, has_table_privilege('${RT_ROLE}', '"InventoryItem"', 'DELETE') AS b`))[0];
    ok("verify-only: grant posture (Item SELECT=yes, DELETE=no)", g.a === true && g.b === false, JSON.stringify(g));
    await owner.$disconnect();
    console.log(`\n[battery] target=${TARGET} mode=verify-only PASS=${pass} FAIL=${fail}`);
    if (fail > 0) { console.log("FAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
    console.log("ALL CHECKS PASS");
    return;
  }

  // ---------- Phase 2 (pg only): lab substrate ----------
  if (TARGET === "pg") {
    const rtExists = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_roles WHERE rolname='${RT_ROLE}'`))[0].c) > 0;
    if (!rtExists) {
      await owner.$executeRawUnsafe(`CREATE ROLE ${RT_ROLE} LOGIN PASSWORD 'p7w1_ci_synthetic_pw' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT`);
    }
    await owner.$executeRawUnsafe(`GRANT SELECT ON "User", "Business" TO ${RT_ROLE}`);
    const admExists = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_roles WHERE rolname='${ADMIN_LOGIN}'`))[0].c) > 0;
    if (!admExists) {
      await owner.$executeRawUnsafe(`CREATE ROLE ${ADMIN_LOGIN} LOGIN PASSWORD '${ADMIN_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION INHERIT`);
    }
    await applySqlFile("prisma/migrations/20260825090000_d2_p7_w2gate_admin_read/migration.sql");
    // Wave-2 substrate too, so the lab mirrors Preview and the rollback proof
    // can assert prior-wave policies (24 tenant + 3rd admin) stay untouched.
    await applySqlFile("prisma/migrations/20260825150000_d2_p7_wave2_tenant_rls/migration.sql");
    await applySqlFile("scripts/security/d2-p7-w2gate-admin-grants.sql", { ":LOGIN_ROLE": ADMIN_LOGIN });
    await applySqlFile("scripts/security/d2-p7-wave2-grants.sql", { ":ROLE": RT_ROLE });
  }

  // ---------- Phase 3: apply Wave-3 migration + grants ----------
  const nMig = await applySqlFile("prisma/migrations/20260825200000_d2_p7_wave3_tenant_rls/migration.sql");
  const nGr = await applySqlFile("scripts/security/d2-p7-wave3-grants.sql", { ":ROLE": RT_ROLE });
  console.log(`[apply] wave3 migration statements=${nMig} grant statements=${nGr}`);
  const w3pol = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w3_tenant'`))[0].c);
  ok("15 p7w3_tenant policies installed", w3pol === 15, `found ${w3pol}`);
  const forced = Number((await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM pg_class WHERE relname IN (${WAVE3.map((t) => `'${t}'`).join(",")}) AND relrowsecurity AND relforcerowsecurity`
  ))[0].c);
  ok("15 tables ENABLE+FORCE RLS", forced === 15, `found ${forced}`);
  const posRls = (await owner.$queryRawUnsafe(`SELECT relrowsecurity AS r FROM pg_class WHERE relname='POSApiKey'`))[0];
  ok("POSApiKey deliberately non-RLS (special)", posRls?.r === false);

  // ---------- Phase 4: fixtures ----------
  const { createHash } = await import("node:crypto");
  const keyHashA = createHash("sha256").update(Buffer.from(POS_KEY_A, "utf8")).digest("hex");

  const cleanup = async () => {
    const bids = `SELECT id FROM "Business" WHERE name LIKE '${MARK}%'`;
    await owner.$executeRawUnsafe(`DELETE FROM "ReceivingLine" WHERE "receivingSessionId" IN (SELECT id FROM "ReceivingSession" WHERE "businessId" IN (${bids}))`);
    for (const t of ["ReceivingSession"]) await owner.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "businessId" IN (${bids})`);
    await owner.$executeRawUnsafe(`DELETE FROM "PurchaseOrderLine" WHERE "purchaseOrderId" IN (SELECT id FROM "PurchaseOrder" WHERE "businessId" IN (${bids}))`);
    for (const t of ["PurchaseOrder"]) await owner.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "businessId" IN (${bids})`);
    await owner.$executeRawUnsafe(`DELETE FROM "SupplierPurchaseDraftLine" WHERE "draftId" IN (SELECT id FROM "SupplierPurchaseDraft" WHERE "businessId" IN (${bids}))`);
    for (const t of ["SupplierPurchaseDraft","Supplier","POSProductMapping","InventoryExternalSale","InventoryPendingMatch","InventoryAlert","InventoryMovement","InventoryDraft","InventoryItem","InventoryCategory","POSApiKey"]) {
      await owner.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "businessId" IN (${bids})`);
    }
    await owner.$executeRawUnsafe(`DELETE FROM "User" WHERE email LIKE '%@p7w3.test'`);
    await owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE name LIKE '${MARK}%'`);
  };
  await cleanup();

  const bizA = await owner.business.create({ data: { name: `${MARK}A` } });
  const bizB = await owner.business.create({ data: { name: `${MARK}B` } });
  const userA = await owner.user.create({ data: { email: "a@p7w3.test", password: "x", businessId: bizA.id } });
  const userB = await owner.user.create({ data: { email: "b@p7w3.test", password: "x", businessId: bizB.id } });
  const itemA = await owner.inventoryItem.create({ data: { businessId: bizA.id, name: `${MARK}item-A`, unitType: "UNIT", currentQuantity: 100, sku: `${MARK}SKU-A` } });
  const itemB = await owner.inventoryItem.create({ data: { businessId: bizB.id, name: `${MARK}item-B`, unitType: "UNIT", currentQuantity: 100, sku: `${MARK}SKU-B` } });
  const catB = await owner.inventoryCategory.create({ data: { businessId: bizB.id, name: `${MARK}cat-B` } });
  const supA = await owner.supplier.create({ data: { businessId: bizA.id, name: `${MARK}sup-A` } });
  const supB = await owner.supplier.create({ data: { businessId: bizB.id, name: `${MARK}sup-B` } });
  const draftB = await owner.supplierPurchaseDraft.create({
    data: { businessId: bizB.id, supplierName: `${MARK}sup-B`, lines: { create: [{ rawName: "x", quantity: 1, status: "PENDING" }] } },
  });
  const poB = await owner.purchaseOrder.create({
    data: { businessId: bizB.id, supplierId: supB.id, status: "CONFIRMED", lines: { create: [{ itemId: itemB.id, orderedQty: 5 }] } },
    include: { lines: true },
  });
  await owner.pOSApiKey.create({ data: { businessId: bizA.id, keyHash: keyHashA, source: "POS", active: true } });
  await owner.pOSProductMapping.create({ data: { businessId: bizB.id, source: "POS", itemId: itemB.id, sku: `${MARK}SKU-B` } });
  console.log(`[fixtures] A=${bizA.id} B=${bizB.id}`);

  // ---------- Phase 5: connections ----------
  const adminUrlObj = new URL(RUNTIME_URL);
  adminUrlObj.username = ADMIN_LOGIN;
  adminUrlObj.password = ADMIN_PW;
  const ADMIN_URL = adminUrlObj.toString();
  const rt = new PrismaClient({ datasourceUrl: RUNTIME_URL });
  const rt2 = new PrismaClient({ datasourceUrl: RUNTIME_URL });
  for (let i = 0; i < 6; i++) { try { await rt.$queryRaw`SELECT 1`; break; } catch (e) { if (i === 5) throw e; await sleep(2000); } }
  const adm = new PrismaClient({ datasourceUrl: ADMIN_URL });
  for (let i = 0; i < 6; i++) { try { await adm.$queryRaw`SELECT 1`; break; } catch (e) { if (i === 5) throw e; await sleep(2000); } }
  const rtWho = (await rt.$queryRawUnsafe(`SELECT current_user::text AS u`))[0].u;
  ok(`tenant runtime current_user = ${RT_ROLE}`, rtWho === RT_ROLE, `got ${rtWho}`);

  const rtx = (client, businessId, fn) =>
    client.$transaction(async (t) => {
      if (businessId != null) await t.$queryRaw`SELECT set_config('app.current_business_id', ${String(businessId)}, true)`;
      return fn(t);
    });
  const inIds = { in: [bizA.id, bizB.id] };

  // ---------- Phase 6: direct + indirect ----------
  console.log("--- direct tenancy ---");
  const dItems = await rtx(rt, bizA.id, (t) => t.inventoryItem.findMany({ where: { businessId: inIds } }));
  ok("A sees only A items", dItems.length === 1 && dItems[0].id === itemA.id, `got ${dItems.length}`);
  await expectThrow("wrong-tenant InventoryItem INSERT rejected", () =>
    rtx(rt, bizA.id, (t) => t.inventoryItem.create({ data: { businessId: bizB.id, name: `${MARK}evil`, unitType: "UNIT" } })),
    ["row-level security", "violates"]);
  const updX = await rtx(rt, bizA.id, (t) => t.inventoryItem.updateMany({ where: { id: itemB.id }, data: { name: "evil" } }));
  ok("wrong-tenant item UPDATE = 0 rows", updX.count === 0);
  ok("B's item untouched (owner verify)", (await owner.inventoryItem.findUnique({ where: { id: itemB.id } }))?.name === `${MARK}item-B`);
  console.log("--- indirect (parent-join) ---");
  const poLines = await rtx(rt, bizA.id, (t) => t.purchaseOrderLine.findMany({ where: { purchaseOrderId: poB.id } }));
  ok("A cannot see B's PO lines", poLines.length === 0);
  await expectThrow("wrong-parent PurchaseOrderLine INSERT rejected", () =>
    rtx(rt, bizA.id, (t) => t.purchaseOrderLine.create({ data: { purchaseOrderId: poB.id, orderedQty: 1 } })),
    ["row-level security", "violates"]);
  const draftLines = await rtx(rt, bizA.id, (t) => t.supplierPurchaseDraftLine.findMany({ where: { draftId: draftB.id } }));
  ok("A cannot see B's draft lines", draftLines.length === 0);

  // ---------- Phase 7: relational cross-tenant attacks (real code paths) ----------
  console.log("--- relational cross-tenant attacks ---");
  process.env.DATABASE_URL = RUNTIME_URL;
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { withTenantTransaction } = await import("@/lib/tenant/transaction");
  const { inventoryService } = await import("@/lib/services/inventory/inventory.service");
  const { purchaseOrderService } = await import("@/lib/services/inventory/purchase-order.service");
  const { receivingService } = await import("@/lib/services/inventory/receiving.service");
  const { approveSupplierPurchase } = await import("@/lib/services/inventory/supplier-purchase-approval.service");
  const { resolvePendingMatchWithExistingItem, createPendingMatch } = await import("@/lib/services/inventory/pending-match.service");

  await expectThrow("A movement referencing B's item denied (service + RLS)", () =>
    runWithTenantContext({ businessId: bizA.id }, () =>
      withTenantTransaction((tx) =>
        inventoryService.createMovement({ businessId: bizA.id, itemId: itemB.id, movementType: "OUT", reason: "SALE", quantityDelta: 5 }, { tx })
      )
    ), []);
  await expectThrow("A purchase order referencing B's item denied", () =>
    runWithTenantContext({ businessId: bizA.id }, () =>
      withTenantTransaction((tx) =>
        purchaseOrderService.createPurchaseOrder({ businessId: bizA.id, supplierName: "x", lines: [{ itemId: itemB.id, orderedQty: 1 }] }, { tx })
      )
    ), []);
  await expectThrow("A purchase order referencing B's supplier denied", () =>
    runWithTenantContext({ businessId: bizA.id }, () =>
      withTenantTransaction((tx) =>
        purchaseOrderService.createPurchaseOrder({ businessId: bizA.id, supplierId: supB.id, lines: [{ itemId: itemA.id, orderedQty: 1 }] }, { tx })
      )
    ), []);
  await expectThrow("A receiving session on B's PO denied", () =>
    runWithTenantContext({ businessId: bizA.id }, () =>
      withTenantTransaction((tx) =>
        receivingService.createReceivingSession({ businessId: bizA.id, purchaseOrderId: poB.id, lines: [{ purchaseOrderLineId: poB.lines[0].id, receivedQty: 1 }] }, { tx })
      )
    ), []);
  await expectThrow("A approval consuming B's draft denied", () =>
    runWithTenantContext({ businessId: bizA.id }, () =>
      withTenantTransaction((tx) =>
        approveSupplierPurchase({ draftId: draftB.id, businessId: bizA.id, userId: userA.id, lines: [{ lineId: 1, action: "MERGE", itemId: itemA.id }] }, { tx })
      )
    ), ["Draft already processed"]);
  // Pending match of A resolved against B's item.
  const pmA = await runWithTenantContext({ businessId: bizA.id }, () =>
    withTenantTransaction((tx) =>
      createPendingMatch({ businessId: bizA.id, externalSaleId: `${MARK}pm-1`, metadata: { externalSaleId: `${MARK}pm-1`, sku: null, barcode: null, name: "x", quantity: 1, source: "POS" } }, { tx })
    )
  );
  await expectThrow("A pending match cannot bind B's item", () =>
    runWithTenantContext({ businessId: bizA.id }, () =>
      withTenantTransaction((tx) =>
        resolvePendingMatchWithExistingItem({ pendingMatchId: pmA.id, businessId: bizA.id, userId: userA.id, itemId: itemB.id }, { tx })
      )
    ), []);
  ok("B stock untouched after all attacks (owner verify)", (await owner.inventoryItem.findUnique({ where: { id: itemB.id } }))?.currentQuantity === 100);

  // ---------- Phase 8: fail-closed / raw / tx / concurrency / least-priv ----------
  console.log("--- fail-closed + raw + tx + concurrency + least-priv ---");
  ok("no context -> 0 items", (await rt.inventoryItem.findMany({ where: { businessId: inIds } })).length === 0);
  const emptyCtx = await rt.$transaction(async (t) => { await t.$queryRaw`SELECT set_config('app.current_business_id', '', true)`; return t.supplier.findMany({ where: { businessId: inIds } }); });
  ok("empty context -> 0 suppliers", emptyCtx.length === 0);
  await expectThrow("malformed context errors", () =>
    rt.$transaction(async (t) => { await t.$queryRaw`SELECT set_config('app.current_business_id', 'evil', true)`; return t.inventoryItem.findMany({}); }),
    ["invalid input syntax", "22P02"]);
  const rawD = await rtx(rt, bizA.id, (t) => t.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "InventoryItem" WHERE "businessId" IN (${bizA.id},${bizB.id})`));
  ok("raw direct = tenant-only", Number(rawD[0].c) === 1);
  const rawI = await rtx(rt, bizB.id, (t) => t.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "PurchaseOrderLine"`));
  ok("raw indirect = tenant-only (B sees its PO line)", Number(rawI[0].c) === 1);
  await expectThrow("rollback discards tenant write", () =>
    rtx(rt, bizA.id, async (t) => {
      await t.supplier.create({ data: { businessId: bizA.id, name: `${MARK}rb` } });
      throw new Error("forced rollback");
    }), ["forced rollback"]);
  ok("rolled-back supplier absent", (await owner.supplier.count({ where: { name: `${MARK}rb` } })) === 0);
  const seqA = await rtx(rt, bizA.id, (t) => t.supplier.findMany({ where: { name: { startsWith: MARK } } }));
  const seqB = await rtx(rt, bizB.id, (t) => t.supplier.findMany({ where: { name: { startsWith: MARK } } }));
  ok("sequential A->B no bleed", seqA.length === 1 && seqA[0].id === supA.id && seqB.length === 1 && seqB[0].id === supB.id);
  const [cA, cB] = await Promise.all([
    rtx(rt, bizA.id, async (t) => { await t.$executeRawUnsafe("SELECT pg_sleep(0.05)"); return t.inventoryItem.findMany({ where: { businessId: inIds } }); }),
    rtx(rt2, bizB.id, async (t) => { await t.$executeRawUnsafe("SELECT pg_sleep(0.02)"); return t.inventoryItem.findMany({ where: { businessId: inIds } }); }),
  ]);
  ok("concurrent A/B isolated", cA.length === 1 && cA[0].id === itemA.id && cB.length === 1 && cB[0].id === itemB.id);
  await expectThrow("runtime DDL denied", () => rt.$executeRawUnsafe(`CREATE TABLE p7w3_evil (id int)`), ["permission denied", "42501"]);
  await expectThrow("runtime _prisma_migrations denied", () => rt.$queryRawUnsafe(`SELECT count(*) FROM _prisma_migrations`), ["permission denied", "does not exist", "42501", "42P01"]);
  await expectThrow("runtime DELETE on InventoryItem denied (verb never granted)", () =>
    rtx(rt, bizA.id, (t) => t.inventoryItem.deleteMany({ where: { id: itemA.id } })), ["permission denied", "42501"]);

  console.log("--- admin interaction (no Wave-3 admin surface) ---");
  await expectThrow("admin read of Wave-3 tenant table denied loudly (no grant)", () =>
    adm.inventoryItem.findMany({}), ["permission denied", "42501"]);
  const [tenC, admC] = await Promise.all([
    rtx(rt, bizA.id, (t) => t.inventoryItem.count({ where: { businessId: inIds } })),
    adm.conversation.count(),
  ]);
  ok("tenant/admin concurrency clean (tenant=1 item, admin count works)", tenC === 1 && admC >= 0);

  // ---------- Phase 9: REAL routes ----------
  console.log("--- real routes (Bearer + POS key) ---");
  const { NextRequest } = await import("next/server");
  const { signAuthToken } = await import("@/lib/auth-token");
  const tokA = signAuthToken(userA.id);
  const tokB = signAuthToken(userB.id);
  const jreq = (url, method, tok, body) =>
    new NextRequest(`http://p7w3.local${url}`, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const P = (obj) => ({ params: Promise.resolve(obj) });

  // Inventory cluster
  const itemsRoute = await import("@/app/api/inventory/items/route");
  let res = await itemsRoute.POST(jreq("/api/inventory/items", "POST", tokA, { name: `${MARK}h-item`, unitType: "UNIT", initialQuantity: 10, businessId: bizB.id }));
  ok("items POST 201", res.status === 201, `status=${res.status}`);
  const hItem = (await res.json()).item;
  ok("malicious businessId in body ignored (server-derived)", hItem.businessId === bizA.id, `got ${hItem.businessId}`);
  res = await itemsRoute.GET(jreq("/api/inventory/items", "GET", tokB));
  const bItems = (await res.json()).items;
  ok("items GET (B): only B's items", res.status === 200 && bItems.every((i) => i.businessId === bizB.id));
  const itemIdRoute = await import("@/app/api/inventory/items/[id]/route");
  res = await itemIdRoute.PATCH(new NextRequest(`http://p7w3.local/api/inventory/items/${hItem.id}`, { method: "PATCH", headers: { authorization: `Bearer ${tokB}`, "content-type": "application/json" }, body: JSON.stringify({ name: "evil" }) }));
  ok("items PATCH cross-tenant -> 404", res.status === 404, `status=${res.status}`);
  res = await itemIdRoute.PATCH(new NextRequest(`http://p7w3.local/api/inventory/items/${hItem.id}`, { method: "PATCH", headers: { authorization: `Bearer ${tokA}`, "content-type": "application/json" }, body: JSON.stringify({ categoryId: catB.id }) }));
  ok("items PATCH with B's category -> 400 (foreign related id rejected)", res.status === 400, `status=${res.status}`);
  const movesRoute = await import("@/app/api/inventory/movements/route");
  res = await movesRoute.POST(jreq("/api/inventory/movements", "POST", tokA, { itemId: hItem.id, movementType: "IN", reason: "MANUAL_ADD", quantityDelta: 5 }));
  ok("movements POST own = 201", res.status === 201, `status=${res.status}`);
  res = await movesRoute.POST(jreq("/api/inventory/movements", "POST", tokA, { itemId: itemB.id, movementType: "OUT", reason: "SALE", quantityDelta: 1 }));
  ok("movements POST foreign item -> 404", res.status === 404, `status=${res.status}`);

  // Supplier cluster (approve drives PO + receiving + post atomically)
  const supRoute = await import("@/app/api/inventory/suppliers/route");
  res = await supRoute.POST(jreq("/api/inventory/suppliers", "POST", tokA, { name: `${MARK}h-sup` }));
  ok("suppliers POST 201", res.status === 201, `status=${res.status}`);
  const supIdRoute = await import("@/app/api/inventory/suppliers/[id]/route");
  res = await supIdRoute.GET(jreq(`/api/inventory/suppliers/${supB.id}`, "GET", tokA), P({ id: String(supB.id) }));
  ok("suppliers GET cross-tenant -> 404", res.status === 404, `status=${res.status}`);
  const spRoute = await import("@/app/api/inventory/supplier-purchases/route");
  res = await spRoute.POST(jreq("/api/inventory/supplier-purchases", "POST", tokA, { supplierName: `${MARK}h-sup`, lines: [{ rawName: `${MARK}h-item`, quantity: 3 }] }));
  ok("supplier-purchases POST 201", res.status === 201, `status=${res.status}`);
  const spDraft = (await res.json()).draft;
  const approveRoute = await import("@/app/api/inventory/supplier-purchases/[id]/approve/route");
  res = await approveRoute.POST(jreq(`/api/inventory/supplier-purchases/${spDraft.id}/approve`, "POST", tokA, {
    lines: spDraft.lines.map((l) => ({ lineId: l.id, action: "MERGE", itemId: hItem.id })),
  }), P({ id: String(spDraft.id) }));
  ok("supplier purchase approve (PO+receiving+post chain) = 200", res.status === 200, `status=${res.status} ${res.status !== 200 ? JSON.stringify(await res.json()).slice(0,120) : ""}`);
  const stockAfter = await owner.inventoryItem.findUnique({ where: { id: hItem.id } });
  ok("approved receiving posted stock into A's item", stockAfter?.currentQuantity === 18, `qty=${stockAfter?.currentQuantity}`);
  res = await approveRoute.POST(jreq(`/api/inventory/supplier-purchases/${draftB.id}/approve`, "POST", tokA, { lines: [{ lineId: 1, action: "MERGE", itemId: hItem.id }] }), P({ id: String(draftB.id) }));
  ok("approve of B's draft as A -> 4xx", res.status >= 400, `status=${res.status}`);

  // POS cluster (real route with x-pos-key)
  const posRoute = await import("@/app/api/inventory/pos/sale/route");
  const posReq = (key, body) => new NextRequest("http://p7w3.local/api/inventory/pos/sale", { method: "POST", headers: { "x-pos-key": key, "content-type": "application/json" }, body: JSON.stringify(body) });
  res = await posRoute.POST(posReq("wrong-key", { externalSaleId: "s1", items: [{ sku: `${MARK}SKU-A`, quantity: 1 }] }));
  ok("POS bad key -> 401", res.status === 401, `status=${res.status}`);
  res = await posRoute.POST(posReq(POS_KEY_A, { externalSaleId: `${MARK}sale-1`, businessId: bizB.id, items: [{ sku: `${MARK}SKU-A`, quantity: 2 }] }));
  let posBody = await res.json();
  ok("POS sale processed under KEY's business (body businessId ignored)", res.status === 200 && posBody.pending === false, `status=${res.status} ${JSON.stringify(posBody).slice(0,80)}`);
  const itemAAfter = await owner.inventoryItem.findUnique({ where: { id: itemA.id } });
  ok("POS sale consumed A's stock only", itemAAfter?.currentQuantity === 98, `qty=${itemAAfter?.currentQuantity}`);
  ok("B stock still untouched", (await owner.inventoryItem.findUnique({ where: { id: itemB.id } }))?.currentQuantity === 100);
  res = await posRoute.POST(posReq(POS_KEY_A, { externalSaleId: `${MARK}sale-1`, items: [{ sku: `${MARK}SKU-A`, quantity: 2 }] }));
  posBody = await res.json();
  ok("POS replay idempotent (skipped)", posBody.skipped === true);
  res = await posRoute.POST(posReq(POS_KEY_A, { externalSaleId: `${MARK}sale-2`, items: [{ sku: `${MARK}SKU-B`, quantity: 1 }] }));
  posBody = await res.json();
  ok("POS sale with B's SKU -> pending in A (cannot touch B's item/mapping)", res.status === 200 && posBody.pending === true, JSON.stringify(posBody).slice(0, 80));
  ok("B stock STILL untouched after foreign-SKU attempt", (await owner.inventoryItem.findUnique({ where: { id: itemB.id } }))?.currentQuantity === 100);
  const pmRows = await owner.inventoryPendingMatch.findMany({ where: { externalSaleId: `${MARK}sale-2` } });
  ok("pending match landed under A (key's tenant)", pmRows.length === 1 && pmRows[0].businessId === bizA.id);

  await rt.$disconnect(); await rt2.$disconnect(); await adm.$disconnect();

  // ---------- Phase 10 (pg only): rollback proof + re-apply ----------
  if (TARGET === "pg") {
    console.log("--- rollback proof ---");
    await applySqlFile("scripts/security/d2-p7-wave3-rollback.sql", { ":ROLE": RT_ROLE });
    const polAfter = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w3_tenant'`))[0].c);
    ok("rollback: 0 p7w3 policies remain", polAfter === 0, `found ${polAfter}`);
    const w2Still = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w2_tenant'`))[0].c);
    ok("rollback: Wave-2 policies intact", w2Still === 24, `found ${w2Still}`);
    const admStill = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7adm_read'`))[0].c);
    ok("rollback: admin policies intact", admStill === 3, `found ${admStill}`);
    const canSel = (await owner.$queryRawUnsafe(`SELECT has_table_privilege('${RT_ROLE}', '"InventoryItem"', 'SELECT') AS p`))[0].p;
    ok("rollback: runtime grants revoked", canSel === false);
    await applySqlFile("prisma/migrations/20260825200000_d2_p7_wave3_tenant_rls/migration.sql");
    await applySqlFile("scripts/security/d2-p7-wave3-grants.sql", { ":ROLE": RT_ROLE });
    const polRe = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w3_tenant'`))[0].c);
    ok("re-apply after rollback (idempotency)", polRe === 15, `found ${polRe}`);
  }

  // ---------- Phase 11: cleanup + integrity ----------
  await cleanup();
  const residue = await owner.$queryRawUnsafe(
    `SELECT (SELECT count(*)::int FROM "Business" WHERE name LIKE '${MARK}%') AS biz, (SELECT count(*)::int FROM "User" WHERE email LIKE '%@p7w3.test') AS usr`
  );
  ok("synthetic residue = 0", Number(residue[0].biz) === 0 && Number(residue[0].usr) === 0, JSON.stringify(residue[0]));
  if (TARGET === "neon") {
    const p5 = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p4b_tenant'`))[0].c);
    const w1a = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w1_tenant'`))[0].c);
    const w2a = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w2_tenant'`))[0].c);
    const ada = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7adm_read'`))[0].c);
    ok("pilot(5)+wave1(14)+wave2(24)+admin(3) intact after Wave 3", p5 === 5 && w1a === 14 && w2a === 24 && ada === 3, `p=${p5} w1=${w1a} w2=${w2a} a=${ada}`);
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
