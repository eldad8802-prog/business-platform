/**
 * Import execution CONTRACT — deterministic verifier.
 *
 * This file pins the four decisions that had to be settled before any mutation
 * code was written:
 *
 *   1. the domain-specific duplicate defaults (never a blanket "duplicate -> skip")
 *   2. in-file collision semantics (deterministic, and never "skip both")
 *   3. which failures leave an immutable marker and which stay retryable
 *   4. batch rollback / partial-success semantics
 *
 * NO database and NO network. What it asserts is policy, and policy is pure.
 * The PostgreSQL behaviour that motivates (4) was measured separately against
 * the project's own database — see the header of `execution-semantics.ts`.
 *
 * Run: npx tsx lib/data-transfer/import/execute/execute-contract.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { Prisma } from "@prisma/client";
import type { DuplicateEvidence } from "@/lib/data-transfer/import/duplicates/duplicate-detect";
import {
  isBlockingEvidence,
  isOverridableEvidence,
  verdictFor,
} from "@/lib/data-transfer/import/execute/duplicate-policy";
import {
  defaultActionFor,
  defaultDecisions,
  inFileEligibleRows,
  mayOverrideToCreate,
  resolveDecisions,
  validateDecisions,
} from "@/lib/data-transfer/import/execute/row-decisions";
import {
  classifyRowFailure,
  planBatches,
  rowsStillToExecute,
  terminalStatusFor,
} from "@/lib/data-transfer/import/execute/execution-semantics";
import { IMPORT_EXECUTE_BATCH_SIZE } from "@/lib/data-transfer/import/import-config";
import type { PreviewRow } from "@/lib/data-transfer/import/preview/preview-orchestrator";

let passed = 0;

function check(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

/* --------------------------------------------------------------- helpers */

function existing(
  field: string,
  strength: "STRONG" | "WEAK" = "STRONG",
  note?: string
): DuplicateEvidence {
  return { scope: "EXISTING", field, strength, value: "v", existingNote: note };
}

function inFile(
  field: string,
  value: string,
  otherRows: number[]
): DuplicateEvidence {
  return { scope: "IN_FILE", field, strength: "STRONG", value, otherRows };
}

function row(
  rowNumber: number,
  duplicates: DuplicateEvidence[],
  status: PreviewRow["status"] = "READY"
): PreviewRow {
  return { rowNumber, status, errors: [], changes: [], duplicates };
}

/* ============================================================ 1. defaults */

console.log("\n1. Domain-specific duplicate defaults");

check("customers: an existing phone blocks", () => {
  assert.equal(isBlockingEvidence("customers", existing("טלפון")), true);
});

check("customers: an existing email does NOT block", () => {
  assert.equal(isBlockingEvidence("customers", existing("אימייל", "WEAK")), false);
});

check("suppliers: an exact tax id blocks", () => {
  assert.equal(
    isBlockingEvidence("suppliers", existing("מספר עוסק / ח.פ.", "WEAK")),
    true
  );
});

check("suppliers: a matching NAME does not block", () => {
  assert.equal(isBlockingEvidence("suppliers", existing("שם ספק", "WEAK")), false);
});

check("suppliers: a matching phone does not block", () => {
  assert.equal(isBlockingEvidence("suppliers", existing("טלפון", "WEAK")), false);
});

check("leads: an OPEN lead on the same phone blocks", () => {
  assert.equal(isBlockingEvidence("leads", existing("טלפון", "STRONG")), true);
});

check("leads: a CLOSED lead on the same phone does NOT block", () => {
  // The detector reports a closed lead as WEAK precisely because the partial
  // unique index excludes it. A returning customer is a legitimate new lead.
  assert.equal(isBlockingEvidence("leads", existing("טלפון", "WEAK")), false);
});

check("inventory: an existing SKU blocks", () => {
  assert.equal(isBlockingEvidence("inventory", existing("מק״ט", "WEAK")), true);
});

check("inventory: an existing barcode blocks", () => {
  assert.equal(isBlockingEvidence("inventory", existing("ברקוד", "WEAK")), true);
});

