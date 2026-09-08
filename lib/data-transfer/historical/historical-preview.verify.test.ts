/**
 * I-8B.4 — historical Preview and owner decisions.
 *
 * The decision model and the token are pure, so they are tested without a
 * database. The parts that genuinely need one — staleness against real rows,
 * tenant isolation, and the query count — are proven in `.i8b3/battery.mjs`
 * and its I-8B.4 scenarios.
 *
 * Run: npx tsx lib/data-transfer/historical/historical-preview.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  allowedActionsFor,
  blockingReasons,
  canonicalizeDecisions,
  decisionsHashOf,
  defaultActionFor,
  isBlocked,
  requiresOwnerDecision,
  resolveDecisions,
  unresolvedRows,
  validateDecisions,
  HISTORICAL_ACTIONS,
  type DecidableRow,
} from "@/lib/data-transfer/historical/historical-decisions";
import {
  issueHistoricalPreviewToken,
  verifyHistoricalPreviewToken,
  type HistoricalPreviewFacts,
} from "@/lib/data-transfer/historical/historical-preview-token";
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

/* ------------------------------------------------------------ fixtures --- */

function row(overrides: Partial<DecidableRow> = {}): DecidableRow {
  return {
    sourceRowNumber: 1,
    hasStructuralError: false,
    database: "NONE",
    inFile: "NONE",
    reversal: "NOT_APPLICABLE",
    ...overrides,
  };
}

const FACTS: HistoricalPreviewFacts = {
  businessId: 7,
  userId: 11,
  domain: "historical-documents",
  contentHash: "c".repeat(64),
  sheetName: "ייבוא",
  mappingHash: "m".repeat(64),
  dateFormat: "DMY",
  analysisHash: "a".repeat(64),
  rowCount: 3,
  decisionsHash: "d".repeat(64),
  evidenceFingerprint: "e".repeat(64),
};

