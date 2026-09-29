/**
 * Tenant/RLS closure — the battery for the five tables repaired by 20260929090000_tenant_rls_closure:
 * InventorySale, InventorySaleLine, InventorySourceSaleLine, BusinessAsset, CouponSurfaceEvent.
 *
 * Real PostgreSQL, the shipped tenant policies and the closure migration replayed, and a runtime role
 * MEASURED NOSUPERUSER + NOBYPASSRLS before anything is believed. Never the owner role as proof.
 *
 *   R1  catalog: ENABLE + FORCE, per-command policies only, exact runtime privileges
 *   R2  no tenant context → zero rows visible, writes refused
 *   R3  A sees A only; B sees B only
 *   R4  cross-tenant INSERT / UPDATE / DELETE refused
 *   R5  cross-tenant parent links refused (composite tenant keys)
 *   R6  stale / switched context: nothing leaks between transactions; switching inside a context refused
 *   R7  background job (runTenantJob) and replay: correct tenant only, idempotent
 *   R8  the legitimate product flows still work under FORCE: sale, source lines + link, asset, coupon page
 *
 * Output is labels and PASS/FAIL only. Synthetic lab data; nothing here touches Production.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import crypto from "node:crypto";

const ADMIN_URL = process.env.M0_ADMIN_URL ?? process.env.DATABASE_URL;
if (!ADMIN_URL) throw new Error("M0_ADMIN_URL (or DATABASE_URL) must point at a throwaway lab cluster");
for (const host of ["ep-flat-brook-am4bhq1y", "ep-winter-bread-ami5o8p5"]) {
  if (ADMIN_URL.includes(host)) throw new Error(`DENY: ${host} is not a laboratory`);
}
const NONCE = crypto.randomBytes(4).toString("hex");
const RT_ROLE = `rls_rt_${NONCE}`;
const RT_PW = crypto.randomBytes(18).toString("hex");
const GROUP = "app_runtime";
const CLOSURE = "prisma/migrations/20260929090000_tenant_rls_closure/migration.sql";
const TABLES = ["InventorySale", "InventorySaleLine", "InventorySourceSaleLine", "BusinessAsset", "CouponSurfaceEvent"];
const KEY: Record<string, string> = { CouponSurfaceEvent: "issuingBusinessId" };
const keyOf = (t: string) => KEY[t] ?? "businessId";

let passed = 0;
let failed = 0;
const fails: string[] = [];
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  [PASS] ${label}`); }
  else { failed++; fails.push(label); console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`); }
}
function section(t: string): void { console.log(`\n== ${t} ==`); }
const owner = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });

function sqlStatements(file: string, keep: RegExp, drop?: RegExp): string[] {
  const sql = readFileSync(join(process.cwd(), file), "utf8").replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  const out: string[] = [];
  let cur = "";
  let tag: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const m = /^\$\w*\$/.exec(sql.slice(i, i + 40));
    if (m) { tag = tag === null ? m[0] : tag === m[0] ? null : tag; cur += m[0]; i += m[0].length - 1; continue; }
    if (sql[i] === ";" && tag === null) { out.push(cur.trim()); cur = ""; continue; }
    cur += sql[i];
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter((s) => s && keep.test(s) && !(drop && drop.test(s)));
}
async function refused(p: Promise<unknown>, pattern?: RegExp): Promise<boolean> {
  try { await p; return false; } catch (e) { return pattern ? pattern.test(String((e as Error).message ?? e)) : true; }
}

async function main(): Promise<void> {
  section("Provision — the lab mirrors Production's enforcement, plus the shipped closure migration");
  await owner.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${GROUP}') THEN CREATE ROLE ${GROUP} NOLOGIN; END IF; END $$`);
  await owner.$executeRawUnsafe(`CREATE ROLE ${RT_ROLE} LOGIN PASSWORD '${RT_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION IN ROLE ${GROUP}`);
  for (const f of [
    "prisma/migrations/20260825150000_d2_p7_wave2_tenant_rls/migration.sql",
    "prisma/migrations/20260825200000_d2_p7_wave3_tenant_rls/migration.sql",
    "prisma/migrations/20260827090000_d2_p7_w4d_documents_tenant_rls/migration.sql",
    CLOSURE,
  ]) for (const s of sqlStatements(f, /ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY/, /app_admin|^DO /)) await owner.$executeRawUnsafe(s);
  await owner.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${GROUP}`);
  await owner.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${GROUP}`);
  // …then the closure's grant block exactly as shipped, which REVOKEs what the blanket grant just gave
  // (the same effect Production's ALTER DEFAULT PRIVILEGES has before this migration).
  const grantBlocks = sqlStatements(CLOSURE, /^DO \$do\$/);
  for (const s of grantBlocks) await owner.$executeRawUnsafe(s);
  check("the closure migration replays: 10 RLS statements, 11 policies, one grant block",
    sqlStatements(CLOSURE, /ROW LEVEL SECURITY/).length === 10 && sqlStatements(CLOSURE, /^CREATE POLICY/).length === 11 && grantBlocks.length === 1);

  const rtUrl = (() => { const u = new URL(ADMIN_URL!); u.username = RT_ROLE; u.password = RT_PW; return u.toString(); })();
  process.env.DATABASE_URL = rtUrl;
  process.env.DIRECT_URL = rtUrl;
  const rt = new PrismaClient({ datasources: { db: { url: rtUrl } } });
  const posture = await owner.$queryRawUnsafe<{ s: boolean; b: boolean }[]>(`SELECT rolsuper AS s, rolbypassrls AS b FROM pg_roles WHERE rolname='${RT_ROLE}'`);
  check("the runtime role is NOSUPERUSER + NOBYPASSRLS", posture[0]?.s === false && posture[0]?.b === false);
  check("the application code is connected as the restricted role", (await rt.$queryRawUnsafe<{ u: string }[]>(`SELECT current_user AS u`))[0]?.u === RT_ROLE);

  section("R1 — catalog");
  const cat = await rt.$queryRawUnsafe<{ t: string; r: boolean; f: boolean; sel: boolean; ins: boolean; upd: boolean; del: boolean }[]>(
    `SELECT c.relname AS t, c.relrowsecurity AS r, c.relforcerowsecurity AS f,
            has_table_privilege(current_user, c.oid, 'SELECT') AS sel, has_table_privilege(current_user, c.oid, 'INSERT') AS ins,
            has_table_privilege(current_user, c.oid, 'UPDATE') AS upd, has_table_privilege(current_user, c.oid, 'DELETE') AS del
       FROM pg_class c WHERE c.relname = ANY($1::text[])`, TABLES);
  const row = (t: string) => cat.find((c) => c.t === t)!;
  check("all five are ENABLE + FORCE RLS", cat.length === 5 && cat.every((c) => c.r && c.f));
  check("runtime: SELECT + INSERT everywhere, UPDATE only on InventorySourceSaleLine, DELETE nowhere",
    TABLES.every((t) => row(t).sel && row(t).ins && !row(t).del && row(t).upd === (t === "InventorySourceSaleLine")));
  const pol = await owner.$queryRawUnsafe<{ t: string; cmd: string; n: number }[]>(
    `SELECT tablename AS t, cmd, count(*)::int AS n FROM pg_policies WHERE tablename = ANY($1::text[]) GROUP BY 1, 2`, TABLES);
  check("per-command policies only (no FOR ALL, no DELETE policy), 11 in total",
    !pol.some((p) => p.cmd === "ALL" || p.cmd === "DELETE") && pol.reduce((a, p) => a + p.n, 0) === 11);

  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { runTenantJob } = await import("@/lib/tenant/job");
  const { recordInventorySale } = await import("@/lib/services/inventory/sale-evidence.service");
  const { recordInventorySourceSaleLines, linkSourceLinesToSale } = await import("@/lib/services/inventory/sale-source-lines.service");
  const { recordBusinessAsset } = await import("@/lib/services/content/business-asset.service");
  const { getPublicCouponDetails } = await import("@/lib/services/revenue/coupon-details-public.service");

  section("Seed — two look-alike businesses, each with every kind of row (as the owner, lab only)");
  type Seed = { biz: number; item: number; sale: number; saleLine: number; source: number; asset: number; run: number; offer: number; coupon: number; publicId: string; surface: number };
  const seeds: Seed[] = [];
  for (const label of ["A", "B"]) {
    const b = await owner.business.create({ data: { name: `RLS ${label} ${NONCE}` } });
    const item = await owner.inventoryItem.create({ data: { businessId: b.id, name: "lab item", unitType: "UNIT", currentQuantity: 100 } as never });
    const mv = await owner.inventoryMovement.create({ data: { businessId: b.id, itemId: item.id, movementType: "OUT", reason: "SALE", quantityDelta: -1, quantityBefore: 100, quantityAfter: 99 } as never });
    const sale = await owner.inventorySale.create({ data: { businessId: b.id, source: "lab", idempotencyKey: `seed-${NONCE}-${label}` } as never });
    const line = await owner.inventorySaleLine.create({ data: { businessId: b.id, saleId: sale.id, itemId: item.id, movementId: mv.id, quantity: 1, lineKey: "seed" } as never });
    const src = await owner.inventorySourceSaleLine.create({ data: { businessId: b.id, externalSaleId: `seed-${label}`, lineKey: "seed", quantity: 1 } as never });
    const run = await owner.contentRun.create({ data: { businessId: b.id, inputSnapshot: {} } as never });
    const asset = await owner.businessAsset.create({ data: { businessId: b.id, origin: "OWNER_UPLOAD", storageKey: `seed/${NONCE}/${label}` } as never });
    const offer = await owner.offer.create({ data: { issuingBusinessId: b.id, title: "lab", customerBenefitText: "lab", validUntil: new Date(Date.now() + 30 * 86_400_000) } as never });
    const coupon = await owner.coupon.create({ data: { offerId: offer.id, issuingBusinessId: b.id, token: `tok-${NONCE}-${label}`, qrValue: `qr-${NONCE}-${label}`,
      expiresAt: new Date(Date.now() + 30 * 86_400_000) } as never });
    const surface = await owner.couponSurfaceEvent.create({ data: { issuingBusinessId: b.id, couponId: coupon.id, offerId: offer.id, eventType: "SEED" } });
    seeds.push({ biz: b.id, item: item.id, sale: sale.id, saleLine: line.id, source: src.id, asset: asset.id, run: run.id, offer: offer.id, coupon: coupon.id, publicId: coupon.publicId, surface: surface.id });
  }
  const [A, B] = seeds;
  const countIn = (biz: number, t: string, where = "") =>
    tenantTx(biz, async (tx) => Number((await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${t}" ${where}`))[0].n));

  section("R2 — no tenant context fails closed");
  for (const t of TABLES) {
    const n = Number((await rt.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${t}"`))[0].n);
    check(`${t}: zero rows visible without a tenant`, n === 0, `n=${n}`);
  }
  check("an INSERT without a tenant is refused",
    await refused(rt.$executeRawUnsafe(`INSERT INTO "InventorySale" ("businessId","source","createdAt") VALUES ($1,'x',now())`, A.biz)));

  section("R3 — each tenant sees only itself");
  for (const t of TABLES) {
    const aOwn = await countIn(A.biz, t, `WHERE "${keyOf(t)}" = ${A.biz}`);
    const aForeign = await countIn(A.biz, t, `WHERE "${keyOf(t)}" <> ${A.biz}`);
    const bForeign = await countIn(B.biz, t, `WHERE "${keyOf(t)}" <> ${B.biz}`);
    check(`${t}: A sees its rows, zero of B's; B sees zero of A's`, aOwn >= 1 && aForeign === 0 && bForeign === 0, `${aOwn}/${aForeign}/${bForeign}`);
  }
  check("A cannot fetch B's asset by id", (await tenantTx(A.biz, (tx) => tx.businessAsset.findFirst({ where: { id: B.asset } }))) === null);

  section("R4 — cross-tenant writes refused");
  check("INSERT of a B row from inside A is refused (WITH CHECK)",
    await refused(tenantTx(A.biz, (tx) => tx.businessAsset.create({ data: { businessId: B.biz, origin: "OWNER_UPLOAD", storageKey: `x/${NONCE}` } }))));
  check("INSERT of a B surface event from inside A is refused",
    await refused(tenantTx(A.biz, (tx) => tx.couponSurfaceEvent.create({ data: { issuingBusinessId: B.biz, couponId: B.coupon, offerId: B.offer, eventType: "X" } }))));
  const upd = await tenantTx(A.biz, (tx) => tx.inventorySourceSaleLine.updateMany({ where: { id: B.source }, data: { name: "hijack" } }));
  check("UPDATE of B's source line from inside A touches nothing", upd.count === 0);
  check("moving A's source line to B is refused (WITH CHECK)",
    await refused(tenantTx(A.biz, (tx) => tx.inventorySourceSaleLine.update({ where: { id: A.source }, data: { businessId: B.biz } }))));
  check("UPDATE on the tables the application never updates is refused (no privilege)",
    await refused(tenantTx(A.biz, (tx) => tx.$executeRawUnsafe(`UPDATE "BusinessAsset" SET "publicUseApproved" = true WHERE id = $1`, A.asset))));
  for (const t of TABLES) {
    check(`DELETE on ${t} is refused even for the tenant's own rows (no privilege)`,
      await refused(tenantTx(A.biz, (tx) => tx.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "${keyOf(t)}" = $1`, A.biz))));
  }

  section("R5 — cross-tenant parent links refused");
  // A fresh movement of A's own, so the only thing wrong with the line is its foreign parent.
  const freshMv = await owner.inventoryMovement.create({ data: { businessId: A.biz, itemId: A.item, movementType: "OUT", reason: "SALE", quantityDelta: -1, quantityBefore: 99, quantityAfter: 98 } as never });
  const FK = /foreign key|violates|P2003/i;
  check("a sale line of A pointing at B's sale is refused by the composite tenant key",
    await refused(tenantTx(A.biz, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO "InventorySaleLine" ("businessId","saleId","itemId","movementId","quantity","lineKey","createdAt") VALUES ($1,$2,$3,$4,1,'x',now())`, A.biz, B.sale, A.item, freshMv.id)), FK));
  check("an asset of A pointing at B's content run is refused by the composite tenant key",
    await refused(tenantTx(A.biz, (tx) => tx.businessAsset.create({ data: { businessId: A.biz, origin: "GENERATED", assetRef: `r/${NONCE}`, contentRunId: B.run } })), FK));
  check("a surface event of A pointing at B's coupon is refused by the composite tenant key",
    await refused(tenantTx(A.biz, (tx) => tx.couponSurfaceEvent.create({ data: { issuingBusinessId: A.biz, couponId: B.coupon, offerId: B.offer, eventType: "X" } })), FK));

  section("R6 — stale / switched context");
  const first = await countIn(A.biz, "BusinessAsset");
  const second = await countIn(B.biz, "BusinessAsset", `WHERE "businessId" = ${A.biz}`);
  const after = Number((await rt.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "BusinessAsset"`))[0].n);
  const guc = (await rt.$queryRawUnsafe<{ g: string | null }[]>(`SELECT current_setting('app.current_business_id', true) AS g`))[0].g;
  check("A then B on the same pool: B sees none of A; afterwards nothing is visible and the GUC is empty",
    first >= 1 && second === 0 && after === 0 && (guc === "" || guc === null), `${first}/${second}/${after}/${guc}`);
  const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? countIn(B.biz, "InventorySale", `WHERE "businessId" <> ${B.biz}`) : countIn(A.biz, "InventorySale", `WHERE "businessId" <> ${A.biz}`))));
  check("interleaved concurrent transactions for A and B never see the other tenant", burst.every((n) => n === 0));
  check("switching tenant inside an established context is refused",
    // The refusal is synchronous (thrown on entry), so it is wrapped to be caught as a rejection.
    await refused((async () => runWithTenantContext({ businessId: A.biz }, () => runWithTenantContext({ businessId: B.biz }, async () => 1)))(), /refusing to switch tenant/));

  section("R7 — background job and replay");
  const jobSeen = await runTenantJob({ businessId: A.biz }, () => tenantTx(A.biz, (tx) => tx.inventorySale.findMany({ select: { businessId: true } })));
  check("a tenant job sees only its own tenant", jobSeen.length >= 1 && jobSeen.every((r) => r.businessId === A.biz));

  section("R8 — the product flows still work under FORCE RLS");
  const key = `sale-${NONCE}`;
  const s1 = await recordInventorySale({ businessId: A.biz, source: "manual", idempotencyKey: key, lines: [{ itemId: A.item, quantity: 1, unitPrice: "10.00", lineKey: "l1" }] });
  const s2 = await recordInventorySale({ businessId: A.biz, source: "manual", idempotencyKey: key, lines: [{ itemId: A.item, quantity: 1, unitPrice: "10.00", lineKey: "l1" }] });
  check("a sale records (header + line) and its replay returns the same sale", s1.created && !s2.created && s1.saleId === s2.saleId);
  check("a sale for B's item from A is refused", await refused(recordInventorySale({ businessId: A.biz, source: "manual", lines: [{ itemId: B.item, quantity: 1, unitPrice: null, lineKey: "x" }] })));
  await tenantTx(A.biz, async (tx) => {
    await recordInventorySourceSaleLines(tx, { businessId: A.biz, externalSaleId: `ext-${NONCE}`, lines: [{ lineKey: "l1", sku: null, barcode: null, name: null, quantity: 1, unitPrice: "10.00" }] });
    await recordInventorySourceSaleLines(tx, { businessId: A.biz, externalSaleId: `ext-${NONCE}`, lines: [{ lineKey: "l1", sku: null, barcode: null, name: null, quantity: 1, unitPrice: "10.00" }] });
    await linkSourceLinesToSale(tx, { businessId: A.biz, externalSaleId: `ext-${NONCE}`, saleId: s1.saleId });
  });
  const linked = await owner.inventorySourceSaleLine.findMany({ where: { businessId: A.biz, externalSaleId: `ext-${NONCE}` } });
  check("source lines record idempotently and link to the sale line (the one UPDATE path)", linked.length === 1 && linked[0].saleLineId != null);
  const a1 = await recordBusinessAsset({ businessId: A.biz, origin: "OWNER_UPLOAD", storageKey: `up/${NONCE}`, idempotencyKey: `asset-${NONCE}` });
  const a2 = await recordBusinessAsset({ businessId: A.biz, origin: "OWNER_UPLOAD", storageKey: `up/${NONCE}`, idempotencyKey: `asset-${NONCE}` });
  check("an asset records under FORCE (the service now runs in tenantTx) and its retry returns the same row", a1.created && !a2.created && a1.id === a2.id);
  const a3 = await recordBusinessAsset({ businessId: A.biz, origin: "GENERATED", assetRef: `gen/${NONCE}`, contentRunId: A.run });
  check("a generated asset tied to the business's own content run records", a3.created);
  const before = await owner.couponSurfaceEvent.count({ where: { issuingBusinessId: A.biz } });
  const dto = await getPublicCouponDetails(A.publicId);
  const afterSurf = await owner.couponSurfaceEvent.count({ where: { issuingBusinessId: A.biz } });
  check("the public coupon page still serves, and records its evidence under the ISSUER's tenant", !!dto && afterSurf === before + 1);
  check("… and nothing was recorded for the other business", (await owner.couponSurfaceEvent.count({ where: { issuingBusinessId: B.biz } })) === 1);

  console.log(`\nTenant/RLS closure battery: ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.log(fails.map((f) => ` - ${f}`).join("\n")); process.exitCode = 1; }
  await rt.$disconnect();
}

main().catch((e) => { console.error("battery crashed:", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => owner.$disconnect());
