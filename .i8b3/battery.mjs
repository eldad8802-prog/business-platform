/**
 * I-8B.3 — duplicate and reversal lookup, against REAL PostgreSQL 17.
 *
 * The pure decision logic is tested without a database. What CANNOT be tested
 * that way is the thing this phase actually introduced: a tenant-scoped READ of
 * historical records. Row-level security is a property of PostgreSQL, so it is
 * measured from PostgreSQL, through the same restricted role production runs
 * as — not superuser, not bypassrls.
 *
 * The trap this exists to catch: a lookup that returns the right answer because
 * its `where` clause happened to include `businessId`, on a connection that
 * could have seen everything. That looks identical in a unit test and is a
 * cross-tenant leak the day somebody edits the query.
 *
 * Synthetic data only. No Neon, no production, no secrets.
 *
 * Run: node .i8b3/battery.mjs
 */
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";

const MIGRATION =
  "prisma/migrations/20260907120000_i8a_historical_fiscal_documents/migration.sql";

const OWNER_URL = process.env.DATABASE_URL;
const RUNTIME_URL = process.env.RUNTIME_DATABASE_URL;
const RUNTIME_ROLE = process.env.RUNTIME_ROLE || "app_runtime";
if (!OWNER_URL || !RUNTIME_URL) {
  console.error("DATABASE_URL and RUNTIME_DATABASE_URL are both required");
  process.exit(1);
}
if (!/localhost|127\.0\.0\.1/.test(OWNER_URL)) {
  console.error("DENY: this battery runs only against a local PG17 lab");
  process.exit(1);
}