check("inventory: a matching item NAME does not block", () => {
  assert.equal(isBlockingEvidence("inventory", existing("שם פריט", "WEAK")), false);
});

check("NOT a blanket rule: non-blocking evidence still defaults to CREATE", () => {
  const r = row(1, [existing("שם ספק", "WEAK")]);
  assert.equal(defaultActionFor("suppliers", r, new Set()), "CREATE");
});

check("an ERROR row defaults to SKIP whatever its duplicates say", () => {
  assert.equal(defaultActionFor("customers", row(1, [], "ERROR"), new Set()), "SKIP");
});

check("a blocking match defaults to SKIP", () => {
  assert.equal(
    defaultActionFor("customers", row(1, [existing("טלפון")]), new Set()),
    "SKIP"
  );
});

/* ------------------------------------------------------------- overrides */

console.log("\n1b. Override surface");

check("supplier tax id is overridable to CREATE", () => {
  const r = row(1, [existing("מספר עוסק / ח.פ.", "WEAK")]);
  assert.equal(verdictFor("suppliers", r.duplicates).blocking, true);
  assert.equal(mayOverrideToCreate("suppliers", r, new Set()), true);
});

check("customer phone is NOT overridable", () => {
  assert.equal(
    mayOverrideToCreate("customers", row(1, [existing("טלפון")]), new Set()),
    false
  );
});

check("inventory SKU is NOT overridable", () => {
  assert.equal(
    mayOverrideToCreate("inventory", row(1, [existing("מק״ט", "WEAK")]), new Set()),
    false
  );
});

check("an ERROR row is never overridable", () => {
  assert.equal(
    mayOverrideToCreate("customers", row(1, [], "ERROR"), new Set()),
    false
  );
});

check("one non-overridable reason keeps the whole row blocked", () => {
  // A permitted supplier override must not smuggle a second, unrelated block past.
  const evidence = [
    existing("מספר עוסק / ח.פ.", "WEAK"),
    inFile("טלפון", "0501234567", [7]),
  ];
  const verdict = verdictFor("suppliers", evidence);
  assert.equal(verdict.blocking, true);
  assert.equal(verdict.overridable, false);
});

check("in-file evidence is never overridable on its own", () => {
  assert.equal(
    isOverridableEvidence("suppliers", inFile("טלפון", "05", [2])),
    false
  );
});

check("a blocked CREATE is rejected by validateDecisions", () => {
  const rows = [row(1, [existing("טלפון")])];
  const problems = validateDecisions({
    domainId: "customers",
    rows,
    decisions: { 1: "CREATE" },
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].code, "NOT_PERMITTED");
});

check("a permitted supplier CREATE passes validateDecisions", () => {
  const rows = [row(1, [existing("מספר עוסק / ח.פ.", "WEAK")])];
  assert.deepEqual(
    validateDecisions({ domainId: "suppliers", rows, decisions: { 1: "CREATE" } }),
    []
  );
});

check("SKIP is always permitted", () => {
  const rows = [row(1, [], "ERROR")];
  assert.deepEqual(
    validateDecisions({ domainId: "customers", rows, decisions: { 1: "SKIP" } }),
    []
  );
});

check("a decision for a row that is not in the file is rejected", () => {
  const problems = validateDecisions({
    domainId: "customers",
    rows: [row(1, [])],
    decisions: { 99: "CREATE" },
  });
  assert.equal(problems[0].code, "UNKNOWN_ROW");
});

/* ====================================================== 2. IN_FILE groups */

console.log("\n2. In-file collision semantics");

check("two rows sharing a phone: the FIRST is eligible, not neither", () => {
  const rows = [
    row(3, [inFile("טלפון", "0501111111", [8])]),
    row(8, [inFile("טלפון", "0501111111", [3])]),
  ];
  const eligible = inFileEligibleRows(rows);
  assert.equal(eligible.has(3), true);
  assert.equal(eligible.has(8), false);
});

