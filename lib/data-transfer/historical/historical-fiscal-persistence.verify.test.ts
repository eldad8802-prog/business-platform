/**
 * I-8A — the structural firewall around historical fiscal persistence.
 *
 * NO database and NO network. Everything here is a property of the committed
 * artifacts: the Prisma datamodel, the migration, the erasure manifest, and the
 * absence of consumers.
 *
 * # What this exists to prevent
 *
 * A document that another system issued must never be representable as one
 * Dubiz issued. `BillingDocument` carries that meaning: a number from Dubiz's
 * own sequence, an issuance snapshot, a legal hash, a Dubiz-rendered PDF, and
 * inclusion in the uniform (מבנה אחיד) file filed with the Israeli Tax
 * Authority. If a historical record could reach any of that — by relation, by
 * shared vocabulary, or by a migration that touches billing — the separation
 * would exist only in prose.
 *
 * So the assertions below are about reachability and about vocabulary, and they
 * are made against the files themselves rather than against a description of
 * them. The database-level half of the same firewall (row-level security,
 * privileges, referential actions) is proven on real PostgreSQL in
 * `.i8a/battery.mjs`, because none of it exists in the datamodel.
 *
 * Run: npx tsx lib/data-transfer/historical/historical-fiscal-persistence.verify.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  ANONYMIZE_MODELS,
  DELETE_MODELS,
  RETAIN_MODELS,
  REVOKE_INTEGRATIONS,
  assertManifestSafe,
} from "@/lib/services/account/account-erasure-manifest";

let passed = 0;
function check(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

/** Source read with line endings normalised, so assertions are about content. */
function read(file: string): string {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

/**
 * Tracked files under `paths` that mention the model, case-insensitively.
 * `git grep` exits 1 when it finds nothing, which is the answer we most want
 * here, so an empty result is a value and never an error.
 */
function grepFiles(paths: string[]): string[] {
  let out: string;
  try {
    out = execFileSync("git", ["grep", "-l", "-i", "historicalfiscal", "--", ...paths], {
      encoding: "utf8",
    });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 1) return [];
    throw error;
  }
  return out.split("\n").filter(Boolean).sort();
}

const MIGRATION_DIR = "prisma/migrations/20260907120000_i8a_historical_fiscal_documents";
const MODEL = "HistoricalFiscalDocument";

const schema = read("prisma/schema.prisma");
const migration = read(path.join(MIGRATION_DIR, "migration.sql"));

/**
 * The migration minus its `--` commentary. The header explains at length WHY
 * billing is not touched, and naming a table in order to say "never this one"
 * must not read as touching it. Every assertion about what the migration DOES
 * is made against this view.
 */
const migrationCode = migration
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

/** The body of one Prisma model block. */
function modelBlock(name: string): string {
  const start = schema.indexOf(`model ${name} {`);
  assert.ok(start >= 0, `model ${name} not found`);
  const end = schema.indexOf("\n}", start);
  return schema.slice(start, end);
}

/** Prisma doc comments are prose; the assertions below are about code. */
function codeOnly(block: string): string {
  return block
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

const histBlock = codeOnly(modelBlock(MODEL));
const docBlock = codeOnly(modelBlock("Document"));

/** Scalar field names declared on a model (relations and attributes excluded). */
function scalarFields(block: string): string[] {
  return block
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => /^[a-zA-Z][a-zA-Z0-9_]*\s+\S/.test(line))
    .filter((line) => !/^\S+\s+[A-Z][A-Za-z0-9_]*(\[\]|\?)?\s+@relation/.test(line))
    .map((line) => line.split(/\s+/))
    .filter(([, type]) => !/\[\]$/.test(type))
    .filter(([, type]) =>
      /^(Int|String|Boolean|DateTime|Decimal|Float|Json|Bytes|BigInt)\??$/.test(type)
    )
    .map(([name]) => name);
}

console.log("\nI-8A — historical fiscal persistence firewall\n");

// ───────────────────────────────────────────────────────────────────────────
// 1. The model says what it is, and nothing it is not
// ───────────────────────────────────────────────────────────────────────────
const fields = scalarFields(histBlock);

