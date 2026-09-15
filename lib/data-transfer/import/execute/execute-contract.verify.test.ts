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
import { retryKeyOf } from "@/lib/data-transfer/import/execute/import-run-store";
import {
  attestOverrideAction,
  attestedOverrideActionHash,
} from "@/lib/data-transfer/import/execute/override-action";
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

/* ============================ 7. F-01 retry identity ================== */

console.log("\n7. F-01 — retry identity excludes mutable state");

const storeSrc = fs.readFileSync(
  "lib/data-transfer/import/execute/import-run-store.ts",
  "utf8"
);

check("F-01: the retry key is stable, and moves only with its three inputs", () => {
  const base = { businessId: 7, contentHash: "aa", mappingHash: "bb" };
  assert.equal(retryKeyOf(base), retryKeyOf({ ...base }));
  assert.notEqual(retryKeyOf(base), retryKeyOf({ ...base, businessId: 8 }));
  assert.notEqual(retryKeyOf(base), retryKeyOf({ ...base, contentHash: "cc" }));
  assert.notEqual(retryKeyOf(base), retryKeyOf({ ...base, mappingHash: "dd" }));
});

check("F-01: nothing the import can change reaches the retry key", () => {
  // The whole defect in one assertion. `retryKeyOf` reads three fields and the
  // decisions are not among them, so no decision set can move it. The schema's
  // old unique index did exactly what this forbids.
  const source = stripComments(storeSrc);
  const fn = source.slice(
    source.indexOf("export function retryKeyOf"),
    source.indexOf("export type RunIdentity")
  );
  assert.equal(fn.includes("decisionsHash"), false, "the key must not read decisions");
  for (const field of ["businessId", "contentHash", "mappingHash"]) {
    assert.equal(fn.includes(field), true, `the key must read ${field}`);
  }
});

check("F-01: neither ledger lookup keys on the decisions any more", () => {
  const source = stripComments(storeSrc);
  const open = source.slice(
    source.indexOf("export async function openOrResumeRun"),
    source.indexOf("type RunRecord")
  );
  const find = source.slice(source.indexOf("export async function findExistingRun"));
  for (const [name, body] of [
    ["openOrResumeRun", open],
    ["findExistingRun", find],
  ] as const) {
    assert.equal(body.includes("retryKey"), true, `${name} must resolve by retryKey`);
    assert.equal(
      body.includes("businessId_contentHash_mappingHash_decisionsHash"),
      false,
      `${name} must not use the old compound key`
    );
  }
});

check("F-01: decisionsHash is still RECORDED, it just is not identity", () => {
  // Taking it out of the key must not take away the audit trail of what the
  // owner approved.
  const source = stripComments(storeSrc);
  const create = source.slice(
    source.indexOf("tx.importRun.create"),
    source.indexOf("created: true")
  );
  assert.equal(create.includes("decisionsHash: identity.decisionsHash"), true);
  assert.equal(create.includes("retryKey"), true);
});

check("F-01: the schema's unique index is the retry key, not the decisions", () => {
  const schema = fs.readFileSync("prisma/schema.prisma", "utf8");
  const model = schema.slice(
    schema.indexOf("model ImportRun {"),
    schema.indexOf("model ImportRunRow {")
  );
  assert.equal(
    model.includes("@@unique([businessId, contentHash, mappingHash, decisionsHash])"),
    false,
    "the decisions-based unique key must be gone"
  );
  // Nullable on purpose: runs written before the migration keep NULL, PostgreSQL
  // treats NULLs as distinct, and the index therefore builds on existing data
  // whatever duplicates F-01 already left. No backfill, nothing deleted.
  assert.match(model, /retryKey\s+String\?\s+@unique/);
});

check("F-01 REGRESSION: the decision set MOVES on a real retry — the key must not", () => {
  // Section 2 calls defaultDecisions twice with the SAME rows and proves
  // determinism. That cannot catch F-01, because on a real retry the input is
  // not the same: the first import created records, so the duplicate evidence
  // differs the second time. This pins the difference the old test assumed away.
  const before = defaultDecisions("customers", [row(1, []), row(2, [])]);
  const after = defaultDecisions("customers", [
    row(1, [existing("טלפון")]), // now collides — the first import created it
    row(2, []), // keyless, still nothing to collide with
  ]);
  assert.notDeepEqual(
    before,
    after,
    "a retry is expected to decide differently; that is the premise of F-01"
  );

  // And that movement must not reach the retry identity.
  const identity = { businessId: 1, contentHash: "same", mappingHash: "same" };
  assert.equal(retryKeyOf(identity), retryKeyOf(identity));
});