check("the winner imports and the loser skips — never both skipped", () => {
  const rows = [
    row(3, [inFile("טלפון", "0501111111", [8])]),
    row(8, [inFile("טלפון", "0501111111", [3])]),
  ];
  const decisions = defaultDecisions("customers", rows);
  assert.deepEqual(decisions, { 3: "CREATE", 8: "SKIP" });
});

check("first-by-source-row-number, regardless of the order rows arrive in", () => {
  const forwards = inFileEligibleRows([
    row(2, [inFile("מק״ט", "A1", [9])]),
    row(9, [inFile("מק״ט", "A1", [2])]),
  ]);
  const backwards = inFileEligibleRows([
    row(9, [inFile("מק״ט", "A1", [2])]),
    row(2, [inFile("מק״ט", "A1", [9])]),
  ]);
  assert.deepEqual([...forwards], [2]);
  assert.deepEqual([...backwards], [2]);
});

check("three rows in one group: exactly one is eligible", () => {
  const rows = [4, 5, 6].map((n) =>
    row(n, [inFile("טלפון", "0502222222", [4, 5, 6].filter((o) => o !== n))])
  );
  assert.deepEqual([...inFileEligibleRows(rows)], [4]);
});

check("different values form different groups, each with its own winner", () => {
  const rows = [
    row(1, [inFile("טלפון", "050A", [2])]),
    row(2, [inFile("טלפון", "050A", [1])]),
    row(3, [inFile("טלפון", "050B", [4])]),
    row(4, [inFile("טלפון", "050B", [3])]),
  ];
  assert.deepEqual([...inFileEligibleRows(rows)].sort((a, b) => a - b), [1, 3]);
});

check("a row must win EVERY group it belongs to", () => {
  // Row 2 is first on barcode but loses on SKU, so it is not eligible.
  const rows = [
    row(1, [inFile("מק״ט", "S1", [2])]),
    row(2, [inFile("מק״ט", "S1", [1]), inFile("ברקוד", "B1", [3])]),
    row(3, [inFile("ברקוד", "B1", [2])]),
  ];
  const eligible = inFileEligibleRows(rows);
  assert.equal(eligible.has(1), true);
  assert.equal(eligible.has(2), false);
  assert.equal(eligible.has(3), false);
});

check("the in-file winner still obeys its EXISTING evidence", () => {
  // Winning the in-file group does not license creating over a real customer.
  const rows = [
    row(1, [inFile("טלפון", "050A", [2]), existing("טלפון")]),
    row(2, [inFile("טלפון", "050A", [1])]),
  ];
  assert.deepEqual(defaultDecisions("customers", rows), { 1: "SKIP", 2: "SKIP" });
});

check("the same file always resolves the same way (stable across a retry)", () => {
  const build = () => [
    row(5, [inFile("טלפון", "050X", [1, 9])]),
    row(1, [inFile("טלפון", "050X", [5, 9])]),
    row(9, [inFile("טלפון", "050X", [1, 5])]),
  ];
  assert.deepEqual(
    defaultDecisions("customers", build()),
    defaultDecisions("customers", build())
  );
});

check("resolveDecisions keeps the default for a row the client never sent", () => {
  const rows = [row(1, []), row(2, [existing("טלפון")])];
  assert.deepEqual(resolveDecisions("customers", rows, { 1: "SKIP" }), {
    1: "SKIP",
    2: "SKIP",
  });
});

check("resolveDecisions ignores a row number that is not in the file", () => {
  const resolved = resolveDecisions("customers", [row(1, [])], { 42: "CREATE" });
  assert.deepEqual(resolved, { 1: "CREATE" });
});

/* ================================================== 3. failure / retry */

console.log("\n3. Failure classification and retry mechanics");

/** The real Prisma error class, so `instanceof` is genuinely exercised. */
function prismaError(code: string) {
  return new Prisma.PrismaClientKnownRequestError("db said no", {
    code,
    clientVersion: "test",
  });
}