let pass = 0;
const failures = [];
function ok(label, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  ok  ${label}`);
  } else {
    failures.push(label);
    console.log(`FAIL  ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

const owner = new PrismaClient({ datasourceUrl: OWNER_URL });

/** Split a migration into statements, respecting dollar-quoted bodies. */
function splitSql(sql) {
  const lines = sql.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let current = "";
  let tag = null;
  for (const raw of lines) {
    const line = tag === null && /^\s*--/.test(raw) ? "" : raw;
    if (tag === null && line.trim() === "" && current.trim() === "") continue;
    current += line + "\n";
    let rest = line;
    while (rest.length > 0) {
      if (tag === null) {
        const open = rest.match(/\$[A-Za-z_]*\$/);
        if (!open) break;
        tag = open[0];
        rest = rest.slice(open.index + tag.length);
      } else {
        const close = rest.indexOf(tag);
        if (close < 0) break;
        rest = rest.slice(close + tag.length);
        tag = null;
      }
    }
    if (tag === null && line.trimEnd().endsWith(";")) {
      if (current.trim() !== "") out.push(current.trim());
      current = "";
    }
  }
  if (current.trim() !== "") out.push(current.trim());
  return out;
}

async function main() {
  console.log("\nI-8B.3 — historical duplicate lookup under real row-level security\n");

  const version = await owner.$queryRawUnsafe("SELECT version() AS v");
  console.log(`  server: ${String(version[0].v).split(",")[0]}\n`);

  /* ── the lab: the real RLS, through the real restricted role ──────────── */

  const role = (
    await owner.$queryRawUnsafe(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`,
      RUNTIME_ROLE
    )
  )[0];
  ok("the runtime role is NOT superuser (a superuser would see everything)", role?.rolsuper === false);
  ok("the runtime role is NOBYPASSRLS", role?.rolbypassrls === false);

  // `prisma db push` builds the table from the datamodel, which knows nothing
  // about RLS or grants. Replaying the migration is what puts the real
  // protection in place.
  await owner.$executeRawUnsafe(`DROP TABLE IF EXISTS "HistoricalFiscalDocument" CASCADE`);
  await owner.$executeRawUnsafe(`DROP INDEX IF EXISTS "Document_businessId_id_key"`);
  for (const statement of splitSql(fs.readFileSync(MIGRATION, "utf8"))) {
    await owner.$executeRawUnsafe(statement);
  }
  const rls = (
    await owner.$queryRawUnsafe(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'HistoricalFiscalDocument'`
    )
  )[0];
  ok("row-level security is ENABLED and FORCED", rls?.relrowsecurity === true && rls?.relforcerowsecurity === true);

  /* ── fixtures: two tenants holding the SAME fiscal identity ───────────── */

  await owner.$executeRawUnsafe(`DELETE FROM "HistoricalFiscalDocument"`);
  await owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE name LIKE 'i8b3-%'`);

  const [bizA, bizB] = await owner.$queryRawUnsafe(
    `INSERT INTO "Business" ("name", "updatedAt") VALUES ('i8b3-A', now()), ('i8b3-B', now()) RETURNING id`
  );
  const A = bizA.id;
  const B = bizB.id;

  const insert = async (businessId, type, number, total, reverses) => {
    await owner.$executeRawUnsafe(
      `INSERT INTO "HistoricalFiscalDocument"
         ("businessId","documentTypeCode","sourceSystemCode","originalDocumentNumber",
          "originalIssueDate","totalAmount","currency","reversesOriginalNumberRaw","updatedAt")
       VALUES ($1,$2,'legacy-erp',$3,'2024-03-17'::timestamp,$4::numeric,'ILS',$5, now())`,
      businessId,
      type,
      number,
      total,
      reverses
    );
  };

  // Both tenants hold "INV-1" from the same source system — the exact shape a
  // cross-tenant leak would turn into a false duplicate.
  await insert(A, "TAX_INVOICE", "INV-1", "1170.00", null);
  await insert(B, "TAX_INVOICE", "INV-1", "1170.00", null);
  await insert(B, "TAX_INVOICE", "INV-9", "500.00", null);

  /* ── the real modules, pointed at the restricted role ─────────────────── */

  process.env.DATABASE_URL = RUNTIME_URL;
  const { analyzeHistoricalDuplicates } = await import(
    "@/lib/data-transfer/historical/historical-duplicates"
  );
  const { runWithTenantContext } = await import("@/lib/tenant/context");

  const rowFor = (number, type = "TAX_INVOICE", reverses = null) => ({
    sourceRowNumber: 1,
    identity: {
      sourceSystemCode: "legacy-erp",
      documentTypeCode: type,
      originalDocumentNumber: number,
    },
    facts: {
      originalIssueDate: "2024-03-17",
      totalAmount: type === "CREDIT_NOTE" ? "-1170.00" : "1170.00",
      subtotalAmount: null,
      vatAmount: null,
      currency: "ILS",
      customerNameSnapshot: null,
      customerTaxIdSnapshot: null,
    },
    reversesOriginalNumberRaw: reverses,
  });

  const analyzeAs = (businessId, rows) =>
    runWithTenantContext({ businessId }, () =>
      analyzeHistoricalDuplicates(businessId, rows)
    );

  /* ── tenant isolation ─────────────────────────────────────────────────── */

  const forA = await analyzeAs(A, [rowFor("INV-1")]);
  ok(
    "tenant A finds its OWN record as an exact duplicate",
    forA.byRow.get(1)?.duplicate.database.state === "EXACT",
    forA.byRow.get(1)?.duplicate.database.state
  );
  ok(
    "and sees exactly one match, not both tenants'",
    forA.byRow.get(1)?.duplicate.database.matchCount === 1,
    String(forA.byRow.get(1)?.duplicate.database.matchCount)
  );

  const forAOnB = await analyzeAs(A, [rowFor("INV-9")]);
  ok(
    "tenant A does NOT see tenant B's record, though the identity matches",
    forAOnB.byRow.get(1)?.duplicate.database.state === "NONE",
    forAOnB.byRow.get(1)?.duplicate.database.state
  );

  const forB = await analyzeAs(B, [rowFor("INV-9")]);
  ok(
    "and tenant B does see its own — so the isolation is not just an empty read",
    forB.byRow.get(1)?.duplicate.database.state === "EXACT"
  );

  /* ── reversal never crosses a tenant ──────────────────────────────────── */

  const creditForA = await analyzeAs(A, [rowFor("CN-1", "CREDIT_NOTE", "INV-9")]);
  ok(
    "a credit in tenant A does not resolve against tenant B's invoice",
    creditForA.byRow.get(1)?.reversal.state === "NOT_FOUND",
    creditForA.byRow.get(1)?.reversal.state
  );

  const creditForB = await analyzeAs(B, [rowFor("CN-1", "CREDIT_NOTE", "INV-9")]);
  ok(
    "the same credit in tenant B resolves to tenant B's invoice",
    creditForB.byRow.get(1)?.reversal.state === "RESOLVED_EXISTING",
    creditForB.byRow.get(1)?.reversal.state
  );

  /* ── the read really is going through RLS ─────────────────────────────── */

  const runtime = new PrismaClient({ datasourceUrl: RUNTIME_URL });
  const withoutContext = await runtime.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM "HistoricalFiscalDocument"`
  );
  ok(
    "with NO tenant context the restricted role sees zero rows",
    withoutContext[0].c === 0,
    `saw ${withoutContext[0].c}`
  );
  const asOwner = await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM "HistoricalFiscalDocument"`
  );
  ok("but the rows really are there", asOwner[0].c === 3, `owner saw ${asOwner[0].c}`);

  /* ── bounded query count on a realistic file ──────────────────────────── */

  const manyRows = [];
  for (let i = 1; i <= 10_000; i += 1) {
    manyRows.push({
      ...rowFor(`BULK-${i}`),
      sourceRowNumber: i,
    });
  }
  const started = Date.now();
  const bulk = await analyzeAs(A, manyRows);
  const elapsed = Date.now() - started;
  ok(
    "10,000 rows are analyzed in tens of queries, not thousands",
    bulk.evidence.queryCount <= 60,
    `${bulk.evidence.queryCount} queries`
  );
  ok("every row still got an answer", bulk.byRow.size === 10_000, String(bulk.byRow.size));
  console.log(`      (${bulk.evidence.queryCount} queries, ${elapsed}ms)`);

  /* ── read-only: nothing moved ─────────────────────────────────────────── */

  const after = await owner.$queryRawUnsafe(
    `SELECT (SELECT count(*)::int FROM "HistoricalFiscalDocument") AS hist,
            (SELECT count(*)::int FROM "ImportRun") AS runs,
            (SELECT count(*)::int FROM "ImportRunRow") AS markers,
            (SELECT count(*)::int FROM "Document") AS docs,
            (SELECT count(*)::int FROM "BillingDocument") AS billing,
            (SELECT count(*)::int FROM "FinancialEvent") AS events,
            (SELECT count(*)::int FROM "Customer") AS customers`
  );
  const counts = after[0];
  ok("no historical record was created, changed or removed", counts.hist === 3, String(counts.hist));
  ok("no import run was created", counts.runs === 0, String(counts.runs));
  ok("no row marker was created", counts.markers === 0, String(counts.markers));
  ok("no document was created", counts.docs === 0, String(counts.docs));
  ok("no billing document was created", counts.billing === 0, String(counts.billing));
  ok("no financial event was created", counts.events === 0, String(counts.events));
  ok("no customer was created", counts.customers === 0, String(counts.customers));

  const unresolved = await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM "HistoricalFiscalDocument" WHERE "reversesHistoricalDocumentId" IS NOT NULL`
  );
  ok(
    "no reversal relation was written — the column has no UPDATE path at all",
    unresolved[0].c === 0
  );

  await runtime.$disconnect().catch(() => {});

  console.log(`\n  ${pass} checks passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    failures.forEach((f) => console.log(`  FAILED: ${f}`));
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error("\nBATTERY ERROR:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await owner.$disconnect().catch(() => {});
  });