/* ========================= 8. the deliberate override action ============ */

console.log("\n8. F-01 — a deliberate override is not a retry");

const BASE = { businessId: 1, contentHash: "c", mappingHash: "m" };

check("an override action changes the identity", () => {
  assert.notEqual(
    retryKeyOf(BASE),
    retryKeyOf({ ...BASE, overrideActionHash: "a1" })
  );
});

check("the SAME override action is the same identity, every time", () => {
  assert.equal(
    retryKeyOf({ ...BASE, overrideActionHash: "a1" }),
    retryKeyOf({ ...BASE, overrideActionHash: "a1" })
  );
});

check("a DIFFERENT override action is a different identity", () => {
  assert.notEqual(
    retryKeyOf({ ...BASE, overrideActionHash: "a1" }),
    retryKeyOf({ ...BASE, overrideActionHash: "a2" })
  );
});

check("no override action hashes exactly as it did before overrides existed", () => {
  // The ordinary import must not have moved. Null, undefined and empty are one
  // case, because a caller with nothing to say should not be able to say it in
  // three ways that mean three different things.
  assert.equal(retryKeyOf(BASE), retryKeyOf({ ...BASE, overrideActionHash: null }));
  assert.equal(
    retryKeyOf(BASE),
    retryKeyOf({ ...BASE, overrideActionHash: undefined })
  );
  assert.equal(retryKeyOf(BASE), retryKeyOf({ ...BASE, overrideActionHash: "" }));
});

check("an id alone is never authorization — it needs a genuine override", () => {
  // THE security property. A caller can put any id in the request; with no real
  // override to attach it to it buys nothing, and replay stays replay.
  assert.equal(
    attestedOverrideActionHash({
      overrideActionId: "a".repeat(32),
      hasGenuineOverride: false,
    }),
    null
  );
  assert.notEqual(
    attestedOverrideActionHash({
      overrideActionId: "a".repeat(32),
      hasGenuineOverride: true,
    }),
    null
  );
});

check("a malformed id earns nothing even where an override IS genuine", () => {
  for (const bad of [null, undefined, 42, "short", "a".repeat(200), "has space", {}]) {
    assert.equal(
      attestedOverrideActionHash({ overrideActionId: bad, hasGenuineOverride: true }),
      null,
      `accepted ${JSON.stringify(bad)}`
    );
  }
});

check("the raw id never reaches the token — only a hash of it", () => {
  // A signed envelope is signed, not encrypted. Anyone holding one can read the
  // payload, so a client-supplied string must never be written into it verbatim.
  const id = "b".repeat(32);
  const hash = attestedOverrideActionHash({
    overrideActionId: id,
    hasGenuineOverride: true,
  });
  assert.ok(hash);
  assert.equal(hash.includes(id), false);
  assert.match(hash, /^[0-9a-f]{64}$/);
});

check("a genuine override with NO action id is REFUSED, not downgraded", () => {
  // THE silent-failure check. Falling through to "no component" would resolve
  // the owner's explicit "add it anyway" to the run that already exists and
  // drop their decision without a word — the exact defect class F-01 is.
  const refused = attestOverrideAction({
    overrideActionId: null,
    hasGenuineOverride: true,
  });
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.code, "OVERRIDE_ACTION_REQUIRED");
    assert.ok(refused.message.length > 0);
  }
});

check("a genuine override with a MALFORMED action id is refused the same way", () => {
  for (const bad of [undefined, "", "short", "has space", 42, {}]) {
    const refused = attestOverrideAction({
      overrideActionId: bad,
      hasGenuineOverride: true,
    });
    assert.equal(refused.ok, false, `accepted ${JSON.stringify(bad)}`);
  }
});

check("an ordinary import is NEVER asked for an action id", () => {
  // Backward compatibility, stated as a test: only an override is held to the
  // contract. An import with nothing to override carries on as it always has.
  const plain = attestOverrideAction({
    overrideActionId: null,
    hasGenuineOverride: false,
  });
  assert.equal(plain.ok, true);
  if (plain.ok) assert.equal(plain.overrideActionHash, null);
});

