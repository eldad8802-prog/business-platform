/**
 * I-8A — historical fiscal persistence, against REAL PostgreSQL 17.
 *
 * Everything I-8A claims is a database property: row-level security, privileges,
 * composite foreign keys, referential actions, a check constraint, and the
 * DELIBERATE ABSENCE of a uniqueness rule. None of that can be shown by reading
 * TypeScript, and none of it exists in the Prisma datamodel — RLS, grants and
 * the check constraint live only in the migration. So the migration file itself
 * is what gets applied here, and then interrogated.
 *
 * TWO ROLES, ON PURPOSE.
 *   * the owner connection is a CI superuser. Superusers bypass RLS entirely,
 *     so proving isolation through it would prove nothing at all.
 *   * every isolation and privilege assertion runs through a second role that
 *     is NOT superuser and NOT bypassrls — and the battery asserts that about
 *     the role before trusting a single result from it.
 *
 * THE DEFAULT-PRIVILEGE HAZARD IS REPRODUCED, NOT ASSUMED. This project's
 * databases carry ALTER DEFAULT PRIVILEGES granting the runtime role a,r,w,d on
 * every new table. The lab sets that up BEFORE the migration runs, so the
 * migration's REVOKEs are load-bearing here exactly as they are in production.
 *
 * Synthetic data only. No Neon, no production, no secrets.
 *
 * Run: node .i8a/battery.mjs
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
const runtime = new PrismaClient({ datasourceUrl: RUNTIME_URL });

/** Run a body inside one transaction with the tenant GUC set, as PROD does. */
function asTenant(client, businessId, body) {
  return client.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      "SELECT set_config('app.current_business_id', $1, true)",
      businessId === null ? "" : String(businessId)
    );
    return body(tx);
  });
}

/** Expect a failure, and expect it for the RIGHT reason. */
async function rejects(label, pattern, fn) {
  try {
    await fn();
    ok(label, false, "the statement SUCCEEDED");
  } catch (error) {
    const message = String(error?.message ?? error);
    ok(label, pattern.test(message), `wrong error: ${message.slice(0, 200)}`);
  }
}

/**
 * Split a migration into executable statements. Naive splitting on ";" would
 * cut the guarded grant block in half, so dollar-quoted bodies are tracked and
 * line comments are dropped first.
 */
