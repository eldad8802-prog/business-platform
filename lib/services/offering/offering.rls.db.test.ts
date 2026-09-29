/**
 * P1 offering foundation — tenant isolation under real RLS.
 *   TEST_DATABASE_URL="postgres://…test…" npx tsx lib/services/offering/offering.rls.db.test.ts
 *
 * The lab schema comes from `prisma db push`, which models no RLS and no CHECK
 * constraints. So this test first makes the P1 part of the lab look like
 * Production:
 *   1. drops the three tables `db push` made for P1 and replays the APPLIED P1
 *      migration file verbatim (its CHECKs, its policies, its app_runtime grants);
 *   2. replays the RLS the base tables get from the migrations that own them.
 * Then it runs the real P1 service code as `app_runtime` — NOSUPERUSER,
 * NOBYPASSRLS — because the superuser test connection bypasses every policy.
 *
 * Refuses Production.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
if (!TEST_DB || !/^postgres(ql)?:\/\//i.test(TEST_DB)) {
  console.error("ABORT: set TEST_DATABASE_URL to a non-production Postgres URL.");
  process.exit(1);
}
let testHost = "";
try {
  testHost = new URL(TEST_DB).hostname;
} catch {
  testHost = "";
}
if (testHost.includes("ep-flat-brook")) {
  console.error("ABORT: TEST_DATABASE_URL is the Production endpoint.");
  process.exit(1);
}
const IS_CHILD = process.env.P1_RLS_CHILD === "1";
if (!IS_CHILD) process.env.DATABASE_URL = TEST_DB;

const P1_MIGRATION = "20260928120000_p1_business_offering";
const P1_TABLES = ["BusinessServiceAsset", "InventoryItemAsset", "OfferingDemandSignal"] as const;
const BASE_RLS: Array<{ migration: string; tables: string[] }> = [
  { migration: "20260824210000_d2_p7_wave1_tenant_rls", tables: ["BusinessService"] },
  { migration: "20260825200000_d2_p7_wave3_tenant_rls", tables: ["InventoryItem"] },
  { migration: "20260902120000_d2_cutover2b_pilot_tenant_rls", tables: ["Appointment"] },
  { migration: "20260929090000_tenant_rls_closure", tables: ["BusinessAsset"] },
];
const TENANT_TABLES = ["BusinessService", "InventoryItem", "Appointment", "BusinessAsset", ...P1_TABLES];
const ROLE = "app_runtime";

let failed = 0;
function ok(name: string, condition: boolean, detail = "") {
  if (!condition) {
    console.error("FAIL:", name, detail);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

/** Statements of a migration file. Dollar-quoted bodies stay whole. */
function migrationStatements(migration: string): string[] {
  const sql = readFileSync(path.join(process.cwd(), "prisma", "migrations", migration, "migration.sql"), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0];
    if (tag && (quote === null || quote === tag)) {
      quote = quote === null ? tag : null;
      current += tag;
      i += tag.length - 1;
      continue;
    }
    if (sql[i] === ";" && quote === null) {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += sql[i];
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

const ALREADY_THERE = new Set(["42710", "42P07", "42701"]);
function alreadyThere(error: unknown): boolean {
  const meta = (error as { meta?: { code?: unknown } }).meta;
  if (typeof meta?.code === "string" && ALREADY_THERE.has(meta.code)) return true;
  return /already exists/i.test(String((error as Error).message));
}

/* ───────────────────────── child: runs as app_runtime ───────────────────────── */

async function child() {
  const a = Number(process.env.P1_BUSINESS_A);
  const b = Number(process.env.P1_BUSINESS_B);
  const serviceA = Number(process.env.P1_SERVICE_A);
  const serviceB = Number(process.env.P1_SERVICE_B);
  const itemB = Number(process.env.P1_ITEM_B);
  const assetB = Number(process.env.P1_ASSET_B);
  const appointmentA = Number(process.env.P1_APPOINTMENT_A);
  const userA = Number(process.env.P1_USER_A);

  const { prisma } = await import("@/lib/prisma");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const { createBusinessService, linkServiceAsset, linkProductAsset, listOfferings, OfferingNotFoundError } =
    await import("./business-service.service");
  const { recordOfferingDemand } = await import("./offering-demand");

  /** The error text of a refused write, or null when the write went through. */
  const refused = async (fn: () => Promise<unknown>): Promise<string | null> => {
    try {
      await fn();
      return null;
    } catch (error) {
      return String((error as Error).message);
    }
  };

  const role = await prisma.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
    `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
  );

  // Unfiltered reads. Only RLS stands between A and B here.
  const leaked: Record<string, number> = {};
  const noContext: Record<string, number> = {};
  for (const table of TENANT_TABLES) {
    const rows = await tenantTx(a, (tx) =>
      tx.$queryRawUnsafe<Array<{ businessId: number }>>(`SELECT "businessId" FROM "${table}"`)
    );
    leaked[table] = rows.filter((row) => row.businessId === b).length;
    const bare = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM "${table}"`);
    noContext[table] = Number(bare[0].n);
  }

  // Service read: the projection asked for B under A's context returns nothing.
  const readB = await tenantTx(a, (tx) => listOfferings(b, tx));
  const readA = await tenantTx(a, (tx) => listOfferings(a, tx));

  // Service write: A's context cannot create or change a B service.
  const createForB = await refused(() =>
    tenantTx(a, (tx) =>
      createBusinessService({ businessId: b, name: "x", price: { priceMode: "QUOTE_REQUIRED" } }, tx)
    )
  );
  const updatedB = await tenantTx(a, (tx) =>
    tx.businessService.updateMany({ where: { id: serviceB }, data: { featuredByOwner: true } })
  );

  // Asset link: B's asset is invisible to A, through the service and at the table.
  let serviceAssetNotFound = false;
  try {
    await tenantTx(a, (tx) =>
      linkServiceAsset({ businessId: a, businessServiceId: serviceA, businessAssetId: assetB }, tx)
    );
  } catch (error) {
    serviceAssetNotFound = error instanceof OfferingNotFoundError;
  }
  let productAssetNotFound = false;
  try {
    await tenantTx(a, (tx) =>
      linkProductAsset({ businessId: b, inventoryItemId: itemB, businessAssetId: assetB }, tx)
    );
  } catch (error) {
    productAssetNotFound = error instanceof OfferingNotFoundError;
  }
  const rawAssetLinkB = await refused(() =>
    tenantTx(a, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO "BusinessServiceAsset" ("businessId","businessServiceId","businessAssetId") VALUES ($1,$2,$3)`,
        b,
        serviceB,
        assetB
      )
    )
  );

  // Appointment link: neither A's appointment nor a B appointment can point at B's service.
  const appointmentToB = await refused(() =>
    tenantTx(a, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO "Appointment" ("businessId","status","createdByActor","sourceChannel","createdByUserId","businessServiceId","updatedAt")
         VALUES ($1,'PROPOSED','OWNER','INBOX_WEB',$2,$3,now())`,
        a,
        userA,
        serviceB
      )
    )
  );
  const appointmentAsB = await refused(() =>
    tenantTx(a, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO "Appointment" ("businessId","status","createdByActor","sourceChannel","createdByUserId","businessServiceId","updatedAt")
         VALUES ($1,'PROPOSED','OWNER','INBOX_WEB',$2,$3,now())`,
        b,
        userA,
        serviceB
      )
    )
  );

  // Demand: through the writer, and straight at the table.
  const demandForB = await tenantTx(a, (tx) =>
    recordOfferingDemand(tx, {
      businessId: b,
      kind: "SERVICE",
      offeringId: serviceB,
      signalType: "PRICE",
      source: "APPOINTMENT",
      idempotencyKey: "p1-rls-foreign",
    })
  );
  const rawDemandB = await refused(() =>
    tenantTx(a, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO "OfferingDemandSignal" ("businessId","offeringKind","businessServiceId","signalType","source","idempotencyKey")
         VALUES ($1,'SERVICE',$2,'PRICE','APPOINTMENT','p1-rls-raw')`,
        b,
        serviceB
      )
    )
  );

  // Booking evidence under RLS: one row, and a retry returns it.
  const key = `booking:appointment:${appointmentA}`;
  const first = await tenantTx(a, (tx) =>
    recordOfferingDemand(tx, {
      businessId: a,
      kind: "SERVICE",
      offeringId: serviceA,
      signalType: "BOOKING",
      source: "APPOINTMENT",
      appointmentId: appointmentA,
      idempotencyKey: key,
    })
  );
  const retry = await tenantTx(a, (tx) =>
    recordOfferingDemand(tx, {
      businessId: a,
      kind: "SERVICE",
      offeringId: serviceA,
      signalType: "BOOKING",
      source: "APPOINTMENT",
      appointmentId: appointmentA,
      idempotencyKey: key,
    })
  );
  const bookingRows = await tenantTx(a, (tx) =>
    tx.offeringDemandSignal.count({ where: { businessId: a, idempotencyKey: key } })
  );

  // Evidence is not deleted through the runtime role.
  const deleteRefused = await refused(() =>
    tenantTx(a, (tx) => tx.$executeRawUnsafe(`DELETE FROM "OfferingDemandSignal" WHERE "businessId" = $1`, a))
  );

  process.stdout.write(
    "\n@@RESULT@@" +
      JSON.stringify({
        role: role[0],
        leaked,
        noContext,
        readB: readB.length,
        readAOnlyA: readA.length > 0 && readA.every((row) => row.businessId === a),
        createForB,
        updatedB: updatedB.count,
        serviceAssetNotFound,
        productAssetNotFound,
        rawAssetLinkB,
        appointmentToB,
        appointmentAsB,
        demandForB: demandForB === null,
        rawDemandB,
        bookingSame: first !== null && retry?.id === first.id,
        bookingRows,
        deleteRefused,
      }) +
      "@@END@@\n"
  );
  await prisma.$disconnect();
}