check("P2002 is DETERMINISTIC and reported as a changed duplicate", () => {
  const c = classifyRowFailure(prismaError("P2002"));
  assert.equal(c.kind, "DETERMINISTIC");
  assert.equal(c.code, "DUPLICATE_CHANGED");
});

check("a constraint failure (P2003) is DETERMINISTIC", () => {
  const c = classifyRowFailure(prismaError("P2003"));
  assert.equal(c.kind, "DETERMINISTIC");
  assert.equal(c.code, "CONFLICT");
});

check("a pool timeout (P2024) is TRANSIENT", () => {
  assert.equal(classifyRowFailure(prismaError("P2024")).kind, "TRANSIENT");
});

check("a write conflict / deadlock (P2034) is TRANSIENT", () => {
  assert.equal(classifyRowFailure(prismaError("P2034")).kind, "TRANSIENT");
});

check("a lost connection (P1001) is TRANSIENT", () => {
  assert.equal(classifyRowFailure(prismaError("P1001")).kind, "TRANSIENT");
});

check("a domain ValidationError is DETERMINISTIC", () => {
  const e = new Error("bad name");
  e.name = "CustomerValidationError";
  const c = classifyRowFailure(e);
  assert.equal(c.kind, "DETERMINISTIC");
  assert.equal(c.code, "VALIDATION_ERROR");
});

check("the inventory unit TypeError is DETERMINISTIC", () => {
  // inventory-core throws a raw TypeError; legacy behaviour, deliberately kept.
  assert.equal(classifyRowFailure(new TypeError("nope")).kind, "DETERMINISTIC");
});

check("an unknown failure is TRANSIENT, so the row stays retryable", () => {
  const c = classifyRowFailure(new Error("who knows"));
  assert.equal(c.kind, "TRANSIENT");
  assert.equal(c.code, "SERVICE_ERROR");
});

check("failure codes never carry a value from the file", () => {
  const secret = "0501234567";
  const e = new Error(`duplicate phone ${secret}`);
  e.name = "CustomerValidationError";
  const c = classifyRowFailure(e);
  assert.equal(c.message.includes(secret), false);
  assert.equal(c.code.includes(secret), false);
});

check("a TRANSIENT row is retried because it left no marker", () => {
  const rows = [{ rowNumber: 1 }, { rowNumber: 2 }, { rowNumber: 3 }];
  // Rows 1 and 2 committed markers; row 3 died transiently and wrote none.
  assert.deepEqual(rowsStillToExecute(rows, new Set([1, 2])), [{ rowNumber: 3 }]);
});

check("a marked row is never re-executed — no UPDATE, no PK collision", () => {
  const rows = [{ rowNumber: 1 }, { rowNumber: 2 }];
  assert.deepEqual(rowsStillToExecute(rows, new Set([1, 2])), []);
});

/* ====================================== 4. batch / partial-success */

console.log("\n4. Batch and terminal status semantics");

check("batches are file-ordered and sized by the configured constant", () => {
  const rows = Array.from({ length: 450 }, (_, i) => i + 1);
  const batches = planBatches(rows, IMPORT_EXECUTE_BATCH_SIZE);
  assert.equal(batches.length, 3);
  assert.equal(batches[0].length, IMPORT_EXECUTE_BATCH_SIZE);
  assert.equal(batches[2].length, 450 - 2 * IMPORT_EXECUTE_BATCH_SIZE);
  assert.deepEqual(batches.flat(), rows);
});

check("an empty run plans no batches at all", () => {
  assert.deepEqual(planBatches([], 200), []);
});

check("tier 2 re-runs a failed batch one row per transaction", () => {
  const batch = [1, 2, 3];
  assert.deepEqual(planBatches(batch, 1), [[1], [2], [3]]);
});

check("nothing failed -> COMPLETED", () => {
  assert.equal(
    terminalStatusFor({ createdCount: 10, skippedCount: 2, failedCount: 0 }),
    "COMPLETED"
  );
});

