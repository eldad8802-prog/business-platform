/**
 * I-8B.3 — duplicate and reversal analysis, without a database.
 *
 * The decision half is a pure function of the uploaded rows and whatever the
 * database returned, so it is tested that way: `analyzeAgainstRecords` gets
 * both halves handed to it. The tenant boundary and the real query shape are
 * proven separately against PostgreSQL in `.i8b3/battery.mjs`, because a
 * JavaScript model cannot prove row-level security.
 *
 * Run: npx tsx lib/data-transfer/historical/historical-duplicates.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  analyzeAgainstRecords,
  fingerprintRecords,
  readExistingRecords,
  DUPLICATE_LOOKUP_CHUNK,
  DUPLICATE_LOOKUP_MAX_GROUPS,
  type ComparableFacts,
  type DuplicateInputRow,
} from "@/lib/data-transfer/historical/historical-duplicates";

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

const FACTS: ComparableFacts = {
  originalIssueDate: "2024-03-17",
  totalAmount: "1170.00",
  subtotalAmount: "1000.00",
  vatAmount: "170.00",
  currency: "ILS",
  customerNameSnapshot: "חברת דוגמה",
  customerTaxIdSnapshot: "512345678",
};

function row(
  sourceRowNumber: number,
  overrides: {
    source?: string;
    type?: string;
    number?: string | null;
    facts?: Partial<ComparableFacts>;
    reverses?: string | null;
  } = {}
): DuplicateInputRow {
  return {
    sourceRowNumber,
    identity: {
      sourceSystemCode: overrides.source ?? "legacy-erp",
      documentTypeCode: overrides.type ?? "TAX_INVOICE",
      originalDocumentNumber:
        overrides.number === undefined ? `INV-${sourceRowNumber}` : overrides.number,
    },
    facts: { ...FACTS, ...overrides.facts },
    reversesOriginalNumberRaw: overrides.reverses ?? null,
  };
}

function record(
  overrides: {
    source?: string;
    type?: string;
    number?: string;
    facts?: Partial<ComparableFacts>;
  } = {}
) {
  return {
    sourceSystemCode: overrides.source ?? "legacy-erp",
    documentTypeCode: overrides.type ?? "TAX_INVOICE",
    originalDocumentNumber: overrides.number ?? "INV-1",
    ...FACTS,
    ...overrides.facts,
  };
}

const at = (
  result: ReturnType<typeof analyzeAgainstRecords>,
  rowNumber: number
) => {
  const found = result.get(rowNumber);
  assert.ok(found, `row ${rowNumber} missing from the analysis`);
  return found;
};

async function main(): Promise<void> {
  console.log("\nI-8B.3 — historical duplicate and reversal analysis\n");

  /* =============================================== 1. database states === */

  await check("no existing record means NONE", () => {
    const result = analyzeAgainstRecords([row(1)], []);
    assert.equal(at(result, 1).duplicate.database.state, "NONE");
    assert.equal(at(result, 1).duplicate.database.matchCount, 0);
  });

  await check("one match with every fact agreeing is EXACT", () => {
    const result = analyzeAgainstRecords([row(1)], [record()]);
    const db = at(result, 1).duplicate.database;
    assert.equal(db.state, "EXACT");
    assert.equal(db.matchCount, 1);
    assert.deepEqual(db.differingFields, []);
    assert.ok(db.comparison?.every((c) => c.agrees));
  });

  await check("a different total makes it a STRONG_CANDIDATE, not a match", () => {
    const result = analyzeAgainstRecords(
      [row(1)],
      [record({ facts: { totalAmount: "1180.00" } })]
    );
    const db = at(result, 1).duplicate.database;
    assert.equal(db.state, "STRONG_CANDIDATE");
    assert.deepEqual(db.differingFields, ["totalAmount"]);
  });

  await check("a different DATE is a STRONG_CANDIDATE — it is not in the identity", () => {
    // A corrected re-export that fixes the date is the SAME document. If the
    // date were part of the identity this would be NONE and the owner would
    // silently gain a second copy of the invoice.
    const result = analyzeAgainstRecords(
      [row(1)],
      [record({ facts: { originalIssueDate: "2024-03-18" } })]
    );
    const db = at(result, 1).duplicate.database;
    assert.equal(db.state, "STRONG_CANDIDATE");
    assert.deepEqual(db.differingFields, ["originalIssueDate"]);
  });

  await check("amounts are compared as decimals, not as text", () => {
    // "1170.0" and "1170.00" are the same amount. A string comparison would
    // report an identical record as a collision.
    const result = analyzeAgainstRecords(
      [row(1, { facts: { totalAmount: "1170.0" } })],
      [record({ facts: { totalAmount: "1170.00" } })]
    );
    assert.equal(at(result, 1).duplicate.database.state, "EXACT");
  });

  await check("a null on one side only is a difference; both null agree", () => {
    const oneNull = analyzeAgainstRecords(
      [row(1, { facts: { subtotalAmount: null } })],
      [record()]
    );
    assert.deepEqual(
      at(oneNull, 1).duplicate.database.differingFields,
      ["subtotalAmount"]
    );

    const bothNull = analyzeAgainstRecords(
      [row(1, { facts: { subtotalAmount: null, vatAmount: null } })],
      [record({ facts: { subtotalAmount: null, vatAmount: null } })]
    );
    assert.equal(at(bothNull, 1).duplicate.database.state, "EXACT");
  });

  await check("two existing records with one identity is AMBIGUOUS, never a pick", () => {
    const result = analyzeAgainstRecords([row(1)], [record(), record()]);
    const db = at(result, 1).duplicate.database;
    assert.equal(db.state, "AMBIGUOUS");
    assert.equal(db.matchCount, 2);
    assert.equal(db.comparison, null, "no comparison is offered for a tie");
  });

  await check("the same number under a DIFFERENT source system is not a duplicate", () => {
    const result = analyzeAgainstRecords(
      [row(1, { source: "system-a" })],
      [record({ source: "system-b" })]
    );
    assert.equal(at(result, 1).duplicate.database.state, "NONE");
  });

  await check("the same number under a different TYPE is not a duplicate", () => {
    const result = analyzeAgainstRecords(
      [row(1, { type: "RECEIPT" })],
      [record({ type: "TAX_INVOICE" })]
    );
    assert.equal(at(result, 1).duplicate.database.state, "NONE");
  });

  await check("a row without a complete identity is never matched", () => {
    const result = analyzeAgainstRecords([row(1, { number: null })], [record()]);
    assert.equal(at(result, 1).duplicate.database.state, "NONE");
  });

  /* ================================================ 2. in-file states === */

  await check("two identical rows: the first is clean, the second is a duplicate", () => {
    const result = analyzeAgainstRecords([row(1, { number: "A" }), row(2, { number: "A" })], []);
    assert.equal(at(result, 1).duplicate.inFile.state, "NONE");
    assert.deepEqual(at(result, 1).duplicate.inFile.laterRows, [2]);
    assert.equal(at(result, 2).duplicate.inFile.state, "EXACT_DUPLICATE");
    assert.equal(at(result, 2).duplicate.inFile.firstOccurrenceRow, 1);
  });

  await check("a later row that disagrees is a CONFLICTING duplicate", () => {
    const result = analyzeAgainstRecords(
      [row(1, { number: "A" }), row(2, { number: "A", facts: { totalAmount: "999.00" } })],
      []
    );
    assert.equal(at(result, 2).duplicate.inFile.state, "CONFLICTING_DUPLICATE");
    assert.equal(at(result, 2).duplicate.inFile.firstOccurrenceRow, 1);
  });

  await check("three occurrences all point at the FIRST, and it lists them", () => {
    const result = analyzeAgainstRecords(
      [row(1, { number: "A" }), row(2, { number: "A" }), row(3, { number: "A" })],
      []
    );
    assert.deepEqual(at(result, 1).duplicate.inFile.laterRows, [2, 3]);
    assert.equal(at(result, 2).duplicate.inFile.firstOccurrenceRow, 1);
    assert.equal(at(result, 3).duplicate.inFile.firstOccurrenceRow, 1);
  });

  await check("source order decides, whatever order the rows arrive in", () => {
    // Handed in backwards. Row 1 must still be the first occurrence.
    const result = analyzeAgainstRecords(
      [row(3, { number: "A" }), row(1, { number: "A" }), row(2, { number: "A" })],
      []
    );
    assert.equal(at(result, 1).duplicate.inFile.state, "NONE");
    assert.equal(at(result, 3).duplicate.inFile.firstOccurrenceRow, 1);
  });

  await check("no row is removed and no value is changed", () => {
    const rows = [row(1, { number: "A" }), row(2, { number: "A" })];
    const before = JSON.stringify(rows);
    const result = analyzeAgainstRecords(rows, []);
    assert.equal(result.size, 2, "both rows survive the analysis");
    assert.equal(JSON.stringify(rows), before, "the input is not mutated");
  });

  /* =============================================== 3. reversal states === */

  const credit = (n: number, reverses: string | null, source = "legacy-erp") =>
    row(n, { type: "CREDIT_NOTE", number: `CN-${n}`, reverses, source });

  await check("a non-credit row is NOT_APPLICABLE", () => {
    const result = analyzeAgainstRecords([row(1)], []);
    assert.equal(at(result, 1).reversal.state, "NOT_APPLICABLE");
  });

  await check("a credit with no reference is NO_REFERENCE, and keeps nothing hidden", () => {
    const result = analyzeAgainstRecords([credit(1, null)], []);
    const reversal = at(result, 1).reversal;
    assert.equal(reversal.state, "NO_REFERENCE");
    assert.equal(reversal.rawNumber, null);
  });

  await check("a credit resolves to exactly one existing record", () => {
    const result = analyzeAgainstRecords(
      [credit(1, "INV-9")],
      [record({ number: "INV-9" })]
    );
    const reversal = at(result, 1).reversal;
    assert.equal(reversal.state, "RESOLVED_EXISTING");
    assert.equal(reversal.rawNumber, "INV-9");
    assert.equal(reversal.targetSummary?.documentTypeCode, "TAX_INVOICE");
    // Owner-safe: a description, never a database id.
    assert.ok(!JSON.stringify(reversal).includes('"id"'));
  });

  await check("a credit whose original was never imported is NOT_FOUND, not fatal", () => {
    const result = analyzeAgainstRecords([credit(1, "INV-9")], []);
    const reversal = at(result, 1).reversal;
    assert.equal(reversal.state, "NOT_FOUND");
    assert.equal(reversal.rawNumber, "INV-9", "the raw number is preserved");
  });

  await check("two candidates is AMBIGUOUS — no heuristic picks one", () => {
    const result = analyzeAgainstRecords(
      [credit(1, "INV-9")],
      [record({ number: "INV-9" }), record({ number: "INV-9", type: "RECEIPT" })]
    );
    const reversal = at(result, 1).reversal;
    assert.equal(reversal.state, "AMBIGUOUS");
    assert.equal(reversal.candidateCount, 2);
    assert.equal(reversal.targetSummary, null);
    assert.equal(reversal.targetSourceRow, null);
  });

  await check("a reference never crosses source systems", () => {
    // The number identifies a document within the system that issued it.
    const result = analyzeAgainstRecords(
      [credit(1, "INV-9", "system-a")],
      [record({ number: "INV-9", source: "system-b" })]
    );
    assert.equal(at(result, 1).reversal.state, "NOT_FOUND");
  });

  await check("a credit cannot credit another credit", () => {
    const result = analyzeAgainstRecords(
      [credit(1, "CN-77")],
      [record({ number: "CN-77", type: "CREDIT_NOTE" })]
    );
    assert.equal(at(result, 1).reversal.state, "UNSUPPORTED_TARGET_TYPE");
  });

  await check("an EARLIER row in the same file resolves the reference", () => {
    const result = analyzeAgainstRecords(
      [row(1, { number: "INV-9" }), credit(2, "INV-9")],
      []
    );
    const reversal = at(result, 2).reversal;
    assert.equal(reversal.state, "RESOLVED_IN_FILE");
    assert.equal(reversal.targetSourceRow, 1);
  });

  await check("a target that appears LATER is not pretended to be executable", () => {
    // Execute inserts in source order and binds the id in memory; there is no
    // second pass, because the column has no UPDATE policy in production.
    const result = analyzeAgainstRecords(
      [credit(1, "INV-9"), row(2, { number: "INV-9" })],
      []
    );
    assert.equal(at(result, 1).reversal.state, "TARGET_AFTER_CREDIT");
  });

  await check("rows are never reordered to make a later target earlier", () => {
    const rows = [credit(1, "INV-9"), row(2, { number: "INV-9" })];
    const result = analyzeAgainstRecords(rows, []);
    assert.equal(rows[0].sourceRowNumber, 1, "the input order is untouched");
    assert.notEqual(at(result, 1).reversal.state, "RESOLVED_IN_FILE");
  });

  await check("two earlier in-file candidates is AMBIGUOUS", () => {
    const result = analyzeAgainstRecords(
      [
        row(1, { number: "INV-9" }),
        row(2, { number: "INV-9", type: "RECEIPT" }),
        credit(3, "INV-9"),
      ],
      []
    );
    assert.equal(at(result, 3).reversal.state, "AMBIGUOUS");
  });

  await check("an in-file candidate and an existing record together are AMBIGUOUS", () => {
    const result = analyzeAgainstRecords(
      [row(1, { number: "INV-9" }), credit(2, "INV-9")],
      [record({ number: "INV-9", type: "RECEIPT" })]
    );
    assert.equal(at(result, 2).reversal.state, "AMBIGUOUS");
  });

  /* =================================================== 4. combined ====== */

  await check("duplicate and reversal are reported independently", () => {
    // A credit that already exists AND whose target was never imported. Both
    // facts must survive; collapsing them would hide one.
    const result = analyzeAgainstRecords(
      [credit(1, "INV-9")],
      [record({ number: "CN-1", type: "CREDIT_NOTE" })]
    );
    const found = at(result, 1);
    assert.equal(found.duplicate.database.state, "EXACT");
    assert.equal(found.reversal.state, "NOT_FOUND");
  });

  await check("a conflicting duplicate can accompany an ambiguous reversal", () => {
    const result = analyzeAgainstRecords(
      [credit(1, "INV-9")],
      [
        record({ number: "CN-1", type: "CREDIT_NOTE", facts: { totalAmount: "1.00" } }),
        record({ number: "INV-9" }),
        record({ number: "INV-9", type: "RECEIPT" }),
      ]
    );
    const found = at(result, 1);
    assert.equal(found.duplicate.database.state, "STRONG_CANDIDATE");
    assert.equal(found.reversal.state, "AMBIGUOUS");
  });

  /* ================================================== 5. freshness ====== */

  await check("the evidence fingerprint is order-independent and content-sensitive", () => {
    const a = fingerprintRecords([record({ number: "A" }), record({ number: "B" })]);
    const b = fingerprintRecords([record({ number: "B" }), record({ number: "A" })]);
    assert.equal(a, b, "row order from the database must not change the fingerprint");

    const changed = fingerprintRecords([
      record({ number: "A", facts: { totalAmount: "1.00" } }),
      record({ number: "B" }),
    ]);
    assert.notEqual(a, changed, "a changed fact must change the fingerprint");

    const added = fingerprintRecords([
      record({ number: "A" }),
      record({ number: "B" }),
      record({ number: "C" }),
    ]);
    assert.notEqual(a, added, "a new matching record must change the fingerprint");
    assert.notEqual(fingerprintRecords([]), a);
  });

  /* ==================================================== 6. scale ======== */

  await check("in-file analysis of 10,000 rows is linear, not quadratic", () => {
    const rows: DuplicateInputRow[] = [];
    for (let i = 1; i <= 10_000; i += 1) {
      // Every 100th row repeats an earlier number, so the duplicate paths are
      // genuinely exercised rather than skipped.
      rows.push(row(i, { number: `INV-${i % 100}` }));
    }
    const started = Date.now();
    const result = analyzeAgainstRecords(rows, []);
    const elapsed = Date.now() - started;
    assert.equal(result.size, 10_000);
    // A quadratic implementation is 100,000,000 comparisons and takes minutes.
    assert.ok(elapsed < 10_000, `10,000 rows took ${elapsed}ms`);
    // Row 101 repeats row 1's number.
    assert.equal(at(result, 101).duplicate.inFile.firstOccurrenceRow, 1);
  });

  await check("the lookup is bounded: a 10,000-row file is tens of queries", async () => {
    // A fake transaction that counts calls and returns nothing. What is under
    // test is the QUERY STRATEGY, not the database.
    let queries = 0;
    const tx = {
      historicalFiscalDocument: {
        findMany: async (args: { where: { originalDocumentNumber?: { in?: string[] } } }) => {
          queries += 1;
          const list = args.where.originalDocumentNumber?.in;
          assert.ok(Array.isArray(list), "every query must ask for a bounded list");
          assert.ok(
            list.length <= DUPLICATE_LOOKUP_CHUNK,
            `chunk of ${list.length} exceeds ${DUPLICATE_LOOKUP_CHUNK}`
          );
          return [];
        },
      },
    };

    // 10,000 distinct identities across four types and two source systems.
    const identities = Array.from({ length: 10_000 }, (_, i) => ({
      sourceSystemCode: i % 2 === 0 ? "a" : "b",
      documentTypeCode: ["TAX_INVOICE", "RECEIPT", "TAX_INVOICE_RECEIPT", "CREDIT_NOTE"][i % 4],
      originalDocumentNumber: `INV-${i}`,
    }));

    const result = await readExistingRecords(
      tx as never,
      1,
      identities
    );
    assert.equal(result.records.length, 0);
    // 8 groups, 10,000 identities, 500 per query -> 8 + 20 at worst.
    assert.ok(queries <= 8 + Math.ceil(10_000 / DUPLICATE_LOOKUP_CHUNK), `${queries} queries`);
    assert.ok(queries < 100, `${queries} queries is not bounded`);
    assert.equal(queries, result.queryCount);
  });

  await check("an implausible number of source systems stays bounded too", async () => {
    let queries = 0;
    const tx = {
      historicalFiscalDocument: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          queries += 1;
          // The fallback asks by number alone, so it must NOT carry a source
          // system — otherwise it is the grouped strategy in disguise.
          assert.equal(args.where.sourceSystemCode, undefined);
          return [];
        },
      },
    };
    const identities = Array.from({ length: 5_000 }, (_, i) => ({
      sourceSystemCode: `system-${i}`,
      documentTypeCode: "TAX_INVOICE",
      originalDocumentNumber: `INV-${i}`,
    }));
    await readExistingRecords(tx as never, 1, identities);
    assert.ok(
      identities.length / DUPLICATE_LOOKUP_CHUNK >= queries - 1,
      `${queries} queries for ${identities.length} identities`
    );
    assert.ok(queries <= 20, `${queries} queries`);
    assert.ok(DUPLICATE_LOOKUP_MAX_GROUPS < 5_000);
  });

  await check("no identities means no query at all", async () => {
    let queries = 0;
    const tx = {
      historicalFiscalDocument: {
        findMany: async () => {
          queries += 1;
          return [];
        },
      },
    };
    const result = await readExistingRecords(tx as never, 1, []);
    assert.equal(queries, 0);
    assert.equal(result.queryCount, 0);
  });

  /* ================================================= 7. read-only ======= */

  await check("nothing on this path can write, and nothing reaches billing", () => {
    const files = [
      "lib/data-transfer/historical/historical-duplicates.ts",
      "lib/data-transfer/historical/historical-analyze-duplicates.ts",
      "app/api/data-transfer/import/historical/analyze/route.ts",
    ];
    const forbidden = [
      ".create(",
      ".createMany(",
      ".update(",
      ".updateMany(",
      ".upsert(",
      ".delete(",
      ".deleteMany(",
      ".executeRaw",
      "billingDocument",
      "BillingDocument",
      "financialEvent",
      "importRun.",
      "importRunRow",
      "reversesHistoricalDocumentId:",
      "GRANT",
    ];
    // Comments are stripped first. These modules NAME the things they refuse
    // to touch, in order to say why, and a guard that fires on its own
    // explanation is a guard somebody eventually deletes.
    const codeOf = (file: string) =>
      fs
        .readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/, ""))
        .join("\n");

    for (const file of files) {
      const code = codeOf(file);
      for (const needle of forbidden) {
        assert.ok(!code.includes(needle), `${file} must not contain ${needle}`);
      }
    }
    // The only model access anywhere on the path is a read.
    const accesses = [
      ...codeOf("lib/data-transfer/historical/historical-duplicates.ts").matchAll(
        /historicalFiscalDocument\.(\w+)\(/g
      ),
    ].map((m) => m[1]);
    assert.deepEqual([...new Set(accesses)], ["findMany"]);
  });

  await check("the lookup runs inside the tenant transaction, not beside it", () => {
    const src = fs.readFileSync(
      "lib/data-transfer/historical/historical-duplicates.ts",
      "utf8"
    );
    assert.ok(src.includes("withTenantTransaction"), "RLS needs the tenant GUC");
    // The business is a parameter of the read, never taken from the request.
    assert.ok(!/businessId\s*[:=]\s*(form|body|params|headers|req)/.test(src));

    const route = fs.readFileSync(
      "app/api/data-transfer/import/historical/analyze/route.ts",
      "utf8"
    );
    assert.ok(route.includes("runWithTenantContext"));
    assert.ok(route.includes("user.businessId"));
    assert.ok(!route.includes('form.get("businessId")'));
  });

  console.log(`\n  ${passed} checks passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    failures.forEach((f) => console.log(`  FAILED: ${f}`));
    process.exitCode = 1;
  }
}

void main();