function splitSql(sql) {
  const lines = sql.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let current = "";
  let tag = null;

  for (const raw of lines) {
    // A whole-line comment outside a dollar-quoted body carries no statement.
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

const one = async (client, sql, ...args) => {
  const rows = await client.$queryRawUnsafe(sql, ...args);
  return rows[0];
};

async function main() {
  console.log("\nI-8A — historical fiscal persistence battery (real PostgreSQL)\n");

  const version = await one(owner, "SELECT version() AS v");
  console.log(`  server: ${String(version.v).split(",")[0]}\n`);

  // ── 0. The lab is only meaningful if the runtime role really is restricted ──
  const role = await one(
    owner,
    `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`,
    RUNTIME_ROLE
  );
  ok("runtime role is NOT superuser (a superuser would bypass every policy)", role?.rolsuper === false);
  ok("runtime role is NOBYPASSRLS", role?.rolbypassrls === false);

  // ── 1. Undo what `prisma db push` built, so the migration has work to do ───
  // db push builds the table from the datamodel, which knows nothing about RLS,
  // grants or the check constraint — and it also creates the very index the
  // migration adds to Document. Removing both first is what makes the snapshot
  // below a genuine "before".
  await owner.$executeRawUnsafe(`DROP TABLE IF EXISTS "HistoricalFiscalDocument" CASCADE`);
  await owner.$executeRawUnsafe(`DROP INDEX IF EXISTS "Document_businessId_id_key"`);

  const docColsBefore = await owner.$queryRawUnsafe(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_name = 'Document' ORDER BY column_name`
  );
  const docIdxBefore = await owner.$queryRawUnsafe(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'Document' ORDER BY indexname`
  );
  const billingCols = await owner.$queryRawUnsafe(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_name LIKE 'Billing%' ORDER BY table_name, column_name`
  );

  // ── 2. Apply the MIGRATION itself, statement by statement ──────────────────
  const statements = splitSql(fs.readFileSync(MIGRATION, "utf8"));
  for (const statement of statements) {
    await owner.$executeRawUnsafe(statement);
  }
  ok(
    `the migration applies cleanly to a fresh database (${statements.length} statements)`,
    statements.length > 0
  );

  // ── 3. Document changed by an index and nothing else ───────────────────────
  const docColsAfter = await owner.$queryRawUnsafe(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_name = 'Document' ORDER BY column_name`
  );
  const docIdxAfter = await owner.$queryRawUnsafe(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'Document' ORDER BY indexname`
  );
  ok(
    "Document columns are byte-identical before and after the migration",
    JSON.stringify(docColsBefore) === JSON.stringify(docColsAfter)
  );
  const addedIdx = docIdxAfter
    .map((r) => r.indexname)
    .filter((n) => !docIdxBefore.some((b) => b.indexname === n));
  ok(
    "the migration adds exactly one Document index, and it is the composite key",
    addedIdx.length === 1 && addedIdx[0] === "Document_businessId_id_key",
    JSON.stringify(addedIdx)
  );

  const billingColsAfter = await owner.$queryRawUnsafe(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_name LIKE 'Billing%' ORDER BY table_name, column_name`
  );
  ok(
    "no Billing* table gained, lost or changed a column",
    JSON.stringify(billingCols) === JSON.stringify(billingColsAfter)
  );

  // ── 4. Row-level security is on, forced, and shaped as declared ────────────
  const rls = await one(
    owner,
    `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'HistoricalFiscalDocument'`
  );
  ok("row-level security is ENABLED", rls?.relrowsecurity === true);
  ok("row-level security is FORCED (the table owner is subject to it too)", rls?.relforcerowsecurity === true);

  const policies = await owner.$queryRawUnsafe(
    `SELECT policyname, cmd FROM pg_policies WHERE tablename = 'HistoricalFiscalDocument' ORDER BY cmd`
  );
  const cmds = policies.map((p) => p.cmd).sort();
  ok("exactly two policies exist: SELECT and INSERT", JSON.stringify(cmds) === '["INSERT","SELECT"]', JSON.stringify(policies));
  ok(
    "there is NO UPDATE policy and NO DELETE policy and no catch-all ALL policy",
    !policies.some((p) => p.cmd === "UPDATE" || p.cmd === "DELETE" || p.cmd === "ALL")
  );

  // ── 5. Privileges agree with the policies ──────────────────────────────────
  const priv = await one(
    owner,
    `SELECT has_table_privilege($1, '"HistoricalFiscalDocument"', 'SELECT') AS s,
            has_table_privilege($1, '"HistoricalFiscalDocument"', 'INSERT') AS i,
            has_table_privilege($1, '"HistoricalFiscalDocument"', 'UPDATE') AS u,
            has_table_privilege($1, '"HistoricalFiscalDocument"', 'DELETE') AS d`,
    RUNTIME_ROLE
  );
  ok("runtime may SELECT", priv?.s === true);
  ok("runtime may INSERT", priv?.i === true);
  ok("runtime may NOT UPDATE — the default-privilege grant was revoked", priv?.u === false);
  ok("runtime may NOT DELETE — the default-privilege grant was revoked", priv?.d === false);
  const seq = await one(
    owner,
    `SELECT has_sequence_privilege($1, '"HistoricalFiscalDocument_id_seq"', 'USAGE') AS u`,
    RUNTIME_ROLE
  );
  ok("runtime may USE the id sequence (an insert is useless without it)", seq?.u === true);

  // ── 6. Fixtures. Written by the owner, since the tenants must both exist ───
  const [bizA, bizB] = await owner.$queryRawUnsafe(
    `INSERT INTO "Business" ("name", "updatedAt") VALUES ('I8A tenant A', now()), ('I8A tenant B', now()) RETURNING id`
  );
  const A = bizA.id;
  const B = bizB.id;

  const INSERT_DOC = `INSERT INTO "Document" ("businessId","fileUrl","source","mimeType","status")
     VALUES ($1,$2,'upload','application/pdf','processed') RETURNING id`;
  const docA = await one(owner, INSERT_DOC, A, "lab://a");
  const docB = await one(owner, INSERT_DOC, B, "lab://b");

  const runA = await one(
    owner,
    `INSERT INTO "ImportRun"
       ("businessId","userId","domain","contentHash","mappingHash","decisionsHash","totalRows","status")
     VALUES ($1, 1, 'documents', 'c', 'm', 'd', 0, 'COMPLETED') RETURNING id`,
    A
  );

  const HIST_COLUMNS = `INSERT INTO "HistoricalFiscalDocument"
      ("businessId","documentTypeCode","sourceSystemCode","originalDocumentNumber","updatedAt")
      VALUES ($1,$2,$3,$4, now())`;
  const INSERT_HIST = `${HIST_COLUMNS} RETURNING id`;
  /**
   * The same insert WITHOUT `RETURNING`, and the distinction matters. Returning
   * a row also asks the SELECT policy about it, so a refusal could come from
   * either policy — and a battery that cannot tell them apart would call an
   * open INSERT policy safe. The rejection cases below use this form, so only
   * the INSERT policy can be the one refusing.
   */
  const INSERT_HIST_BLIND = HIST_COLUMNS;

  // ── 7. Tenant isolation, through the restricted role ───────────────────────
  const inserted = await asTenant(runtime, A, (tx) =>
    tx.$queryRawUnsafe(INSERT_HIST, A, "INVOICE", "legacy-erp", "1001")
  );
  ok("runtime can insert a historical record for its OWN tenant", inserted?.[0]?.id > 0);
  const histA = inserted[0].id;

  await rejects(
    "an insert naming ANOTHER tenant is refused by the INSERT policy alone",
    /row-level security|new row violates/i,
    () =>
      asTenant(runtime, A, (tx) =>
        tx.$executeRawUnsafe(INSERT_HIST_BLIND, B, "INVOICE", "legacy-erp", "9001")
      )
  );

  await rejects(
    "an insert with NO tenant context is refused — there is no ambient default",
    /row-level security|new row violates|invalid input syntax/i,
    () =>
      asTenant(runtime, null, (tx) =>
        tx.$executeRawUnsafe(INSERT_HIST_BLIND, A, "INVOICE", "legacy-erp", "9002")
      )
  );

  // tenant B's row, planted by the owner so that A has something to NOT see
  const histB = (
    await owner.$queryRawUnsafe(INSERT_HIST, B, "INVOICE", "other-erp", "1001")
  )[0].id;

  const seenByA = await asTenant(runtime, A, (tx) =>
    tx.$queryRawUnsafe(`SELECT id, "businessId" FROM "HistoricalFiscalDocument" ORDER BY id`)
  );
  ok(
    "an unfiltered SELECT under tenant A returns ONLY tenant A rows",
    seenByA.length > 0 && seenByA.every((r) => r.businessId === A),
    JSON.stringify(seenByA)
  );
  ok("tenant B's row is invisible to tenant A", !seenByA.some((r) => r.id === histB));

  const seenByB = await asTenant(runtime, B, (tx) =>
    tx.$queryRawUnsafe(`SELECT id FROM "HistoricalFiscalDocument" ORDER BY id`)
  );
  ok(
    "and the isolation holds in the other direction",
    seenByB.length > 0 && !seenByB.some((r) => r.id === histA)
  );

  // ── 8. The record is immutable to the runtime ──────────────────────────────
  await rejects(
    "runtime UPDATE is refused at the privilege level",
    /permission denied/i,
    () =>
      asTenant(runtime, A, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "HistoricalFiscalDocument" SET "totalAmount" = 1 WHERE id = $1`,
          histA
        )
      )
  );
  await rejects(
    "runtime DELETE is refused at the privilege level",
    /permission denied/i,
    () =>
      asTenant(runtime, A, (tx) =>
        tx.$executeRawUnsafe(`DELETE FROM "HistoricalFiscalDocument" WHERE id = $1`, histA)
      )
  );

  // ── 9. Cross-tenant references are unrepresentable, not merely discouraged ─
  await rejects(
    "a tenant-A record cannot point at a tenant-B Document",
    /foreign key/i,
    () =>
      owner.$executeRawUnsafe(
        `INSERT INTO "HistoricalFiscalDocument"
           ("businessId","documentTypeCode","sourceSystemCode","documentId","updatedAt")
         VALUES ($1,'INVOICE','legacy-erp',$2, now())`,
        A,
        docB.id
      )
  );

  const linked = await one(
    owner,
    `INSERT INTO "HistoricalFiscalDocument"
       ("businessId","documentTypeCode","sourceSystemCode","documentId","importRunId","updatedAt")
     VALUES ($1,'INVOICE','legacy-erp',$2,$3, now()) RETURNING id`,
    A,
    docA.id,
    runA.id
  );
  ok("a same-tenant Document link is accepted", linked?.id > 0);

  const second = await one(
    owner,
    `INSERT INTO "HistoricalFiscalDocument"
       ("businessId","documentTypeCode","sourceSystemCode","documentId","updatedAt")
     VALUES ($1,'RECEIPT','legacy-erp',$2, now()) RETURNING id`,
    A,
    docA.id
  );
  ok(
    "two historical records may describe ONE artifact — a batch scan is not an error",
    second?.id > 0
  );

  // ── 10. Reversal references ────────────────────────────────────────────────
  await rejects(
    "a reversal cannot reach across tenants",
    /foreign key/i,
    () =>
      owner.$executeRawUnsafe(
        `INSERT INTO "HistoricalFiscalDocument"
           ("businessId","documentTypeCode","sourceSystemCode","reversesHistoricalDocumentId","updatedAt")
         VALUES ($1,'CREDIT_NOTE','legacy-erp',$2, now())`,
        A,
        histB
      )
  );
  const credit = await one(
    owner,
    `INSERT INTO "HistoricalFiscalDocument"
       ("businessId","documentTypeCode","sourceSystemCode","reversesHistoricalDocumentId","updatedAt")
     VALUES ($1,'CREDIT_NOTE','legacy-erp',$2, now()) RETURNING id`,
    A,
    histA
  );
  ok("a same-tenant reversal reference is accepted", credit?.id > 0);
  await rejects(
    "a record cannot reverse itself",
    /check constraint/i,
    () =>
      owner.$executeRawUnsafe(
        `UPDATE "HistoricalFiscalDocument" SET "reversesHistoricalDocumentId" = id WHERE id = $1`,
        credit.id
      )
  );

  // ── 11. Retention: the artifact and the tenant cannot be pulled out from ──
  //        under the fiscal record, but provenance may fade.
  await rejects(
    "deleting the linked Document is refused while a historical record cites it",
    /foreign key|violates/i,
    () => owner.$executeRawUnsafe(`DELETE FROM "Document" WHERE id = $1`, docA.id)
  );
  await rejects(
    "deleting the Business is refused while historical records exist",
    /foreign key|violates/i,
    () => owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE id = $1`, A)
  );
  await owner.$executeRawUnsafe(`DELETE FROM "ImportRun" WHERE id = $1`, runA.id);
  const afterRun = await one(
    owner,
    `SELECT "importRunId" FROM "HistoricalFiscalDocument" WHERE id = $1`,
    linked.id
  );
  ok(
    "deleting the import run nulls the provenance link and KEEPS the record",
    afterRun !== undefined && afterRun.importRunId === null
  );

  // ── 12. The absent uniqueness rule is a decision, so it is tested ──────────
  const dupe = await one(owner, INSERT_HIST, A, "INVOICE", "legacy-erp", "1001");
  ok(
    "a second record with the SAME fiscal identity is ACCEPTED — the index is not a constraint",
    dupe?.id > 0
  );
  // The primary key is a unique index too, and it is not the kind under
  // discussion, so it is excluded by what it IS rather than by its name.
  const uniques = await owner.$queryRawUnsafe(
    `SELECT c.relname AS indexname
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = '"HistoricalFiscalDocument"'::regclass
       AND i.indisunique AND NOT i.indisprimary
     ORDER BY c.relname`
  );
  ok(
    "apart from the primary key, the only unique index is the tenant composite key",
    uniques.length === 1 && uniques[0].indexname === "HistoricalFiscalDocument_businessId_id_key",
    JSON.stringify(uniques)
  );

  // ── 13. Money and currency are stored as given ─────────────────────────────
  const money = await one(
    owner,
    `INSERT INTO "HistoricalFiscalDocument"
       ("businessId","documentTypeCode","sourceSystemCode","subtotalAmount","vatAmount","totalAmount","updatedAt")
     VALUES ($1,'INVOICE','legacy-erp', 9999999999999999.99, 0.01, 1234567890123456.78, now())
     RETURNING "totalAmount"::text AS total, "vatAmount"::text AS vat, "currency"`,
    A
  );
  ok("a 18,2 amount round-trips without loss", money?.total === "1234567890123456.78", money?.total);
  ok("a two-decimal minimum is preserved", money?.vat === "0.01", money?.vat);
  ok("currency has NO default — an unstated currency stays unstated", money?.currency === null);

  // ── 14. The billing firewall, measured rather than asserted ───────────────
  const fks = await owner.$queryRawUnsafe(
    `SELECT confrelid::regclass::text AS target
     FROM pg_constraint
     WHERE conrelid = '"HistoricalFiscalDocument"'::regclass AND contype = 'f'
     ORDER BY target`
  );
  const targets = fks.map((f) => f.target.replace(/"/g, ""));
  ok(
    "every foreign key points at Business, Document, ImportRun or itself — nothing billing",
    targets.every((t) =>
      ["Business", "Document", "ImportRun", "HistoricalFiscalDocument"].includes(t)
    ),
    JSON.stringify(targets)
  );
  ok(
    "no foreign key reaches a Billing table, a FinancialEvent, or a Customer",
    !targets.some((t) => /^Billing|^Financial|^Customer/.test(t)),
    JSON.stringify(targets)
  );

  const billingRows = await one(
    owner,
    `SELECT (SELECT count(*) FROM "BillingDocument")::int AS docs,
            (SELECT count(*) FROM "BillingDocumentNumberSequence")::int AS seqs,
            (SELECT count(*) FROM "FinancialEvent")::int AS events`
  );
  ok("zero BillingDocument rows exist after the entire battery", billingRows?.docs === 0, String(billingRows?.docs));
  ok("no document number was ever allocated", billingRows?.seqs === 0, String(billingRows?.seqs));
  ok("no FinancialEvent was created", billingRows?.events === 0, String(billingRows?.events));

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
    await runtime.$disconnect().catch(() => {});
  });
