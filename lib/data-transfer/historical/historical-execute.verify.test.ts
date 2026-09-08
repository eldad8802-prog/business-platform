/**
 * I-8B.5 — historical Execute: the guarantees provable without a database.
 *
 * The behaviour that needs PostgreSQL — Decimal round trips, calendar days,
 * advisory locks, ledger atomicity, replay and concurrency — is proven in
 * `.i8b5/battery.mjs` and `.i8b5/concurrency.mjs`. What is proven here is the
 * shape of the writer: which token facts must match before anything runs, that
 * the run identity covers everything that could make two executions different,
 * and that the write surface is exactly the two tables it is allowed to touch.
 *
 * Run: npx tsx lib/data-transfer/historical/historical-execute.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  executionContractHash,
  executeHistoricalImport,
} from "@/lib/data-transfer/historical/historical-execute";
import {
  historicalIdentityLockKey,
  HISTORICAL_IDENTITY_ADVISORY_NAMESPACE,
} from "@/lib/data-transfer/historical/historical-identity-lock";
import { DOCUMENT_CONTENT_ADVISORY_NAMESPACE } from "@/lib/services/documents/document-duplicate";
import { ADVISORY_NAMESPACE } from "@/lib/tenant/business-lifecycle";
import { issueHistoricalPreviewToken } from "@/lib/data-transfer/historical/historical-preview-token";
import { issuePreviewToken } from "@/lib/data-transfer/import/preview/preview-token";

let passed = 0;
const failures: string[] = [];

function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok  ${label}`);
    })
    .catch((error: unknown) => {
      failures.push(label);
      console.log(`FAIL  ${label} — ${(error as Error).message}`);
    });
}

/** Source with comments stripped, so a guard never fires on its own prose. */
function codeOf(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const EXECUTE = "lib/data-transfer/historical/historical-execute.ts";
const ROUTE = "app/api/data-transfer/import/historical/execute/route.ts";
const LOCK = "lib/data-transfer/historical/historical-identity-lock.ts";

async function main(): Promise<void> {
  process.env.AUTH_TOKEN_SECRET ||= "i8b5-test-secret";
  console.log("\nI-8B.5 — historical execute, structural guarantees\n");

  /* ================================================== 1. the token ====== */

  const bytes = Buffer.from("not a real spreadsheet");
  const baseInput = {
    businessId: 7,
    userId: 11,
    filename: "history.xlsx",
    bytes,
    decisions: {},
  };

  await check("no token means nothing runs", async () => {
    const result = await executeHistoricalImport({ ...baseInput, previewToken: "" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "TOKEN_INVALID");
  });

  await check("a forged or garbage token is refused before any read", async () => {
    for (const junk of ["abc", "a.b", "x.y.z"]) {
      const result = await executeHistoricalImport({ ...baseInput, previewToken: junk });
      assert.equal(result.ok, false, junk);
      if (!result.ok) assert.equal(result.code, "TOKEN_INVALID", junk);
    }
  });

  await check("a TABULAR preview token cannot execute a historical import", async () => {
    const tabular = issuePreviewToken({
      businessId: 7,
      userId: 11,
      domain: "customers",
      contentHash: "c".repeat(64),
      mappingHash: "m".repeat(64),
      decisionsHash: "d".repeat(64),
      sheetName: null,
      rowCount: 1,
    });
    const result = await executeHistoricalImport({ ...baseInput, previewToken: tabular });
    assert.equal(result.ok, false);
    // It fails at the SIGNATURE, because the key label differs — not at a
    // domain field somebody remembered to check.
    if (!result.ok) assert.equal(result.code, "TOKEN_INVALID");
  });

  await check("an approval belonging to another user or business is refused", async () => {
    const facts = {
      domain: "historical-documents" as const,
      contentHash: "c".repeat(64),
      sheetName: null,
      mappingHash: "m".repeat(64),
      dateFormat: null,
      analysisHash: "a".repeat(64),
      rowCount: 1,
      decisionsHash: "d".repeat(64),
      evidenceFingerprint: "e".repeat(64),
    };
    const otherUser = issueHistoricalPreviewToken({ ...facts, businessId: 7, userId: 12 });
    const otherBusiness = issueHistoricalPreviewToken({ ...facts, businessId: 8, userId: 11 });
    for (const token of [otherUser, otherBusiness]) {
      const result = await executeHistoricalImport({ ...baseInput, previewToken: token });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, "TOKEN_MISMATCH");
    }
  });

  await check("an expired approval is refused, and says so distinctly", async () => {
    const issued = new Date("2026-01-01T00:00:00.000Z");
    const token = issueHistoricalPreviewToken(
      {
        businessId: 7,
        userId: 11,
        domain: "historical-documents",
        contentHash: "c".repeat(64),
        sheetName: null,
        mappingHash: "m".repeat(64),
        dateFormat: null,
        analysisHash: "a".repeat(64),
        rowCount: 1,
        decisionsHash: "d".repeat(64),
        evidenceFingerprint: "e".repeat(64),
      },
      issued
    );
    const result = await executeHistoricalImport({ ...baseInput, previewToken: token });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "TOKEN_EXPIRED");
  });

  /* ============================================ 2. the run identity ===== */

  await check("the run identity covers everything that makes executions differ", () => {
    const base = {
      decisions: { 1: "CREATE" as const },
      analysisHash: "a".repeat(64),
      evidenceFingerprint: "e".repeat(64),
    };
    const original = executionContractHash(base);

    // Same file, same mapping, DIFFERENT decisions.
    assert.notEqual(
      original,
      executionContractHash({ ...base, decisions: { 1: "SKIP" } }),
      "a different decision must be a different run"
    );
    // Same decisions, different analysis — which folds in the sheet and the
    // date format, and the date format decides which month a document is in.
    assert.notEqual(
      original,
      executionContractHash({ ...base, analysisHash: "b".repeat(64) }),
      "a different analysis must be a different run"
    );
    // Same everything, different database state at approval time.
    assert.notEqual(
      original,
      executionContractHash({ ...base, evidenceFingerprint: "f".repeat(64) }),
      "a different approved world must be a different run"
    );
    // And it is stable, or replay would never resolve to the same run.
    assert.equal(original, executionContractHash({ ...base }));
    assert.equal(original.length, 64);
  });

  /* ============================================== 3. the lock =========== */

  await check("the identity lock has a namespace of its own", () => {
    assert.equal(HISTORICAL_IDENTITY_ADVISORY_NAMESPACE, 0x4846);
    // Sharing a namespace with another lock would make unrelated work wait on
    // this, and this wait on unrelated work.
    assert.notEqual(HISTORICAL_IDENTITY_ADVISORY_NAMESPACE, DOCUMENT_CONTENT_ADVISORY_NAMESPACE);
    assert.notEqual(HISTORICAL_IDENTITY_ADVISORY_NAMESPACE, ADVISORY_NAMESPACE);
  });

  await check("the lock key separates tenants and identities, and is stable", () => {
    const identity = {
      sourceSystemCode: "legacy-erp",
      documentTypeCode: "TAX_INVOICE",
      originalDocumentNumber: "INV-1",
    };
    assert.equal(historicalIdentityLockKey(1, identity), historicalIdentityLockKey(1, identity));
    assert.notEqual(
      historicalIdentityLockKey(1, identity),
      historicalIdentityLockKey(2, identity),
      "two businesses must never wait on each other"
    );
    for (const changed of [
      { ...identity, sourceSystemCode: "other" },
      { ...identity, documentTypeCode: "RECEIPT" },
      { ...identity, originalDocumentNumber: "INV-2" },
    ]) {
      assert.notEqual(
        historicalIdentityLockKey(1, identity),
        historicalIdentityLockKey(1, changed),
        JSON.stringify(changed)
      );
    }
    // Signed 32-bit, which is what pg_advisory_xact_lock(int, int) takes.
    const key = historicalIdentityLockKey(1, identity);
    assert.ok(Number.isInteger(key) && key >= -(2 ** 31) && key < 2 ** 31);
  });

  await check("it is a TRANSACTION lock, so a rollback cannot leak it", () => {
    const code = codeOf(LOCK);
    assert.ok(code.includes("pg_advisory_xact_lock"));
    assert.ok(!code.includes("pg_advisory_lock("), "a session lock would leak");
    // And it is taken with the caller's transaction, never its own.
    assert.match(code, /lockHistoricalIdentity\(\s*\n?\s*tx: TenantTx/);
  });

  /* ======================================= 4. the write surface ========= */

  await check("Execute writes exactly two tables and no others", () => {
    const code = codeOf(EXECUTE);
    const writes = [...code.matchAll(/\b(\w+)\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/g)]
      .map((m) => `${m[1]}.${m[2]}`)
      .filter((call) => !call.startsWith("createHash"));
    // `historicalFiscalDocument.create` here; the ledger is written through the
    // store, which the tabular import already owns and this reuses.
    assert.deepEqual([...new Set(writes)].sort(), ["historicalFiscalDocument.create"], JSON.stringify(writes));
  });

  await check("the historical record is never updated or deleted", () => {
    for (const file of [EXECUTE, ROUTE]) {
      const code = codeOf(file);
      for (const forbidden of [
        "historicalFiscalDocument.update",
        "historicalFiscalDocument.updateMany",
        "historicalFiscalDocument.delete",
        "historicalFiscalDocument.deleteMany",
        "historicalFiscalDocument.upsert",
      ]) {
        assert.ok(!code.includes(forbidden), `${file} must not contain ${forbidden}`);
      }
    }
  });

  await check("nothing on the path reaches billing, payments or a customer", () => {
    for (const file of [EXECUTE, ROUTE, LOCK]) {
      const code = codeOf(file);
      for (const forbidden of [
        "billingDocument",
        "BillingDocument",
        "financialEvent",
        "FinancialEvent",
        "billingDocumentNumberSequence",
        "allocationNumber",
        "AuthoritySubmission",
        "uniform",
        "paymentRequest",
        "customer.create",
        "customer.update",
        "customer.upsert",
        "customer.findFirst",
        "document.create",
        "ISSUED",
      ]) {
        assert.ok(!code.includes(forbidden), `${file} must not reach ${forbidden}`);
      }
    }
  });

  await check("money and dates cross into the database through the audited helpers", () => {
    const code = codeOf(EXECUTE);
    assert.ok(code.includes("fiscalAmountToDecimal"), "money must go through the Decimal helper");
    assert.ok(code.includes("fiscalDateToUtcDate"), "the date must go through the UTC boundary");
    // Never a JavaScript number on the way in.
    assert.ok(!/Number\(\s*value/.test(code));
    assert.ok(!code.includes("parseFloat"));
    assert.ok(!code.includes("toFixed"));
  });

  /* ======================================= 5. the ledger contract ======= */

  await check("the ledger is the existing one, reused rather than reinvented", () => {
    const code = codeOf(EXECUTE);
    for (const reused of [
      "openOrResumeRun",
      "loadExecutedRowNumbers",
      "markRow",
      "markSkippedRow",
      "markFailedRow",
      "terminalizeRun",
      "countRunRowsByStatus",
    ]) {
      assert.ok(code.includes(reused), `Execute must reuse ${reused}`);
    }
    assert.ok(code.includes('domain: "historical-documents"'), "the run must name this domain");
    // And it must not quietly borrow another domain's identity.
    for (const other of ['"issued-documents"', '"documents"', '"customers"']) {
      assert.ok(!code.includes(`domain: ${other}`), `must not run under ${other}`);
    }
  });

  await check("no value from the file can reach the ledger", () => {
    const code = codeOf(EXECUTE);
    // Every marker written here carries an id, an enum and at most a short
    // structural code. Nothing else is passed to the store.
    const markerCalls = [...code.matchAll(/mark(?:Row|SkippedRow|FailedRow)\([\s\S]{0,400}?\}\)/g)].map(
      (m) => m[0]
    );
    assert.ok(markerCalls.length >= 3, "the three marker paths must all be present");
    for (const call of markerCalls) {
      for (const forbidden of ["valueOf(", "row.values", "customerName", "originalDocumentNumber", "totalAmount"]) {
        assert.ok(!call.includes(forbidden), `a marker carried ${forbidden}`);
      }
    }
  });

  /* ======================================= 6. what it refuses to trust == */

  await check("the tenant and the user come from the session, never the request", () => {
    const route = codeOf(ROUTE);
    assert.ok(route.includes("getCurrentUser(req)"));
    assert.ok(route.includes("user.businessId") && route.includes("user.id"));
    assert.ok(!route.includes('form.get("businessId")'));
    assert.ok(!route.includes('form.get("userId")'));
    assert.ok(!/businessId:\s*(form|body|params)/.test(route));
  });

  await check("no analysis result is read out of the request", () => {
    const route = codeOf(ROUTE);
    for (const forbidden of [
      'form.get("duplicate")',
      'form.get("reversal")',
      'form.get("rows")',
      'form.get("targetId")',
      'form.get("evidence")',
    ]) {
      assert.ok(!route.includes(forbidden), `the route must not read ${forbidden}`);
    }
    // Everything is re-derived by building the preview again.
    assert.ok(codeOf(EXECUTE).includes("buildHistoricalPreview"));
  });

  await check("every approved fact is compared before a row is written", () => {
    const code = codeOf(EXECUTE);
    for (const bound of [
      "facts.contentHash",
      "facts.sheetName",
      "facts.dateFormat",
      "facts.decisionsHash",
      "facts.rowCount",
      "facts.evidenceFingerprint",
      "facts.businessId",
      "facts.userId",
      "facts.domain",
    ]) {
      assert.ok(code.includes(bound), `${bound} must be checked`);
    }
    // And the comparisons all happen before the run is opened. Compared against
    // the CALL, not the import, which naturally appears first in the file.
    // Readiness is re-derived too. Preview refusing to sign is the gate; this
    // is the backstop, and a token minted by an older build cannot walk past it.
    assert.ok(
      code.includes("!preview.readyForExecute"),
      "execution must refuse a preview that is not ready"
    );
    const staleness = code.indexOf("preview.evidenceFingerprint !== facts.evidenceFingerprint");
    const opensRun = code.indexOf("await openOrResumeRun({");
    assert.ok(staleness > 0 && opensRun > 0, "both sites must be present");
    assert.ok(
      staleness < opensRun,
      "staleness must be checked before the ledger is touched"
    );
  });

  await check("a reversal is bound at INSERT, and there is nowhere else to bind it", () => {
    const code = codeOf(EXECUTE);
    // The column has no UPDATE path, so the link is written with the row or
    // never. If this line moved out of the create block, the only way to bind a
    // credit would be a second statement — which the write surface forbids.
    const binding = code.indexOf("reversesHistoricalDocumentId: reversal,");
    const opensCreate = code.indexOf("await tx.historicalFiscalDocument.create({");
    const closesCreate = code.indexOf("select: { id: true },", opensCreate);
    assert.ok(binding > 0, "the reversal must be bound");
    assert.ok(opensCreate > 0 && closesCreate > opensCreate, "the insert must be present");
    assert.ok(
      binding > opensCreate && binding < closesCreate,
      "the reversal must be bound inside the insert, not afterwards"
    );
    // And it is resolved before the insert, from the database, under the lock.
    assert.ok(code.indexOf("await resolveReversalTarget(tx,") < opensCreate);
  });

  await check("every historical statement runs inside the tenant transaction", () => {
    const code = codeOf(EXECUTE);
    const accesses = [...code.matchAll(/(\w+)\.historicalFiscalDocument\./g)].map((m) => m[1]);
    assert.ok(accesses.length >= 3, "the reads and the insert must all be present");
    assert.deepEqual([...new Set(accesses)], ["tx"], JSON.stringify(accesses));
    // The global client sets no `app.current_business_id`, and under the
    // restricted runtime that reads as "this tenant has no data" rather than
    // as an error. So it must not be reachable from here at all.
    assert.ok(!/\bprisma\s*\./.test(code), "the global client must not appear");
    assert.ok(code.includes("runWithTenantContext"));
    assert.ok(code.includes("withTenantTransaction"));
  });

  /* ======================================= 7. capability ================ */

  await check("the historical capability is now three routes, and still isolated", () => {
    for (const route of ["analyze", "preview", "execute"]) {
      assert.ok(
        fs.existsSync(`app/api/data-transfer/import/historical/${route}/route.ts`),
        `${route} must exist`
      );
    }
    // The generic gate the six tabular domains share is untouched, so nothing
    // was granted wholesale.
    const registry = fs.readFileSync("lib/data-transfer/export/export-registry.ts", "utf8");
    assert.ok(!registry.includes("historical"));
    const writers = fs.readFileSync(
      "lib/data-transfer/import/execute/domain-writers.ts",
      "utf8"
    );
    assert.ok(!writers.includes("historical"), "no historical writer in the generic registry");
  });

  console.log(`\n  ${passed} checks passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    failures.forEach((f) => console.log(`  FAILED: ${f}`));
    process.exitCode = 1;
  }
}

void main();
