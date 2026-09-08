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
 * Tracked files under `paths` that mention `needle`, case-insensitively.
 * `git grep` exits 1 when it finds nothing, which is the answer we most want
 * here, so an empty result is a value and never an error.
 */
function grepFiles(paths: string[], needle = "historicalfiscal"): string[] {
  let out: string;
  try {
    out = execFileSync("git", ["grep", "-l", "-i", needle, "--", ...paths], {
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
check("exactly one migration adds it, and nothing after it touches it", () => {
  const dirs = fs
    .readdirSync("prisma/migrations", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const mine = dirs.filter((name) => /i8a/i.test(name));
  assert.deepEqual(mine, ["20260907120000_i8a_historical_fiscal_documents"]);

  // This used to read "and it is the last migration in the tree", which held
  // only until the next unrelated migration landed. What it was protecting is
  // narrower and does not expire: the table is created once, and no migration
  // ordered after it alters it or reaches billing on its way past.
  for (const later of dirs.slice(dirs.indexOf(mine[0]) + 1)) {
    const sql = read(path.join("prisma/migrations", later, "migration.sql"))
      .split(String.fromCharCode(10))
      .filter((line) => !line.trimStart().startsWith("--"))
      .join(String.fromCharCode(10));
    assert.ok(
      !/HistoricalFiscalDocument/i.test(sql),
      `${later} must not touch the historical fiscal table`
    );
  }
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
check("account deletion RETAINS a historical fiscal record", () => {
  // A fiscal record is kept because it is fiscal, not because Dubiz produced
  // it. The obligation to hold an invoice does not ask which software issued
  // it, so this model belongs beside `document` and `billingDocument` in the
  // must-retain bucket, and never in a purge set.
  assert.ok(RETAIN_MODELS.includes("historicalFiscalDocument" as never));
  const purged: string[] = [
    ...ANONYMIZE_MODELS.map((a) => a.model),
    ...DELETE_MODELS,
    ...REVOKE_INTEGRATIONS.map((r) => r.model),
  ];
  assert.ok(!purged.includes("historicalFiscalDocument"));
  assertManifestSafe();
});

/**
 * The files permitted to name the model, and why each one is.
 *
 * This began as "nothing may name it at all", which was the right rule while
 * the layer had no lifecycle. Account erasure is a lifecycle, and it has to be
 * able to say these records are retained — a manifest that cannot name a model
 * cannot promise anything about it. So the ban becomes a list: naming it is
 * allowed here and nowhere else, and the ban on TOUCHING a row is unchanged and
 * asserted separately below.
 */
const ALLOWED_TO_NAME_IT = [
  // this file
  "lib/data-transfer/historical/historical-fiscal-persistence.verify.test.ts",
  // the erasure contract, which declares the model legally retained
  "lib/services/account/account-erasure-manifest.ts",
  // and the test that holds that contract to it
  "lib/services/account/account-deletion.test.ts",
  // I-8B.1: the import field contract. Its whole job is to say which model
  // field each owner-facing column becomes, so it names the model by
  // necessity — and it holds no query, no client and no row.
  "lib/data-transfer/historical/historical-fields.ts",
  // the vocabularies, which state why the customer snapshot has no relation
  "lib/data-transfer/historical/historical-vocabulary.ts",
  // and the test that holds both to their contract
  "lib/data-transfer/historical/historical-contract.verify.test.ts",
  // I-8B.2: the Analyze test, which names the model in order to REFUSE it —
  // its zero-write check reads the analyzer's source and requires the model to
  // be absent from it. The analyzer itself does not name it at all.
  "lib/data-transfer/historical/historical-analyze.verify.test.ts",
  // I-8B.3: the duplicate lookup. This is the FIRST file that reads a row, and
  // it is a different kind of entry from the ones above — see the read-only
  // check below, which is what makes it safe to list here.
  "lib/data-transfer/historical/historical-duplicates.ts",
  // and the test that holds it to reading only
  "lib/data-transfer/historical/historical-duplicates.verify.test.ts",
  // I-8B.4: the Preview test, which names the model in the list of writes the
  // preview path must not contain. Preview itself does not name it — it reads
  // through the duplicate lookup above and never touches the model directly.
  "lib/data-transfer/historical/historical-preview.verify.test.ts",
  // I-8B.5: the WRITER, and the route that reaches it. This is the first entry
  // of its kind — see the writer rule below, which is what makes listing it
  // safe: one verb, never update or delete, inside the tenant transaction.
  "lib/data-transfer/historical/historical-execute.ts",
  "app/api/data-transfer/import/historical/execute/route.ts",
  // and the test that holds the writer to exactly that
  "lib/data-transfer/historical/historical-execute.verify.test.ts",
];

check("only the erasure contract and the import contract name this model", () => {
  const hits = grepFiles(["app", "lib", "components", "scripts"]);
  assert.deepEqual(
    hits.slice().sort(),
    ALLOWED_TO_NAME_IT.slice().sort(),
    "a new consumer appeared; that is a decision for its own increment"
  );
});

check("naming the model is all the contract files do — none of them can read one", () => {
  // The allowlist is only safe while "names it" and "reaches it" stay
  // different things. A contract file that acquired a Prisma client would be a
  // consumer wearing a declaration's clothes, so the distinction is measured
  // rather than trusted.
  // The two contract SOURCES, named rather than filtered: a verifier that
  // swept itself would trip over its own list of forbidden strings.
  for (const file of [
    "lib/data-transfer/historical/historical-fields.ts",
    "lib/data-transfer/historical/historical-vocabulary.ts",
  ]) {
    const src = read(file);
    for (const forbidden of ["@/lib/prisma", "PrismaClient", "findMany", "findUnique", "createMany"]) {
      assert.ok(!src.includes(forbidden), `${file} must not be able to reach a row (${forbidden})`);
    }
  }
});

check("the erasure EXECUTOR still cannot reach a row — only the manifest names it", () => {
  // This is the distinction the allowlist rests on. The manifest is a
  // declaration and touches nothing; the adapter is the code that actually
  // anonymizes and deletes. If the model ever appears in the adapter or the
  // orchestrator, a deletion path has been opened against records that must be
  // kept.
  for (const executor of [
    "lib/services/account/account-deletion.prisma-store.ts",
    "lib/services/account/account-deletion.service.ts",
  ]) {
    assert.ok(
      !/[Hh]istoricalFiscal/.test(read(executor)),
      `${executor} must never operate on historical fiscal records`
    );
  }
});

check("every other surface is still inert", () => {
  // Named individually rather than by absence, so a new surface has to be
  // argued for instead of appearing by accident.
  const forbidden: Record<string, string[]> = {
    "billing and issuance": ["lib/services/billing", "app/api/billing"],
    "reporting and the uniform file": ["app/api/reports", "lib/services/billing/uniform"],
    "documents ingestion": ["lib/services/documents", "app/api/documents"],
    "import analyze, preview and execute": [
      "lib/data-transfer/import",
      "lib/data-transfer/documents",
    ],
    "user interface": ["components", "app/(shell)"],
    learning: ["lib/business-memory", "lib/business-brain"],
  };
  for (const [surface, paths] of Object.entries(forbidden)) {
    assert.deepEqual(grepFiles(paths), [], `${surface} must not reference historical records`);
  }
});

check("naming the transfer domain did not connect it to issuance", () => {
  // I-8B.0 registered `historical-documents` in the data-transfer registry.
  // That is a name and a set of rules; it must not have become a route into
  // billing. The model firewall above covers the MODEL by its own name, so this
  // covers the DOMAIN by its id, which is the string a later increment would
  // realistically thread through a writer or a report.
  const DOMAIN_ID = "historical-documents";
  for (const [surface, paths] of Object.entries({
    "billing and issuance": ["lib/services/billing", "app/api/billing"],
    "reporting and the uniform file": ["app/api/reports", "lib/services/billing/uniform"],
    "payments and settlement": ["lib/services/payments", "app/api/payments"],
  })) {
    assert.deepEqual(
      grepFiles(paths, DOMAIN_ID),
      [],
      `${surface} must not reference the historical transfer domain`
    );
  }
  // And the registry entry itself names no fiscal machinery.
  const registry = read("lib/data-transfer/domains.ts");
  const entry = registry.slice(registry.indexOf(`id: "${DOMAIN_ID}"`));
  for (const forbidden of ["BillingDocument", "issuedAt", "allocationNumber", "ISSUED"]) {
    assert.ok(!entry.includes(forbidden), `the registry entry must not mention ${forbidden}`);
  }
});

check("the one file that reads a row can ONLY read, and only inside the tenant", () => {
  // I-8B.3 introduced the first read of a historical record. The allowlist was
  // "declaration allowed, execution forbidden"; a read is neither, so it gets
  // its own rule rather than being folded into either. What makes it safe is
  // measurable: one verb, no mutation, and the tenant GUC around it.
  const reader = "lib/data-transfer/historical/historical-duplicates.ts";
  const code = read(reader)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

  const verbs = [...code.matchAll(/historicalFiscalDocument\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(verbs)], ["findMany"], "the only verb may be a read");
  for (const forbidden of [
    ".create(",
    ".createMany(",
    ".update(",
    ".updateMany(",
    ".upsert(",
    ".delete(",
    ".deleteMany(",
    ".executeRaw",
  ]) {
    assert.ok(!code.includes(forbidden), `${reader} must not contain ${forbidden}`);
  }
  assert.ok(
    code.includes("withTenantTransaction"),
    "the read must carry the tenant GUC that row-level security evaluates"
  );
  // And it must never write the relation the model has no UPDATE path for.
  assert.ok(!code.includes("reversesHistoricalDocumentId:"));
});

check("Analyze knows the field contract and nothing about issuance", () => {
  // I-8B.2 gave the historical layer its first real capability. Analyze may
  // read a file and judge it; it must not have acquired a route to anything
  // that ISSUES. Checked on the analyzer and its route together, because a
  // capability is only as narrow as its entry point.
  for (const file of [
    "lib/data-transfer/historical/historical-analyze.ts",
    "app/api/data-transfer/import/historical/analyze/route.ts",
  ]) {
    const src = read(file);
    for (const forbidden of [
      "billingDocument",
      "BillingDocument",
      "BillingDocumentNumberSequence",
      "billing-issue",
      "billing-draft",
      "allocationNumber",
      "AuthoritySubmission",
      "uniform",
      "financialEvent",
      "FinancialEvent",
      "paymentAllocation",
      "billing-pdf",
      "signedPdf",
      "ISSUED",
    ]) {
      assert.ok(!src.includes(forbidden), `${file} must not reach ${forbidden}`);
    }
  }
});

check("the one file that WRITES a row can only insert one", () => {
  // I-8B.5 opened the first write. The migration gave this table SELECT and
  // INSERT and revoked the rest, so an UPDATE would be refused by the database
  // — but the code should not be trying, and "the database would have stopped
  // it" is a worse answer than "it was never written".
  const writer = "lib/data-transfer/historical/historical-execute.ts";
  const code = read(writer)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

  const verbs = [...code.matchAll(/historicalFiscalDocument\s*\.\s*(\w+)\s*\(/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(verbs)].sort(),
    ["create", "findFirst", "findMany", "count"].filter((v) => verbs.includes(v)).sort(),
    `unexpected verb on the model: ${JSON.stringify([...new Set(verbs)])}`
  );
  for (const forbidden of ["update", "updateMany", "upsert", "delete", "deleteMany"]) {
    assert.ok(
      !verbs.includes(forbidden),
      `the writer must never ${forbidden} a historical record`
    );
  }

  // The insert happens under the identity lock, inside the tenant transaction,
  // beside its ledger marker. Any one of those missing is a different failure.
  assert.ok(code.includes("lockHistoricalIdentity"), "the insert must be serialised");
  assert.ok(code.includes("withTenantTransaction"), "and carry the tenant GUC");
  assert.ok(code.includes("markRow(tx,"), "and commit with its marker");
});

check("the capability is Analyze, Preview and Execute — and nothing generic", () => {
  // I-8B.4 granted Preview, one route at a time. The generic routes still gate
  // on a list this domain is absent from, so nothing was granted wholesale, and
  // there is no historical execute route to call. A third route appearing here
  // is a decision, not a refactor.
  const registry = read("lib/data-transfer/export/export-registry.ts");
  assert.ok(!registry.includes("historical"));
  for (const granted of [
    "app/api/data-transfer/import/historical/analyze/route.ts",
    "app/api/data-transfer/import/historical/preview/route.ts",
  ]) {
    assert.ok(fs.existsSync(granted), `${granted} must exist`);
  }
  assert.ok(
    fs.existsSync("app/api/data-transfer/import/historical/execute/route.ts"),
    "execute must exist"
  );
  // Nothing was granted wholesale: the generic writer registry still has no
  // historical entry, so the six tabular domains behave exactly as they did.
  const writers = read("lib/data-transfer/import/execute/domain-writers.ts");
  assert.ok(!writers.includes("historical"));
});

check("the Preview path cannot write, and does not reach issuance", () => {
  // Preview signs a token and reads through the duplicate lookup. Neither is a
  // write, and neither is a route into billing.
  for (const file of [
    "lib/data-transfer/historical/historical-preview.ts",
    "lib/data-transfer/historical/historical-decisions.ts",
    "lib/data-transfer/historical/historical-preview-token.ts",
    "app/api/data-transfer/import/historical/preview/route.ts",
  ]) {
    const code = read(file)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    for (const forbidden of [
      "billingDocument",
      "BillingDocument",
      "financialEvent",
      "FinancialEvent",
      "allocationNumber",
      "uniform",
      "ISSUED",
      "@/lib/prisma",
      ".executeRaw",
    ]) {
      assert.ok(!code.includes(forbidden), `${file} must not reach ${forbidden}`);
    }
    assert.ok(
      !/\b(historicalFiscalDocument|importRun|customer)\s*\.\s*(create|update|upsert|delete)/.test(
        code
      ),
      `${file} must not write a business record`
    );
  }
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