/* ───────────────────────────── parent: owner setup ──────────────────────────── */

async function main() {
  const { prisma } = await import("@/lib/prisma");

  console.log(`\n1 · replay the applied P1 migration (${P1_MIGRATION})`);
  const password = randomBytes(18).toString("hex");
  await prisma.$executeRawUnsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
      CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
    END IF; END $$`);
  await prisma.$executeRawUnsafe(`ALTER ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD '${password}'`);
  for (const table of P1_TABLES) await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${table}" CASCADE`);
  let applied = 0;
  for (const statement of migrationStatements(P1_MIGRATION)) {
    try {
      await prisma.$executeRawUnsafe(statement);
      applied += 1;
    } catch (error) {
      if (!alreadyThere(error)) throw error;
    }
  }
  ok(`applied ${applied} statements of the P1 migration`, applied > 20);

  console.log("\n2 · replay base-table RLS from the migrations that own it");
  for (const { migration, tables } of BASE_RLS) {
    for (const statement of migrationStatements(migration)) {
      if (!/ROW LEVEL SECURITY|POLICY/i.test(statement)) continue;
      if (!tables.some((table) => statement.includes(`"${table}"`))) continue;
      try {
        await prisma.$executeRawUnsafe(statement);
      } catch (error) {
        if (!alreadyThere(error)) throw error;
      }
    }
  }
  const installed = await prisma.$queryRawUnsafe<Array<{ relname: string; rls: boolean; forced: boolean; policies: bigint }>>(
    `SELECT c.relname::text AS relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
            (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname
               AND coalesce(p.qual, p.with_check) LIKE '%app.current_business_id%')::bigint AS policies
       FROM pg_class c WHERE c.relkind = 'r' AND c.relname = ANY($1::text[]) ORDER BY c.relname`,
    TENANT_TABLES
  );
  ok(
    "every P1-touched table: RLS enabled + FORCED + a tenant policy",
    installed.length === TENANT_TABLES.length && installed.every((r) => r.rls && r.forced && Number(r.policies) >= 1),
    JSON.stringify(installed.map((r) => [r.relname, r.rls, r.forced, Number(r.policies)]))
  );
  const grants = await prisma.$queryRawUnsafe<Array<{ table_name: string; privilege_type: string }>>(
    `SELECT table_name::text, privilege_type::text FROM information_schema.role_table_grants
      WHERE grantee = $1 AND table_name = ANY($2::text[])`,
    ROLE,
    [...P1_TABLES]
  );
  ok(
    "the migration's own grants: app_runtime may SELECT/INSERT/UPDATE, never DELETE",
    P1_TABLES.every((t) =>
      ["SELECT", "INSERT", "UPDATE"].every((p) => grants.some((g) => g.table_name === t && g.privilege_type === p))
    ) && !grants.some((g) => g.privilege_type === "DELETE" || g.privilege_type === "TRUNCATE"),
    JSON.stringify(grants)
  );

  // Base tables get their runtime grants from the ops grant scripts, not from P1.
  await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
  for (const table of ["BusinessService", "InventoryItem", "Appointment", "BusinessAsset"]) {
    await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE ON "${table}" TO ${ROLE}`);
  }
  await prisma.$executeRawUnsafe(`GRANT SELECT ON "InventoryCategory" TO ${ROLE}`);
  await prisma.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`);

  console.log("\n3 · fixtures (owner connection)");
  const tag = `qa-p1-rls-${Date.now()}`;
  const a = await prisma.business.create({ data: { name: `${tag}-A` } });
  const b = await prisma.business.create({ data: { name: `${tag}-B` } });
  const userA = await prisma.user.create({
    data: { email: `${tag}@example.test`, password: "not-a-real-password", businessId: a.id },
  });
  try {
    const serviceA = await prisma.businessService.create({
      data: { businessId: a.id, name: "שירות א", type: "SERVICE", priceMode: "FIXED", priceAmount: 100 },
    });
    const serviceB = await prisma.businessService.create({
      data: { businessId: b.id, name: "שירות ב", type: "SERVICE", priceMode: "NO_PUBLIC_PRICE" },
    });
    const itemB = await prisma.inventoryItem.create({
      data: { businessId: b.id, name: "מוצר ב", unitType: "UNIT", currentQuantity: 1, minimumQuantity: 0 },
    });
    const assetB = await prisma.businessAsset.create({
      data: { businessId: b.id, origin: "OWNER_UPLOAD", storageKey: `${tag}-b` },
    });
    const appointmentA = await prisma.appointment.create({
      data: {
        businessId: a.id,
        status: "PROPOSED",
        createdByActor: "OWNER",
        sourceChannel: "INBOX_WEB",
        createdByUserId: userA.id,
        businessServiceId: serviceA.id,
      },
    });

    console.log("\n4 · real P1 code as app_runtime (NOSUPERUSER NOBYPASSRLS)");
    const url = new URL(TEST_DB!);
    url.username = ROLE;
    url.password = password;
    const run = spawnSync("npx", ["tsx", process.argv[1]], {
      shell: process.platform === "win32",
      encoding: "utf8",
      env: {
        ...process.env,
        P1_RLS_CHILD: "1",
        DATABASE_URL: url.toString(),
        P1_BUSINESS_A: String(a.id),
        P1_BUSINESS_B: String(b.id),
        P1_SERVICE_A: String(serviceA.id),
        P1_SERVICE_B: String(serviceB.id),
        P1_ITEM_B: String(itemB.id),
        P1_ASSET_B: String(assetB.id),
        P1_APPOINTMENT_A: String(appointmentA.id),
        P1_USER_A: String(userA.id),
      },
      timeout: 180_000,
    });
    const match = /@@RESULT@@(.*)@@END@@/s.exec(run.stdout ?? "");
    ok("child ran as app_runtime", run.status === 0 && !!match, (run.stderr ?? "").slice(-2000));
    if (match) {
      const r = JSON.parse(match[1]);
      const zeros = Object.fromEntries(TENANT_TABLES.map((t) => [t, 0]));
      ok("runtime role is neither superuser nor BYPASSRLS", !r.role.rolsuper && !r.role.rolbypassrls);
      ok("no tenant context → zero rows everywhere", JSON.stringify(r.noContext) === JSON.stringify(zeros), JSON.stringify(r.noContext));
      ok("under A's context → zero of B's rows everywhere", JSON.stringify(r.leaked) === JSON.stringify(zeros), JSON.stringify(r.leaked));
      ok("CROSS-TENANT SERVICE READ: B's catalog asked for under A is empty", r.readB === 0);
      ok("A still reads its own catalog", r.readAOnlyA === true);
      ok("CROSS-TENANT SERVICE WRITE: creating a B service under A is refused by RLS", /row-level security/i.test(r.createForB ?? ""), r.createForB);
      ok("CROSS-TENANT SERVICE WRITE: updating B's service under A touches nothing", r.updatedB === 0);
      ok("CROSS-TENANT ASSET LINK: service link to B's asset is not found", r.serviceAssetNotFound === true);
      ok("CROSS-TENANT ASSET LINK: product link inside B under A is not found", r.productAssetNotFound === true);
      ok("CROSS-TENANT ASSET LINK: raw B link row under A is refused by RLS", /row-level security/i.test(r.rawAssetLinkB ?? ""), r.rawAssetLinkB);
      ok("CROSS-TENANT APPOINTMENT LINK: A appointment → B service is refused by the same-tenant FK", /Appointment_businessServiceId_businessId_fkey/.test(r.appointmentToB ?? ""), r.appointmentToB);
      ok("CROSS-TENANT APPOINTMENT LINK: B appointment under A is refused by RLS", /row-level security/i.test(r.appointmentAsB ?? ""), r.appointmentAsB);
      ok("CROSS-TENANT DEMAND: writer returns nothing for B's service", r.demandForB === true);
      ok("CROSS-TENANT DEMAND: raw B demand row under A is refused by RLS", /row-level security/i.test(r.rawDemandB ?? ""), r.rawDemandB);
      ok("BOOKING under RLS: retry returns the same fact", r.bookingSame === true);
      ok("BOOKING under RLS: exactly one row for the appointment", r.bookingRows === 1);
      ok("demand evidence cannot be deleted by the runtime role", /permission denied/i.test(r.deleteRefused ?? ""), r.deleteRefused);
    }
    const bDemand = await prisma.offeringDemandSignal.count({ where: { businessId: b.id } });
    const bLinks = await prisma.businessServiceAsset.count({ where: { businessId: b.id } });
    const bFeatured = await prisma.businessService.findUnique({ where: { id: serviceB.id } });
    const bServices = await prisma.businessService.count({ where: { businessId: b.id } });
    ok("owner view: B has no demand, no links, one untouched service",
      bDemand === 0 && bLinks === 0 && bServices === 1 && bFeatured?.featuredByOwner === false);
  } finally {
    await prisma.offeringDemandSignal.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.businessServiceAsset.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.inventoryItemAsset.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.appointment.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.businessAsset.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.inventoryItem.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.businessService.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.user.deleteMany({ where: { businessId: a.id } });
    await prisma.business.deleteMany({ where: { id: { in: [a.id, b.id] } } });
    await prisma.$disconnect();
  }

  if (failed > 0) {
    console.error(`P1 offering RLS: ${failed} failed`);
    process.exit(1);
  }
  console.log("P1 offering RLS: all checks passed");
}

(IS_CHILD ? child() : main()).catch((error) => {
  console.error(error);
  process.exit(1);
});