check("the model exists and carries the fields the design named", () => {
  const required = [
    "id",
    "businessId",
    "documentTypeCode",
    "sourceDocumentTypeRaw",
    "originalDocumentNumber",
    "originalIssueDate",
    "subtotalAmount",
    "vatAmount",
    "totalAmount",
    "currency",
    "customerNameSnapshot",
    "customerTaxIdSnapshot",
    "customerAddressSnapshot",
    "customerEmailSnapshot",
    "customerPhoneSnapshot",
    "sourceSystemCode",
    "sourceSystemNameRaw",
    "originalAllocationNumber",
    "documentId",
    "reversesHistoricalDocumentId",
    "reversesOriginalNumberRaw",
    "importRunId",
    "createdAt",
    "updatedAt",
  ];
  assert.deepEqual(fields.slice().sort(), required.slice().sort());
});

check("there is NO issuance state — no status, no state, no issuedAt", () => {
  for (const forbidden of ["status", "state", "issuedAt", "issuedBy", "voidedAt"]) {
    assert.ok(!fields.includes(forbidden), `historical records must not carry \`${forbidden}\``);
  }
});

check("there is no Dubiz-issuance artifact: no legal hash, no PDF, no signature", () => {
  for (const forbidden of [/legalHash/i, /pdf/i, /signature/i, /signed/i, /snapshotJson/i]) {
    assert.ok(!forbidden.test(histBlock), `unexpected issuance artifact matching ${forbidden}`);
  }
});

check("an allocation number can only be named as the ORIGINAL system's", () => {
  // `allocationNumber` bare is BillingDocument's, and it means Dubiz requested
  // and received it. Here the only spelling permitted says whose it was.
  assert.ok(fields.includes("originalAllocationNumber"));
  assert.ok(!fields.includes("allocationNumber"));
});

check("a document number is TEXT, never an integer drawn from a sequence", () => {
  assert.match(histBlock, /originalDocumentNumber\s+String\?/);
  assert.ok(!/documentNumber\s+Int/.test(histBlock));
});

check("customer identity is a snapshot with no relation to Customer", () => {
  assert.ok(!/\bCustomer\b/.test(histBlock), "no Customer relation may exist");
  assert.ok(!fields.includes("customerId"));
  assert.ok(fields.includes("customerNameSnapshot"));
});

// ───────────────────────────────────────────────────────────────────────────
// 2. Billing is unreachable from here
// ───────────────────────────────────────────────────────────────────────────
check("the model declares no relation to any billing or financial model", () => {
  for (const forbidden of [
    /\bBillingDocument\b/,
    /\bBillingDocumentLine\b/,
    /\bBillingReceiptPayment\b/,
    /\bBillingDocumentNumberSequence\b/,
    /\bBillingAuthoritySubmission\b/,
    /\bBillingPaymentAllocation\b/,
    /\bFinancialEvent\b/,
    /\bFinancialRecord\b/,
    /\bFinancialDocument\b/,
  ]) {
    assert.ok(!forbidden.test(histBlock), `unexpected reference matching ${forbidden}`);
  }
});

check("its only relations are Business, Document, ImportRun and itself", () => {
  const targets = [...histBlock.matchAll(/@relation\([^)]*\)/g)];
  assert.ok(targets.length >= 4, "expected the four declared relations");
  const declared = histBlock
    .split("\n")
    .filter((line) => line.includes("@relation"))
    .map((line) => line.trim().split(/\s+/)[1].replace(/[?[\]]/g, ""));
  for (const target of declared) {
    assert.ok(
      ["Business", "Document", "ImportRun", MODEL].includes(target),
      `unexpected relation target: ${target}`
    );
  }
});

