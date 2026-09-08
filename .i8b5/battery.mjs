/**
 * I-8B.5 — historical fiscal Execute, against REAL PostgreSQL 17.
 *
 * This is the first phase that writes, so almost nothing about it can be proven
 * without a database. Row-level security, Decimal round trips, calendar days
 * that survive a `timestamp` column, advisory locks, ledger atomicity and
 * replay are all properties of PostgreSQL, and they are measured here through
 * the same restricted role production runs as — not superuser, not bypassrls.
 *
 * Synthetic data only. No Neon, no production, no secrets.
 *
 * Run: node .i8b5/battery.mjs
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
  console.log("\nI-8B.5 — historical fiscal Execute on real PostgreSQL\n");

  const version = await owner.$queryRawUnsafe("SELECT version() AS v");
  console.log(`  server: ${String(version[0].v).split(",")[0]}\n`);

  const role = (
    await owner.$queryRawUnsafe(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`,
      RUNTIME_ROLE
    )
  )[0];
  ok("the runtime role is NOT superuser", role?.rolsuper === false);
  ok("the runtime role is NOBYPASSRLS", role?.rolbypassrls === false);

  // Replay the migration so RLS, the policies and the grants are the real ones.
  await owner.$executeRawUnsafe(`DROP TABLE IF EXISTS "HistoricalFiscalDocument" CASCADE`);
  await owner.$executeRawUnsafe(`DROP INDEX IF EXISTS "Document_businessId_id_key"`);
  for (const statement of splitSql(fs.readFileSync(MIGRATION, "utf8"))) {
    await owner.$executeRawUnsafe(statement);
  }

  // Execution INSERTS, so the runtime needs the ledger the migration does not
  // grant. Production already grants these for the tabular import; the lab says
  // so explicitly rather than inheriting it by accident.
  await owner.$executeRawUnsafe(
    `GRANT SELECT, INSERT, UPDATE ON "ImportRun" TO ${RUNTIME_ROLE}`
  );
  await owner.$executeRawUnsafe(
    `GRANT SELECT, INSERT ON "ImportRunRow" TO ${RUNTIME_ROLE}`
  );
  await owner.$executeRawUnsafe(
    `GRANT USAGE, SELECT ON SEQUENCE "ImportRun_id_seq" TO ${RUNTIME_ROLE}`
  );
  await owner.$executeRawUnsafe(`GRANT SELECT ON "Business" TO ${RUNTIME_ROLE}`);

  await owner.$executeRawUnsafe(`DELETE FROM "ImportRunRow"`);
  await owner.$executeRawUnsafe(`DELETE FROM "HistoricalFiscalDocument"`);
  await owner.$executeRawUnsafe(`DELETE FROM "ImportRun"`);
  await owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE name LIKE 'i8b5-%'`);

  const [bizA, bizB] = await owner.$queryRawUnsafe(
    `INSERT INTO "Business" ("name","updatedAt") VALUES ('i8b5-A', now()), ('i8b5-B', now()) RETURNING id`
  );
  const A = bizA.id;
  const B = bizB.id;

  const seed = async (businessId, type, number, total) =>
    owner.$executeRawUnsafe(
      `INSERT INTO "HistoricalFiscalDocument"
         ("businessId","documentTypeCode","sourceSystemCode","originalDocumentNumber",
          "originalIssueDate","totalAmount","currency","updatedAt")
       VALUES ($1,$2,'legacy-erp',$3,'2024-03-17'::timestamp,$4::numeric,'ILS', now())`,
      businessId,
      type,
      number,
      total
    );

  /* ── the real modules, through the restricted role ───────────────────── */

  process.env.DATABASE_URL = RUNTIME_URL;
  process.env.AUTH_TOKEN_SECRET ||= "i8b5-lab-secret";
  const { buildHistoricalPreview } = await import(
    "@/lib/data-transfer/historical/historical-preview"
  );
  const { executeHistoricalImport } = await import(
    "@/lib/data-transfer/historical/historical-execute"
  );
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { buildXlsxBuffer } = await import("@/lib/data-transfer/format/xlsx-writer");

  const HEADERS = [
    "סוג מסמך",
    "מספר מסמך מקורי",
    "תאריך המסמך",
    "סכום כולל",
    "סכום לפני מע״מ",
    "מע״מ",
    "מטבע",
    "שם לקוח",
    "מספר עוסק / ח.פ. לקוח",
    "מערכת מקור",
    "מספר מסמך שמזוכה",
  ];

  const fileOf = (rows) =>
    buildXlsxBuffer([
      {
        name: "ייבוא",
        columns: HEADERS.map((h) => ({ header: h, type: "text" })),
        rows,
        rightToLeft: true,
      },
    ]);

  const line = (number, total, opts = {}) => [
    opts.type ?? "חשבונית מס",
    number,
    opts.date ?? "2024-03-17",
    total,
    opts.subtotal ?? "",
    opts.vat ?? "",
    "ILS",
    opts.customer ?? "",
    "",
    "legacy-erp",
    opts.reverses ?? "",
  ];

  /** Preview then Execute, as a caller would. */
  const runImport = async (businessId, bytes, decisions = null) => {
    const preview = await runWithTenantContext({ businessId }, () =>
      buildHistoricalPreview({
        businessId,
        userId: 1,
        filename: "history.xlsx",
        bytes,
        sheetName: null,
        dateFormat: null,
        decisions,
      })
    );
    if (!preview.ok) return { preview, execute: null };
    if (!preview.previewToken) return { preview, execute: null };
    const execute = await executeHistoricalImport({
      businessId,
      userId: 1,
      filename: "history.xlsx",
      bytes,
      sheetName: null,
      dateFormat: null,
      decisions: preview.decisions,
      previewToken: preview.previewToken,
    });
    return { preview, execute };
  };

  const countFor = async (businessId, number) =>
    Number(
      (
        await owner.$queryRawUnsafe(
          `SELECT count(*)::int AS c FROM "HistoricalFiscalDocument"
           WHERE "businessId" = $1 AND "originalDocumentNumber" = $2`,
          businessId,
          number
        )
      )[0].c
    );

  /* ── 1. a plain create, with money and dates that must survive ───────── */

  const basic = await runImport(
    A,
    await fileOf([
      line("INV-100", "1170.35", { subtotal: "1000.30", vat: "170.05", customer: "חברת דוגמה" }),
    ])
  );
  ok("a valid file executes", basic.execute?.ok === true, basic.execute?.code ?? basic.preview.code);
  ok("one record was created", basic.execute?.totals.created === 1);
  ok("the run completed", basic.execute?.status === "COMPLETED", basic.execute?.status);

  const stored = (
    await owner.$queryRawUnsafe(
      `SELECT "totalAmount"::text AS total, "subtotalAmount"::text AS sub, "vatAmount"::text AS vat,
              to_char("originalIssueDate", 'YYYY-MM-DD') AS day,
              "customerNameSnapshot" AS customer, "currency", "importRunId" AS run
       FROM "HistoricalFiscalDocument" WHERE "businessId" = $1 AND "originalDocumentNumber" = 'INV-100'`,
      A
    )
  )[0];
  ok("the amount round-trips exactly — no float anywhere", stored?.total === "1170.35", stored?.total);
  ok("so do the subtotal and the VAT", stored?.sub === "1000.30" && stored?.vat === "170.05");
  ok("the calendar day survives the timestamp column", stored?.day === "2024-03-17", stored?.day);
  ok("the customer name is a snapshot on the record", stored?.customer === "חברת דוגמה");
  ok("the record is linked to its import run", Number.isInteger(stored?.run));

  /* ── 2. replay: the same approved run creates nothing new ────────────── */

  const sameFile = await fileOf([
    line("INV-100", "1170.35", { subtotal: "1000.30", vat: "170.05", customer: "חברת דוגמה" }),
  ]);
  const replay = await runImport(A, sameFile);
  // The record now exists, so Preview defaults the row to SKIP and the evidence
  // has moved — which is the correct outcome and is itself the protection.
  ok(
    "re-importing the same file does not create a second record",
    (await countFor(A, "INV-100")) === 1,
    String(await countFor(A, "INV-100"))
  );
  ok(
    "and the second attempt is a SKIP rather than a silent duplicate",
    replay.execute === null || replay.execute.totals.created === 0,
    JSON.stringify(replay.execute?.totals)
  );

  /* ── 3. an exact duplicate is skipped, an override is deliberate ─────── */

  const dupFile = await fileOf([line("INV-100", "1170.35", { subtotal: "1000.30", vat: "170.05", customer: "חברת דוגמה" })]);
  const skipRun = await runImport(A, dupFile);
  ok("an exact duplicate produces no new record", (await countFor(A, "INV-100")) === 1);
  ok(
    "and the run says so rather than reporting a create it did not make",
    skipRun.execute === null || skipRun.execute.totals.created === 0,
    JSON.stringify(skipRun.execute?.totals)
  );

  const overridePreview = await runWithTenantContext({ businessId: A }, () =>
    buildHistoricalPreview({
      businessId: A,
      userId: 1,
      filename: "history.xlsx",
      bytes: dupFile,
      sheetName: null,
      dateFormat: null,
      decisions: { 1: "CREATE_ANYWAY" },
    })
  );
  ok("an override makes the preview ready", overridePreview.ok && overridePreview.readyForExecute === true);
  if (overridePreview.ok && overridePreview.previewToken) {
    const overrideRun = await executeHistoricalImport({
      businessId: A,
      userId: 1,
      filename: "history.xlsx",
      bytes: dupFile,
      sheetName: null,
      dateFormat: null,
      decisions: overridePreview.decisions,
      previewToken: overridePreview.previewToken,
    });
    ok("CREATE_ANYWAY creates a SECOND record on purpose", overrideRun.ok && overrideRun.totals.created === 1, JSON.stringify(overrideRun));
    ok("and the business now holds two", (await countFor(A, "INV-100")) === 2);
  }

  /* ── 4. reversal: existing target, in-file target, text only ─────────── */

  await seed(A, "TAX_INVOICE", "INV-200", "500.00");
  const creditExisting = await runImport(
    A,
    await fileOf([line("CN-200", "-500.00", { type: "חשבונית זיכוי", reverses: "INV-200" })])
  );
  ok("a credit executes against an existing target", creditExisting.execute?.ok === true, creditExisting.execute?.code);
  const boundExisting = (
    await owner.$queryRawUnsafe(
      `SELECT c."reversesHistoricalDocumentId" AS target, t."originalDocumentNumber" AS number
       FROM "HistoricalFiscalDocument" c
       LEFT JOIN "HistoricalFiscalDocument" t ON t.id = c."reversesHistoricalDocumentId"
       WHERE c."businessId" = $1 AND c."originalDocumentNumber" = 'CN-200'`,
      A
    )
  )[0];
  ok("and is bound to the record it credits", boundExisting?.number === "INV-200", JSON.stringify(boundExisting));

  const inFile = await runImport(
    A,
    await fileOf([
      line("INV-300", "800.00"),
      line("CN-300", "-800.00", { type: "חשבונית זיכוי", reverses: "INV-300" }),
    ])
  );
  ok("an in-file pair executes", inFile.execute?.ok === true, inFile.execute?.code);
  ok("both rows were created", inFile.execute?.totals.created === 2, JSON.stringify(inFile.execute?.totals));
  const boundInFile = (
    await owner.$queryRawUnsafe(
      `SELECT t."originalDocumentNumber" AS number
       FROM "HistoricalFiscalDocument" c
       JOIN "HistoricalFiscalDocument" t ON t.id = c."reversesHistoricalDocumentId"
       WHERE c."businessId" = $1 AND c."originalDocumentNumber" = 'CN-300'`,
      A
    )
  )[0];
  ok("the credit binds to the record created earlier in the same run", boundInFile?.number === "INV-300");

  const textOnly = await runImport(
    A,
    await fileOf([line("CN-400", "-90.00", { type: "חשבונית זיכוי", reverses: "NEVER-IMPORTED" })])
  );
  ok("a credit with no known target still executes", textOnly.execute?.ok === true, textOnly.execute?.code);
  const unbound = (
    await owner.$queryRawUnsafe(
      `SELECT "reversesOriginalNumberRaw" AS raw, "reversesHistoricalDocumentId" AS target
       FROM "HistoricalFiscalDocument" WHERE "businessId" = $1 AND "originalDocumentNumber" = 'CN-400'`,
      A
    )
  )[0];
  ok(
    "keeping the number as text with no relation, exactly as designed",
    unbound?.raw === "NEVER-IMPORTED" && unbound?.target === null,
    JSON.stringify(unbound)
  );

  /* ── 5. the skipped-target case the design turns on ──────────────────── */

  // INV-200 already exists. A file re-stating it AND crediting it: the invoice
  // row is skipped as a duplicate, and the credit must still bind to the record
  // the business already holds.
  const skippedTarget = await runImport(
    A,
    await fileOf([
      line("INV-200", "500.00"),
      line("CN-500", "-500.00", { type: "חשבונית זיכוי", reverses: "INV-200" }),
    ])
  );
  ok(
    "the file executes with its target row skipped",
    skippedTarget.execute?.ok === true,
    JSON.stringify({
      previewOk: skippedTarget.preview?.ok,
      previewCode: skippedTarget.preview?.code,
      ready: skippedTarget.preview?.readyForExecute,
      executeCode: skippedTarget.execute?.code,
      rows: skippedTarget.preview?.rows?.map((r) => ({
        n: r.sourceRowNumber,
        decision: r.selectedDecision,
        dup: r.duplicate?.database?.state,
        reversalState: r.reversal?.state,
        targetRow: r.reversal?.targetSourceRow,
        targetClass: r.reversalTarget,
        blocked: r.blockingReasons,
      })),
    })
  );
  const boundSkipped = (
    await owner.$queryRawUnsafe(
      `SELECT t."originalDocumentNumber" AS number
       FROM "HistoricalFiscalDocument" c
       JOIN "HistoricalFiscalDocument" t ON t.id = c."reversesHistoricalDocumentId"
       WHERE c."businessId" = $1 AND c."originalDocumentNumber" = 'CN-500'`,
      A
    )
  )[0];
  ok(
    "the credit binds to the EXISTING record, not to nothing",
    boundSkipped?.number === "INV-200",
    JSON.stringify(boundSkipped)
  );

  /* ── 6. tenant isolation ─────────────────────────────────────────────── */

  const forB = await runImport(B, await fileOf([line("INV-100", "1170.35")]));
  ok("tenant B can import the same document number", forB.execute?.ok === true, forB.execute?.code);
  ok(
    "and it does NOT see tenant A's copies as duplicates",
    forB.execute?.totals.created === 1,
    JSON.stringify(forB.execute?.totals)
  );
  const perTenant = await owner.$queryRawUnsafe(
    `SELECT "businessId" AS b, count(*)::int AS c FROM "HistoricalFiscalDocument"
     WHERE "originalDocumentNumber" = 'INV-100' GROUP BY "businessId" ORDER BY "businessId"`
  );
  ok(
    "each tenant's records stay its own",
    perTenant.length === 2 && perTenant.every((r) => r.c >= 1),
    JSON.stringify(perTenant)
  );

  /* ── 7. the ledger ───────────────────────────────────────────────────── */

  const runs = await owner.$queryRawUnsafe(
    `SELECT domain, status, "totalRows", "createdCount", "skippedCount", "failedCount"
     FROM "ImportRun" ORDER BY id`
  );
  ok("every run is recorded under the historical domain", runs.every((r) => r.domain === "historical-documents"), JSON.stringify(runs.map((r) => r.domain)));
  ok("and every run reached a terminal status", runs.every((r) => r.status !== "EXECUTING"), JSON.stringify(runs.map((r) => r.status)));

  const markers = await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM "ImportRunRow"`
  );
  const created = await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM "HistoricalFiscalDocument" WHERE "importRunId" IS NOT NULL`
  );
  ok(
    "every record this phase created carries a marker — the ledger and the data agree",
    markers[0].c >= created[0].c,
    `${markers[0].c} markers, ${created[0].c} records`
  );

  const ledgerLeak = await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM "ImportRunRow" WHERE "errorCode" IS NOT NULL
       AND "errorCode" NOT IN ('VALIDATION_ERROR','DUPLICATE_CHANGED','CONFLICT','SERVICE_ERROR')`
  );
  ok("the ledger holds only structural codes, never a value from a file", ledgerLeak[0].c === 0);

  /* ── 8. nothing else moved ───────────────────────────────────────────── */

  const others = (
    await owner.$queryRawUnsafe(
      `SELECT (SELECT count(*)::int FROM "BillingDocument") AS billing,
              (SELECT count(*)::int FROM "BillingDocumentLine") AS lines,
              (SELECT count(*)::int FROM "BillingDocumentNumberSequence") AS seqs,
              (SELECT count(*)::int FROM "BillingReceiptPayment") AS receipts,
              (SELECT count(*)::int FROM "BillingPaymentAllocation") AS allocations,
              (SELECT count(*)::int FROM "FinancialEvent") AS events,
              (SELECT count(*)::int FROM "BillingAuthoritySubmission") AS submissions,
              (SELECT count(*)::int FROM "Customer") AS customers,
              (SELECT count(*)::int FROM "Lead") AS leads,
              (SELECT count(*)::int FROM "InventoryItem") AS inventory,
              (SELECT count(*)::int FROM "Document") AS documents,
              (SELECT count(*)::int FROM "PaymentRequest") AS payments`
    )
  )[0];
  for (const [table, count] of Object.entries(others)) {
    ok(`nothing was written to ${table}`, count === 0, String(count));
  }

  const mutated = await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM "HistoricalFiscalDocument"
     WHERE "updatedAt" > "createdAt" + interval '1 second'`
  );
  ok("no historical record was ever updated after its insert", mutated[0].c === 0);

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