/** Tamper with one field inside a signed envelope, keeping the signature. */
function tamper(token: string, mutate: (payload: Record<string, unknown>) => void): string {
  const [body, mac] = token.split(".");
  const payload = JSON.parse(
    Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
  );
  mutate(payload);
  const forged = Buffer.from(JSON.stringify(payload))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${forged}.${mac}`;
}

async function main(): Promise<void> {
  process.env.AUTH_TOKEN_SECRET ||= "i8b4-test-secret";
  console.log("\nI-8B.4 — historical preview and owner decisions\n");

  /* ================================================== 1. defaults ======= */

  await check("a clean new row defaults to CREATE", () => {
    const r = row();
    assert.equal(defaultActionFor(r), "CREATE");
    assert.deepEqual(allowedActionsFor(r), ["CREATE", "SKIP"]);
    assert.equal(requiresOwnerDecision(r), false);
    assert.equal(isBlocked(r), false);
  });

  await check("an exact database duplicate defaults to SKIP, never CREATE", () => {
    const r = row({ database: "EXACT" });
    assert.equal(defaultActionFor(r), "SKIP");
    assert.deepEqual(allowedActionsFor(r), ["SKIP", "CREATE_ANYWAY"]);
    // Importing a second copy is possible, but only as a named override.
    assert.ok(!allowedActionsFor(r).includes("CREATE"));
  });

  await check("a strong candidate defaults to SKIP and ASKS the owner", () => {
    const r = row({ database: "STRONG_CANDIDATE" });
    assert.equal(defaultActionFor(r), "SKIP");
    assert.equal(requiresOwnerDecision(r), true);
    assert.deepEqual(allowedActionsFor(r), ["SKIP", "CREATE_ANYWAY"]);
  });

  await check("a later in-file duplicate defaults to SKIP — the first row wins", () => {
    const exact = row({ sourceRowNumber: 2, inFile: "EXACT_DUPLICATE" });
    assert.equal(defaultActionFor(exact), "SKIP");
    assert.equal(requiresOwnerDecision(exact), false, "identical rows need no question");

    const conflicting = row({ sourceRowNumber: 2, inFile: "CONFLICTING_DUPLICATE" });
    assert.equal(defaultActionFor(conflicting), "SKIP");
    assert.equal(requiresOwnerDecision(conflicting), true, "a disagreement is a question");
  });

  await check("the default is never CREATE_ANYWAY", () => {
    const states: DecidableRow[] = [
      row(),
      row({ database: "EXACT" }),
      row({ database: "STRONG_CANDIDATE" }),
      row({ database: "AMBIGUOUS" }),
      row({ inFile: "EXACT_DUPLICATE" }),
      row({ inFile: "CONFLICTING_DUPLICATE" }),
      row({ hasStructuralError: true }),
      row({ reversal: "NOT_FOUND" }),
    ];
    for (const r of states) {
      assert.notEqual(defaultActionFor(r), "CREATE_ANYWAY", JSON.stringify(r));
    }
  });

  /* ================================================== 2. blocking ======= */

  await check("structural errors and every ambiguity block, with named reasons", () => {
    const cases: [DecidableRow, string][] = [
      [row({ hasStructuralError: true }), "STRUCTURAL_ERROR"],
      [row({ database: "AMBIGUOUS" }), "DUPLICATE_AMBIGUOUS"],
      [row({ reversal: "AMBIGUOUS" }), "REVERSAL_AMBIGUOUS"],
      [row({ reversal: "TARGET_AFTER_CREDIT" }), "REVERSAL_TARGET_AFTER_CREDIT"],
      [row({ reversal: "UNSUPPORTED_TARGET_TYPE" }), "REVERSAL_TARGET_UNSUPPORTED_TYPE"],
    ];
    for (const [r, code] of cases) {
      assert.ok(isBlocked(r), code);
      assert.ok(blockingReasons(r).includes(code as never), code);
      assert.deepEqual(allowedActionsFor(r), ["SKIP"], code);
      assert.equal(requiresOwnerDecision(r), false, "a blocked row is not a question");
    }
  });

  await check("a warning-level reversal does NOT block", () => {
    for (const state of ["NOT_FOUND", "NO_REFERENCE"] as const) {
      const r = row({ reversal: state });
      assert.equal(isBlocked(r), false, state);
      assert.equal(defaultActionFor(r), "CREATE", state);
    }
  });

  /* ============================================ 3. decision validation == */

  await check("CREATE_ANYWAY on a clean row is refused as meaningless", () => {
    const rows = [row()];
    const problems = validateDecisions(rows, { 1: "CREATE_ANYWAY" });
    assert.equal(problems.length, 1);
    assert.equal(problems[0].code, "NOT_PERMITTED");
  });

  await check("CREATE on an exact duplicate is refused — the override must be named", () => {
    const rows = [row({ database: "EXACT" })];
    assert.equal(validateDecisions(rows, { 1: "CREATE" })[0]?.code, "NOT_PERMITTED");
    assert.deepEqual(validateDecisions(rows, { 1: "SKIP" }), []);
    assert.deepEqual(validateDecisions(rows, { 1: "CREATE_ANYWAY" }), []);
  });

  await check("CREATE_ANYWAY cannot bypass a structural error", () => {
    const rows = [row({ hasStructuralError: true })];
    const problems = validateDecisions(rows, { 1: "CREATE_ANYWAY" });
    assert.equal(problems[0]?.code, "BLOCKED_ROW");
    // It is not "ignore validation". An ambiguous date is still not a date.
    assert.deepEqual(validateDecisions(rows, { 1: "SKIP" }), []);
  });

  await check("CREATE_ANYWAY cannot bypass ambiguity of any kind", () => {
    for (const r of [
      row({ database: "AMBIGUOUS" }),
      row({ reversal: "AMBIGUOUS" }),
      row({ reversal: "TARGET_AFTER_CREDIT" }),
      row({ reversal: "UNSUPPORTED_TARGET_TYPE" }),
    ]) {
      const problems = validateDecisions([r], { 1: "CREATE_ANYWAY" });
      assert.equal(problems[0]?.code, "BLOCKED_ROW", JSON.stringify(r));
    }
  });

  await check("an unknown row and an unknown action are both refused", () => {
    const rows = [row()];
    assert.equal(validateDecisions(rows, { 99: "CREATE" })[0]?.code, "UNKNOWN_ROW");
    assert.equal(
      validateDecisions(rows, { 1: "OVERWRITE" as never })[0]?.code,
      "INVALID_ACTION"
    );
  });

  await check("there is no fourth action — overwrite and merge do not exist", () => {
    assert.deepEqual([...HISTORICAL_ACTIONS], ["CREATE", "SKIP", "CREATE_ANYWAY"]);
    for (const forbidden of ["OVERWRITE", "MERGE", "UPDATE", "REPLACE", "DELETE"]) {
      assert.ok(!(HISTORICAL_ACTIONS as readonly string[]).includes(forbidden), forbidden);
    }
    const src = fs.readFileSync(
      "lib/data-transfer/historical/historical-decisions.ts",
      "utf8"
    );
    // The module names overwrite and merge only to say they are not what
    // CREATE_ANYWAY means. What it must not have is a way to perform one.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    for (const forbidden of ["@/lib/prisma", "PrismaClient", "prisma."]) {
      assert.ok(!code.includes(forbidden), `the decision model must not contain ${forbidden}`);
    }
  });

  /* ================================================ 4. resolution ======= */

  await check("unsupplied rows take their default, and every row gets one", () => {
    const rows = [row({ sourceRowNumber: 1 }), row({ sourceRowNumber: 2, database: "EXACT" })];
    const resolved = resolveDecisions(rows, null);
    assert.deepEqual(resolved, { 1: "CREATE", 2: "SKIP" });
  });

  await check("a supplied decision wins, and an impermissible one falls back", () => {
    const rows = [row({ sourceRowNumber: 1, database: "EXACT" })];
    assert.deepEqual(resolveDecisions(rows, { 1: "CREATE_ANYWAY" }), { 1: "CREATE_ANYWAY" });
    // Never silently honoured; the caller has already been told via validation.
    assert.deepEqual(resolveDecisions(rows, { 1: "CREATE" }), { 1: "SKIP" });
  });

  await check("rows awaiting the owner are named until they answer", () => {
    const rows = [
      row({ sourceRowNumber: 1, database: "STRONG_CANDIDATE" }),
      row({ sourceRowNumber: 2, inFile: "CONFLICTING_DUPLICATE" }),
      row({ sourceRowNumber: 3 }),
    ];
    assert.deepEqual(unresolvedRows(rows, null), [1, 2]);
    assert.deepEqual(unresolvedRows(rows, { 1: "SKIP" }), [2]);
    assert.deepEqual(unresolvedRows(rows, { 1: "SKIP", 2: "CREATE_ANYWAY" }), []);
  });

  /* ================================================ 5. decision hash ==== */

  await check("the decision hash is order-independent and change-sensitive", () => {
    const a = decisionsHashOf({ 1: "CREATE", 2: "SKIP" });
    const b = decisionsHashOf({ 2: "SKIP", 1: "CREATE" });
    assert.equal(a, b, "key order must not change the hash");
    assert.notEqual(a, decisionsHashOf({ 1: "SKIP", 2: "SKIP" }));
    assert.notEqual(a, decisionsHashOf({ 1: "CREATE_ANYWAY", 2: "SKIP" }));
    assert.notEqual(a, decisionsHashOf({ 1: "CREATE" }));
    assert.equal(canonicalizeDecisions({ 2: "SKIP", 1: "CREATE" }), "1=CREATE\n2=SKIP");
  });

  /* ==================================================== 6. token ======== */

  await check("a freshly minted token verifies and returns every bound fact", () => {
    const token = issueHistoricalPreviewToken(FACTS);
    const result = verifyHistoricalPreviewToken(token);
    assert.ok(result.ok);
    if (result.ok) assert.deepEqual(result.facts, FACTS);
  });

  await check("a tabular preview token can NEVER be used as a historical one", () => {
    // Different key label, so this fails at the signature — not at a field
    // somebody remembered to check.
    const tabular = issuePreviewToken({
      businessId: 7,
      userId: 11,
      domain: "customers",
      contentHash: "c".repeat(64),
      mappingHash: "m".repeat(64),
      decisionsHash: "d".repeat(64),
      sheetName: null,
      rowCount: 3,
    });
    const result = verifyHistoricalPreviewToken(tabular);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "BAD_SIGNATURE");
  });

  await check("every bound fact is tamper-evident", () => {
    const token = issueHistoricalPreviewToken(FACTS);
    const mutations: [string, (p: Record<string, unknown>) => void][] = [
      ["another business", (p) => (p.businessId = 8)],
      ["another user", (p) => (p.userId = 12)],
      ["another domain", (p) => (p.domain = "customers")],
      ["different bytes", (p) => (p.contentHash = "0".repeat(64))],
      ["a different mapping", (p) => (p.mappingHash = "0".repeat(64))],
      ["a different analysis", (p) => (p.analysisHash = "0".repeat(64))],
      ["different decisions", (p) => (p.decisionsHash = "0".repeat(64))],
      ["different read evidence", (p) => (p.evidenceFingerprint = "0".repeat(64))],
      ["a different row count", (p) => (p.rowCount = 4)],
      ["a different date reading", (p) => (p.dateFormat = "MDY")],
      ["a different sheet", (p) => (p.sheetName = "אחר")],
      ["a longer life", (p) => (p.exp = Number(p.exp) + 86_400)],
    ];
    for (const [what, mutate] of mutations) {
      const forged = tamper(token, mutate);
      const result = verifyHistoricalPreviewToken(forged);
      assert.equal(result.ok, false, `${what} was accepted`);
      if (!result.ok) assert.equal(result.reason, "BAD_SIGNATURE", what);
    }
  });

  await check("an expired token is refused", () => {
    const issued = new Date("2026-01-01T00:00:00.000Z");
    const token = issueHistoricalPreviewToken(FACTS, issued);
    const later = new Date(issued.getTime() + 24 * 60 * 60 * 1000);
    const result = verifyHistoricalPreviewToken(token, later);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "EXPIRED");
  });

  await check("garbage is refused without reaching a business check", () => {
    for (const junk of ["", "abc", "a.b.c", "..", null, 42, {}]) {
      const result = verifyHistoricalPreviewToken(junk as never);
      assert.equal(result.ok, false, String(junk));
    }
  });

  await check("the token carries no business value — only hashes and counts", () => {
    const token = issueHistoricalPreviewToken(FACTS);
    const payload = Buffer.from(
      token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    ).toString("utf8");
    for (const forbidden of [
      "customerName",
      "customerTaxId",
      "totalAmount",
      "originalDocumentNumber",
      "values",
      "rows",
      "חברת",
    ]) {
      assert.ok(!payload.includes(forbidden), `the token exposes ${forbidden}`);
    }
    // What it DOES carry is exactly the bound identity.
    const parsed = JSON.parse(payload);
    assert.deepEqual(
      Object.keys(parsed).sort(),
      [
        "analysisHash",
        "businessId",
        "contentHash",
        "dateFormat",
        "decisionsHash",
        "domain",
        "evidenceFingerprint",
        "exp",
        "iat",
        "mappingHash",
        "nonce",
        "purpose",
        "rowCount",
        "sheetName",
        "userId",
        "v",
      ]
    );
  });

  /* ============================================ 7. structural guards ==== */

  await check("Preview is granted, and Execute still is not", () => {
    assert.ok(fs.existsSync("app/api/data-transfer/import/historical/preview/route.ts"));
    assert.ok(fs.existsSync("app/api/data-transfer/import/historical/analyze/route.ts"));
    assert.ok(
      !fs.existsSync("app/api/data-transfer/import/historical/execute/route.ts"),
      "there must be no historical execute route yet"
    );
    const registry = fs.readFileSync(
      "lib/data-transfer/export/export-registry.ts",
      "utf8"
    );
    assert.ok(!registry.includes("historical"), "the generic gate is unchanged");
  });

  await check("nothing on the preview path can write", () => {
    const codeOf = (file: string) =>
      fs
        .readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/, ""))
        .join("\n");

    for (const file of [
      "lib/data-transfer/historical/historical-preview.ts",
      "lib/data-transfer/historical/historical-decisions.ts",
      "lib/data-transfer/historical/historical-preview-token.ts",
      "app/api/data-transfer/import/historical/preview/route.ts",
    ]) {
      const code = codeOf(file);
      // Model-qualified, so a crypto `createHash(...).update(...)` is not
      // mistaken for a database write. A guard that fires on hashing is a
      // guard that gets relaxed for the wrong reason.
      const write =
        /\b(historicalFiscalDocument|importRun|importRunRow|customer|document|billingDocument|financialEvent|paymentRequest)\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/;
      assert.ok(!write.test(code), `${file} must not write a business record`);
      for (const needle of [
        "@/lib/prisma",
        "PrismaClient",
        ".executeRaw",
        "billingDocument",
        "financialEvent",
        "importRun",
      ]) {
        assert.ok(!code.includes(needle), `${file} must not contain ${needle}`);
      }
    }
  });

  await check("the owner-facing wording never implies Dubiz issued anything", () => {
    const surfaces = [
      "lib/data-transfer/historical/historical-preview.ts",
      "lib/data-transfer/historical/historical-decisions.ts",
      "app/api/data-transfer/import/historical/preview/route.ts",
    ];
    // Words that would tell an owner these documents came from Dubiz.
    for (const file of surfaces) {
      const src = fs.readFileSync(file, "utf8");
      for (const forbidden of ["הנפקה", "הפקה מחדש", "רשות המסים", "הקצאת מספר", "הוצאה מחדש"]) {
        assert.ok(!src.includes(forbidden), `${file} says "${forbidden}" to the owner`);
      }
    }
  });

  await check("the preview re-derives rather than trusting the request", () => {
    const src = fs.readFileSync(
      "lib/data-transfer/historical/historical-preview.ts",
      "utf8"
    );
    // Analysis is recomputed from the bytes on every call.
    assert.ok(src.includes("analyzeHistoricalSourceWithDuplicates"));
    // And no analysis result is ever read out of the input.
    assert.ok(!/input\.(rows|duplicate|reversal|analysis)\b/.test(src));
  });

  await check("a token is signed only for a preview that is ready", () => {
    const src = fs.readFileSync(
      "lib/data-transfer/historical/historical-preview.ts",
      "utf8"
    );
    assert.match(src, /readyForExecute\s*\n?\s*\?\s*issueHistoricalPreviewToken/);
  });

  /* ==================================================== 8. scale ======== */

  await check("decision resolution and hashing over 10,000 rows stay linear", () => {
    const rows: DecidableRow[] = [];
    for (let i = 1; i <= 10_000; i += 1) {
      rows.push(
        row({
          sourceRowNumber: i,
          database: i % 50 === 0 ? "EXACT" : "NONE",
          inFile: i % 97 === 0 ? "CONFLICTING_DUPLICATE" : "NONE",
        })
      );
    }
    const started = Date.now();
    const decisions = resolveDecisions(rows, null);
    const problems = validateDecisions(rows, decisions);
    const hash = decisionsHashOf(decisions);
    const elapsed = Date.now() - started;

    assert.equal(Object.keys(decisions).length, 10_000);
    assert.deepEqual(problems, [], "the server's own defaults must always validate");
    assert.equal(hash.length, 64);
    assert.ok(elapsed < 5_000, `10,000 rows took ${elapsed}ms`);
  });

  console.log(`\n  ${passed} checks passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    failures.forEach((f) => console.log(`  FAILED: ${f}`));
    process.exitCode = 1;
  }
}

void main();