check("everything skipped by choice is COMPLETED, not FAILED", () => {
  assert.equal(
    terminalStatusFor({ createdCount: 0, skippedCount: 12, failedCount: 0 }),
    "COMPLETED"
  );
});

check("some created and some failed -> PARTIAL", () => {
  assert.equal(
    terminalStatusFor({ createdCount: 8, skippedCount: 0, failedCount: 2 }),
    "PARTIAL"
  );
});

check("nothing created and something failed -> FAILED", () => {
  assert.equal(
    terminalStatusFor({ createdCount: 0, skippedCount: 3, failedCount: 2 }),
    "FAILED"
  );
});

/* =============================================== structural guards */

console.log("\n5. Structural guards");

const semanticsSrc = fs.readFileSync(
  "lib/data-transfer/import/execute/execution-semantics.ts",
  "utf8"
);
const decisionsSrc = fs.readFileSync(
  "lib/data-transfer/import/execute/row-decisions.ts",
  "utf8"
);
const migrationSrc = fs.readFileSync(
  "prisma/migrations/20260903090000_import_run_execution_ledger/migration.sql",
  "utf8"
);

/** Comments describe the constructs they forbid, so strip them before scanning. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

check("the stripper self-test removes a commented-out construct", () => {
  assert.equal(stripComments("// SAVEPOINT sp1\nconst a = 1;").includes("SAVEPOINT"), false);
  assert.equal(stripComments("const a = 1; /* SAVEPOINT */").includes("SAVEPOINT"), false);
  assert.equal(stripComments("const s = 'SAVEPOINT';").includes("SAVEPOINT"), true);
});

check("no SAVEPOINT is actually emitted — the measured option we rejected", () => {
  assert.equal(/SAVEPOINT/i.test(stripComments(semanticsSrc)), false);
});

check("the decision layer holds no blanket duplicate rule of its own", () => {
  const code = stripComments(decisionsSrc);
  assert.equal(/duplicates\.length\s*>\s*0/.test(code), false);
  assert.equal(code.includes("verdictFor"), true);
});

check("the row marker table has no UPDATE policy", () => {
  const sql = migrationSrc.replace(/^--[^\n]*$/gm, "");
  assert.equal(/POLICY[^\n]*ON "ImportRunRow" FOR UPDATE/i.test(sql), false);
  assert.equal(/POLICY[^\n]*ON "ImportRunRow" FOR INSERT/i.test(sql), true);
});

check("the runtime role is granted no UPDATE on the row marker table", () => {
  const grant = migrationSrc.match(
    /GRANT ([A-Z, ]+) ON "ImportRunRow" TO app_runtime/
  );
  assert.notEqual(grant, null);
  assert.equal(grant![1].includes("UPDATE"), false);
});

check("the run identity index still binds businessId", () => {
  assert.equal(
    /CREATE UNIQUE INDEX[\s\S]*?ON "ImportRun"\("businessId", "contentHash", "mappingHash", "decisionsHash"\)/.test(
      migrationSrc
    ),
    true
  );
});

/* ============================ 6. retry ordering (regression) ========== */

console.log("\n6. Retry ordering");

const executorSrc = fs.readFileSync(
  "lib/data-transfer/import/execute/import-executor.ts",
  "utf8"
);

check("REGRESSION: an existing run is resolved BEFORE decisions are re-validated", () => {
  // The defect this pins was found by running against a real database. Execute
  // validated the owner's decisions first, against freshly derived rows — so a
  // RETRY was judged against a world the run itself had changed. The second
  // attempt at an inventory import was refused with "you may not create a row
  // whose SKU already exists", about the row it had just created. A lost
  // response therefore became an import the owner could neither confirm nor
  // repeat: the UI told them to re-run the check, and the check then showed
  // every row as a duplicate.
  //
  // Suppliers hid it, because a supplier tax-id match IS overridable and so
  // still validated. Only inventory, whose SKU match is not overridable,
  // exposed it.
  const code = stripComments(executorSrc);
  const lookup = code.indexOf("findExistingRun(");
  const validate = code.indexOf("validateDecisions(");
  assert.notEqual(lookup, -1, "execute must look the run up");
  assert.notEqual(validate, -1, "execute must still validate decisions");
  assert.equal(
    lookup < validate,
    true,
    "the run must be resolved before decisions are re-validated"
  );
});