check("an ordinary import cannot buy identity with an id either", () => {
  const withId = attestOverrideAction({
    overrideActionId: "a".repeat(32),
    hasGenuineOverride: false,
  });
  assert.equal(withId.ok, true);
  if (withId.ok) assert.equal(withId.overrideActionHash, null);
});

check("every preview path REFUSES rather than falling through", () => {
  for (const [file, label] of [
    ["lib/data-transfer/import/preview/preview-orchestrator.ts", "tabular"],
    ["lib/data-transfer/historical/historical-preview.ts", "historical"],
    ["app/api/data-transfer/documents/analyze/route.ts", "documents"],
  ] as const) {
    const code = fs.readFileSync(file, "utf8");
    assert.match(
      code,
      /attestOverrideAction\(\{/,
      `${label} must use the refusing attestation`
    );
    assert.match(
      code,
      /if \(!attestation\.ok\)/,
      `${label} must act on the refusal rather than ignoring it`
    );
    // The silent fallback, in every shape it could come back in.
    assert.equal(
      /attestedOverrideActionHash\(/.test(code),
      false,
      `${label} must not use the non-refusing helper`
    );
  }
});

check("the override component is read from the TOKEN, never the request body", () => {
  for (const [file, label] of [
    ["lib/data-transfer/import/execute/import-executor.ts", "tabular"],
    ["lib/data-transfer/documents/documents-execute.ts", "documents"],
    ["lib/data-transfer/historical/historical-execute.ts", "historical"],
  ] as const) {
    const code = fs.readFileSync(file, "utf8");
    assert.match(
      code,
      /overrideActionHash[^\n]*facts\.overrideActionHash/,
      `${label} must take the override action from the verified token`
    );
    assert.equal(
      /overrideActionHash:\s*input\./.test(code),
      false,
      `${label} must not take the override action from the request`
    );
  }
});

check("every importer attests the override server-side, at preview", () => {
  for (const [file, label] of [
    ["lib/data-transfer/import/preview/preview-orchestrator.ts", "tabular"],
    ["lib/data-transfer/historical/historical-preview.ts", "historical"],
    ["app/api/data-transfer/documents/analyze/route.ts", "documents"],
  ] as const) {
    const code = fs.readFileSync(file, "utf8");
    assert.match(
      code,
      /attestOverrideAction\(\{/,
      `${label} must decide the override itself`
    );
    assert.match(
      code,
      /hasGenuineOverride/,
      `${label} must pass its own verdict, not the caller's`
    );
  }
});

check("tabular reads an override as CREATE the policy would have SKIPPED", () => {
  // NOT every CREATE. A row that never blocked has nothing to override, so
  // counting one would hand every ordinary import a way out of replay.
  const code = fs.readFileSync(
    "lib/data-transfer/import/preview/preview-orchestrator.ts",
    "utf8"
  );
  const block = code.slice(
    code.indexOf("const hasGenuineOverride"),
    code.indexOf("const overrideActionHash")
  );
  assert.match(block, /=== "CREATE"/);
  assert.match(block, /mayOverrideToCreate\(/);
});

check("CREATE_ANYWAY is never a server default, which is what makes it usable", () => {
  // The whole design rests on this: a row carrying the override word carries no
  // trace of the database state the import changes, because only the owner can
  // put it there. If a default could ever produce it, the key would be derived
  // from mutable state again and F-01 would be back.
  const historical = fs.readFileSync(
    "lib/data-transfer/historical/historical-decisions.ts",
    "utf8"
  );
  // The BODY only. The comments around it say "CREATE_ANYWAY" precisely because
  // they explain why it can never be returned here.
  const fromDefault = historical.slice(
    historical.indexOf("export function defaultActionFor")
  );
  const defaults = fromDefault.slice(0, fromDefault.indexOf("\n}"));
  assert.equal(defaults.includes("CREATE_ANYWAY"), false);

  const documents = fs.readFileSync(
    "lib/data-transfer/documents/batch-analyze.ts",
    "utf8"
  );
  const docDefaults = documents.slice(
    documents.indexOf("export function defaultDocumentDecisions")
  );
  assert.equal(
    docDefaults.slice(0, docDefaults.indexOf("}")).includes("CREATE_ANYWAY"),
    false
  );
});

console.log(`\nIMPORT EXECUTE CONTRACT VERIFY PASS — ${passed} checks green.`);