check("no billing model gained a relation back to historical records", () => {
  for (const model of [
    "BillingDocument",
    "BillingDocumentLine",
    "BillingReceiptPayment",
    "BillingDocumentNumberSequence",
    "FinancialEvent",
    "Customer",
  ]) {
    assert.ok(
      !/[Hh]istoricalFiscal/.test(codeOnly(modelBlock(model))),
      `${model} must not reference historical fiscal records`
    );
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Duplicate policy is the import contract's, not the database's
// ───────────────────────────────────────────────────────────────────────────
check("fiscal identity is an INDEX, never a unique constraint", () => {
  assert.match(
    histBlock,
    /@@index\(\[businessId, sourceSystemCode, documentTypeCode, originalDocumentNumber\]\)/
  );
  const uniques = [...histBlock.matchAll(/@@unique\(\[([^\]]+)\]\)/g)].map((m) => m[1]);
  assert.deepEqual(uniques, ["businessId, id"], "the tenant key is the only unique index");
});

// ───────────────────────────────────────────────────────────────────────────
// 4. Every reference is tenant-scoped by construction
// ───────────────────────────────────────────────────────────────────────────
check("the Document and reversal relations are composite, so a cross-tenant reference cannot be written", () => {
  assert.match(
    histBlock,
    /document\s+Document\?\s+@relation\(fields: \[businessId, documentId\], references: \[businessId, id\]/
  );
  assert.match(
    histBlock,
    /fields: \[businessId, reversesHistoricalDocumentId\], references: \[businessId, id\]/
  );
});

check("the artifact and the tenant cannot be deleted out from under a fiscal record", () => {
  const restricted = [...histBlock.matchAll(/@relation\([^)]*onDelete: (\w+)/g)].map((m) => m[1]);
  // Business, Document and the reversal reference are Restrict; only the
  // provenance link to ImportRun may fade to null.
  assert.equal(restricted.filter((a) => a === "Restrict").length, 3);
  assert.equal(restricted.filter((a) => a === "SetNull").length, 1);
  assert.match(histBlock, /importRun ImportRun\? @relation\([^)]*onDelete: SetNull/);
});

check("Document is changed by an index only — it gains no column", () => {
  assert.match(docBlock, /@@unique\(\[businessId, id\]\)/);
  const docFields = scalarFields(docBlock);
  assert.deepEqual(docFields.slice().sort(), [
    "businessId",
    "contentHashSha256",
    "createdAt",
    "fileUrl",
    "id",
    "mimeType",
    "ocrText",
    "originalFilename",
    "sizeBytes",
    "source",
    "status",
  ]);
});

// ───────────────────────────────────────────────────────────────────────────
// 5. The migration is expand-only and touches nothing fiscal
// ───────────────────────────────────────────────────────────────────────────
check("exactly one migration is added, and it is the newest in the tree", () => {
  const dirs = fs
    .readdirSync("prisma/migrations", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const mine = dirs.filter((name) => /i8a/i.test(name));
  assert.deepEqual(mine, ["20260907120000_i8a_historical_fiscal_documents"]);
  assert.equal(dirs[dirs.length - 1], mine[0], "this must be the last migration in order");
  assert.deepEqual(fs.readdirSync(MIGRATION_DIR), ["migration.sql"]);
});

check("the migration never names a billing table, a sequence, or an authority submission", () => {
  for (const forbidden of [
    /BillingDocument/,
    /BillingDocumentNumberSequence/,
    /BillingReceiptPayment/,
    /BillingAuthoritySubmission/,
    /FinancialEvent/i,
    /nextval/i,
    /setval/i,
  ]) {
    assert.ok(!forbidden.test(migrationCode), `migration must not contain ${forbidden}`);
  }
});

check("the migration writes no data", () => {
  for (const forbidden of [/^\s*INSERT\s+INTO/im, /^\s*UPDATE\s+"/im, /^\s*DELETE\s+FROM/im]) {
    assert.ok(!forbidden.test(migrationCode), `migration must not contain ${forbidden}`);
  }
});

check("the migration is expand-only: nothing is dropped or narrowed", () => {
  for (const forbidden of [
    /DROP\s+TABLE/i,
    /DROP\s+COLUMN/i,
    /ALTER\s+COLUMN/i,
    /DROP\s+INDEX/i,
    /RENAME/i,
    /TRUNCATE/i,
  ]) {
    assert.ok(!forbidden.test(migrationCode), `migration must not contain ${forbidden}`);
  }
  // `DROP POLICY IF EXISTS` immediately before `CREATE POLICY` is this repo's
  // idiom for a re-runnable policy definition, not a removal. It is the only
  // DROP permitted, and each one must be paired.
  const drops = [...migrationCode.matchAll(/DROP POLICY IF EXISTS (\w+)/g)].map((m) => m[1]);
  const creates = [...migrationCode.matchAll(/CREATE POLICY (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(drops, creates);
});

check("the only table the migration alters besides its own is none at all", () => {
  const altered = [...migrationCode.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]);
  assert.ok(
    altered.every((t) => t === MODEL),
    `unexpected ALTER TABLE targets: ${[...new Set(altered)].join(", ")}`
  );
  const createdTables = [...migrationCode.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(createdTables, [MODEL]);
});

check("the migration declares row-level security, enabled AND forced", () => {
  assert.match(migrationCode, new RegExp(`ALTER TABLE "${MODEL}" ENABLE ROW LEVEL SECURITY`));
  assert.match(migrationCode, new RegExp(`ALTER TABLE "${MODEL}" FORCE ROW LEVEL SECURITY`));
});

check("its policies are SELECT and INSERT only, both keyed on the tenant GUC", () => {
  const cmds = [...migrationCode.matchAll(/CREATE POLICY \w+ ON "\w+" FOR (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(cmds.slice().sort(), ["INSERT", "SELECT"]);
  const guc = /"businessId" = NULLIF\(current_setting\('app\.current_business_id', true\), ''\)::int/g;
  assert.equal([...migrationCode.matchAll(guc)].length, 2);
});

check("the grant agrees with the policies: read and insert, never update or delete", () => {
  assert.match(migrationCode, new RegExp(`GRANT SELECT, INSERT ON "${MODEL}" TO app_runtime`));
  assert.match(migrationCode, new RegExp(`REVOKE UPDATE ON "${MODEL}" FROM app_runtime`));
  assert.match(migrationCode, new RegExp(`REVOKE DELETE ON "${MODEL}" FROM app_runtime`));
  assert.ok(!/GRANT[^;]*UPDATE/i.test(migrationCode));
  assert.ok(!/GRANT[^;]*DELETE/i.test(migrationCode));
});

check("the migration and the datamodel describe the same columns", () => {
  const createTable = migrationCode.slice(
    migrationCode.indexOf(`CREATE TABLE "${MODEL}"`),
    migrationCode.indexOf(");", migrationCode.indexOf(`CREATE TABLE "${MODEL}"`))
  );
  const columns = [...createTable.matchAll(/^\s+"(\w+)"\s/gm)].map((m) => m[1]);
  assert.deepEqual(columns.slice().sort(), fields.slice().sort());
});

// ───────────────────────────────────────────────────────────────────────────
// 6. Retention, and the absence of consumers
// ───────────────────────────────────────────────────────────────────────────
check("account deletion RETAINS historical fiscal records", () => {
  assert.ok(RETAIN_MODELS.includes("historicalFiscalDocument" as never));
  const purged: string[] = [
    ...ANONYMIZE_MODELS.map((a) => a.model),
    ...DELETE_MODELS,
    ...REVOKE_INTEGRATIONS.map((r) => r.model),
  ];
  assert.ok(!purged.includes("historicalFiscalDocument"));
  assertManifestSafe();
});

check("nothing reads or writes this model yet — the layer is inert", () => {
  const hits = grepFiles(["app", "lib", "components", "scripts"]);
  // Three files may name it, and none of them touches a row: the erasure
  // manifest lists it as retained, and two tests assert about it. A fourth
  // file appearing here means something started using the model, which is a
  // decision for its own increment.
  assert.deepEqual(hits.slice().sort(), [
    "lib/data-transfer/historical/historical-fiscal-persistence.verify.test.ts",
    "lib/services/account/account-deletion.test.ts",
    "lib/services/account/account-erasure-manifest.ts",
  ]);
});

check("the uniform file still draws from BillingDocument alone", () => {
  const loader = read("lib/services/billing/uniform/uniform-export-loader.ts");
  assert.ok(!/[Hh]istoricalFiscal/.test(loader));
  assert.match(loader, /billingDocument\.findMany/);
  assert.deepEqual(
    grepFiles(["lib/services/billing", "app/api/reports", "app/api/billing"]),
    [],
    "no billing surface may reference historical records"
  );
});

console.log(`\n  ${passed} checks passed\n`);