check("a decision set that was never validated cannot create a run", () => {
  // The other half of the ordering. Looking the run up first is only safe if
  // creating one still requires passing validation — otherwise an invalid set
  // would leave a run behind, and the next attempt would find it and skip
  // validation entirely.
  const code = stripComments(executorSrc);
  const validate = code.indexOf("validateDecisions(");
  const open = code.indexOf("openOrResumeRun(");
  assert.notEqual(open, -1);
  assert.equal(
    validate < open,
    true,
    "validation must still precede creating the run"
  );
});

check("the read-only lookup never creates", () => {
  const store = stripComments(
    fs.readFileSync(
      "lib/data-transfer/import/execute/import-run-store.ts",
      "utf8"
    )
  );
  const fn = store.slice(store.indexOf("export async function findExistingRun"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.equal(
    body.includes("importRun.create"),
    false,
    "findExistingRun must not create a run"
  );
  assert.equal(body.includes("findUnique"), true);
});

check("REGRESSION: terminalization counts markers in the DB, never in memory", () => {
  // Found against a real database: counting by loading every marker blew
  // Prisma's 5s interactive-transaction budget and aborted terminalization at
  // the very last step — after every record had already been written. The run
  // would have been left EXECUTING with all of its work done, and the owner
  // told the import had not finished.
  //
  // At the 10,000-row ceiling that read moves 10,000 rows to produce three
  // integers. The aggregate moves three.
  const store = stripComments(
    fs.readFileSync(
      "lib/data-transfer/import/execute/import-run-store.ts",
      "utf8"
    )
  );
  assert.equal(store.includes("groupBy"), true, "the tally must aggregate");
  assert.equal(
    /findMany\(\{\s*where:\s*\{\s*importRunId\s*\}\s*,\s*select:\s*\{\s*sourceRowNumber:\s*true,\s*action/.test(
      store
    ),
    false,
    "no reader may pull every marker just to count or filter them"
  );

  // The failure list is fetched as failures, not filtered from everything.
  assert.equal(store.includes('status: "FAILED"'), true);

  const exec = stripComments(executorSrc);
  assert.equal(
    exec.includes("countRunRowsByStatus"),
    true,
    "the executor must use the aggregate"
  );
  assert.equal(
    exec.includes("loadRunRows"),
    false,
    "the load-everything reader must be gone, not merely unused"
  );
});

check("the batch transaction carries an explicit budget, not Prisma's 5s default", () => {
  // 200 rows, each a marker insert plus a domain-service create — and an
  // inventory row also writes a stock movement. Against a serverless database
  // that is more than five seconds of round trips, and the default was seen
  // being exceeded on a real one. Correctness never depended on it (the batch
  // rolls back whole and every row is retried alone) but a normal import would
  // take the expensive path for no reason and look like a failing one.
  const exec = stripComments(executorSrc);
  assert.equal(exec.includes("IMPORT_EXECUTE_BATCH_TIMEOUT_MS"), true);
  const batchStart = exec.indexOf("async function tryBatch");
  const batchEnd = exec.indexOf("async function runSingleRow");
  assert.equal(batchStart !== -1 && batchEnd > batchStart, true);
  const batchBody = exec.slice(batchStart, batchEnd);
  assert.equal(
    batchBody.includes("timeoutMs: IMPORT_EXECUTE_BATCH_TIMEOUT_MS"),
    true,
    "the budget must be applied to the BATCH transaction"
  );
  // The single-row retries keep the default: they do one row of work, and a
  // long budget there would hold a connection open for no reason.
  assert.equal(exec.split("timeoutMs").length - 1, 1);
});

console.log(`\nIMPORT EXECUTE CONTRACT VERIFY PASS — ${passed} checks green.`);
