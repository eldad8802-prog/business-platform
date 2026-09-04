/**
 * `/api/reports/export` CSV — deterministic verifier.
 *
 * NO database, NO network, NO secrets: the route's pure CSV body lives in
 * `lib/reports/financial-records-csv.ts` precisely so this can run in the
 * BLOCKING CI-1 job. The route itself is left untested here on purpose — its
 * auth, tenant context and Prisma query are UNCHANGED by this fix, and pulling
 * them in would trade a provable guard for an unprovable one.
 *
 * Two things are asserted together, and they pull against each other:
 *   1. SECURITY — no corruption, no formula injection, correct UTF-8.
 *   2. COMPATIBILITY — the wire format changes as little as (1) allows.
 * A future edit that "improves" the format (semicolons, CRLF, a sep= line,
 * Hebrew headers) breaks a consumer of a legacy endpoint, so it fails here.
 *
 * Run: npx tsx lib/reports/financial-records-csv.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  FINANCIAL_RECORDS_CSV_HEADERS,
  buildFinancialRecordsCsvBuffer,
  toFinancialRecordCsvRow,
  type FinancialRecordCsvRow,
} from "@/lib/reports/financial-records-csv";

let passed = 0;

function check(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

const BOM = [0xef, 0xbb, 0xbf];

/** Body text with the BOM stripped, for line-level assertions. */
function csvText(records: FinancialRecordCsvRow[]): string {
  return buildFinancialRecordsCsvBuffer(records).subarray(3).toString("utf8");
}

function rec(
  vendorName: string,
  overrides: Partial<FinancialRecordCsvRow> = {}
): FinancialRecordCsvRow {
  return {
    date: new Date("2026-01-15T10:30:00.000Z"),
    vendorName,
    category: "office",
    amount: 187.77,
    direction: "expense",
    ...overrides,
  };
}

/**
 * The EXACT pre-fix renderer, reproduced so the compatibility half of this
 * verifier is differential rather than aspirational.
 */
function legacyCsv(records: FinancialRecordCsvRow[]): string {
  const headers = ["Date", "Vendor", "Category", "Amount", "Direction"];
  const rows = records.map((r) => [
    new Date(r.date).toISOString().split("T")[0],
    r.vendorName,
    r.category,
    r.amount,
    r.direction,
  ]);
  return [headers, ...rows].map((r) => r.join(",")).join("\n");
}

/* ============================================ 1. compatibility contract == */

check("the five English headers keep their labels and order", () => {
  assert.deepEqual(
    [...FINANCIAL_RECORDS_CSV_HEADERS],
    ["Date", "Vendor", "Category", "Amount", "Direction"]
  );
  assert.equal(
    csvText([]).split("\n")[0],
    '"Date","Vendor","Category","Amount","Direction"'
  );
});

check("the delimiter stays a comma and NO sep= directive is introduced", () => {
  const text = csvText([rec("Acme")]);
  assert.equal(text.startsWith("sep="), false);
  assert.equal(text.split("\n")[0].split(",").length, 5);
});

check("the line ending stays LF, not CRLF", () => {
  const text = csvText([rec("Acme"), rec("Beta")]);
  assert.equal(text.includes("\r\n"), false);
  assert.equal(text.split("\n").length, 3);
});

check("column values are derived exactly as before (date is YYYY-MM-DD)", () => {
  assert.deepEqual(toFinancialRecordCsvRow(rec("Acme")), [
    "2026-01-15",
    "Acme",
    "office",
    187.77,
    "expense",
  ]);
  // A string date is accepted the same way `new Date(r.date)` always did.
  assert.equal(
    toFinancialRecordCsvRow(rec("Acme", { date: "2026-03-02T00:00:00.000Z" }))[0],
    "2026-03-02"
  );
});

check("COMPAT: for values needing no escape, only quoting and the BOM differ", () => {
  const records = [rec("Acme"), rec("Beta", { amount: -12.5, direction: "income" })];
  const stripQuotes = csvText(records)
    .split("\n")
    .map((line) => line.split(",").map((f) => f.replace(/^"|"$/g, "")).join(","))
    .join("\n");
  assert.equal(stripQuotes, legacyCsv(records));
});

/* ================================================ 2. corruption defects == */

check("a comma inside vendor no longer shifts the columns", () => {
  const records = [rec("Acme, Inc.")];
  // Before: the row had SIX fields and Category landed under Amount.
  assert.equal(legacyCsv(records).split("\n")[1].split(",").length, 6);
  const line = csvText(records).split("\n")[1];
  assert.equal(line, '"2026-01-15","Acme, Inc.","office","187.77","expense"');
});

check("a double quote is doubled, not emitted raw", () => {
  const line = csvText([rec('Acme "Best" Ltd')]).split("\n")[1];
  assert.equal(line.includes('"Acme ""Best"" Ltd"'), true);
});

check("a newline inside a field no longer splits the record", () => {
  const records = [rec("Acme\nSecond line")];
  // Before: one record became two lines and the file lost a column.
  assert.equal(legacyCsv(records).split("\n").length, 3);
  const text = csvText(records);
  assert.equal(text.includes('"Acme\nSecond line"'), true);
  // The embedded newline is inside quotes, so the record count is still 1.
  assert.equal(text.split('"2026-01-15"').length - 1, 1);
});

check("a comma inside CATEGORY is escaped too (not just vendor)", () => {
  const line = csvText([rec("Acme", { category: "office, supplies" })]).split("\n")[1];
  assert.equal(line, '"2026-01-15","Acme","office, supplies","187.77","expense"');
});

/* ============================================== 3. formula injection ===== */

const INJECTION: Array<[string, string]> = [
  ["equals", "=1+1"],
  ["equals-hyperlink", '=HYPERLINK("http://evil","click")'],
  ["plus", "+1+1"],
  ["at", "@SUM(A1:A9)"],
  ["tab", "\t=cmd|' /C calc'!A0"],
  ["carriage-return", "\r=cmd|' /C calc'!A0"],
];

for (const [name, payload] of INJECTION) {
  check(`vendor payload (${name}) is neutralized in the export`, () => {
    const text = csvText([rec(payload)]);
    // The guarded cell opens with the text marker, so Excel shows it literally.
    assert.equal(text.includes(`"'${payload.replace(/"/g, '""')}"`), true, name);
    // And the raw, executable form is gone.
    assert.equal(text.includes(`,"${payload.replace(/"/g, '""')}"`), false, name);
  });
}

check("TAB and CR really can reach this column (OCR-derived vendor text)", () => {
  // `vendorName` is written by the documents pipeline from OCR output, so
  // control characters are reachable input, not a theoretical case.
  const text = csvText([rec("\t=x"), rec("\r=y")]);
  assert.equal(text.includes(`"'\t=x"`), true);
  assert.equal(text.includes(`"'\r=y"`), true);
});

check("a TEXTUAL leading dash is guarded", () => {
  const text = csvText([rec("-2+3"), rec("-"), rec("-Acme")]);
  assert.equal(text.includes(`"'-2+3"`), true);
  assert.equal(text.includes(`"'-"`), true);
  assert.equal(text.includes(`"'-Acme"`), true);
});

check("a NEGATIVE AMOUNT stays a bare number — no apostrophe, ever", () => {
  // The regression this exemption exists for: guarding "-187.77" would turn
  // every credit/income row in the export into text.
  for (const amount of [-187.77, -0.5, -1, -1e-3, 0, 250.5]) {
    const line = csvText([rec("Acme", { amount })]).split("\n")[1];
    const amountField = line.split(",").slice(-2)[0];
    assert.equal(amountField, `"${String(amount)}"`, String(amount));
    assert.equal(amountField.includes("'"), false, String(amount));
  }
});

check("guarding is decided per field: a hostile vendor never affects the amount", () => {
  const line = csvText([rec("=EVIL()", { amount: -99.5 })]).split("\n")[1];
  assert.equal(line, `"2026-01-15","'=EVIL()","office","-99.5","expense"`);
});

/* ================================================= 4. encoding / BOM ===== */

check("the body opens with the UTF-8 BOM", () => {
  const buf = buildFinancialRecordsCsvBuffer([rec("Acme")]);
  assert.deepEqual([...buf.subarray(0, 3)], BOM);
  // Exactly one BOM, at offset 0.
  assert.equal(buf.indexOf(Buffer.from(BOM), 3), -1);
});

check("Hebrew vendor and category survive as real UTF-8", () => {
  const buf = buildFinancialRecordsCsvBuffer([
    rec("סופר פארם", { category: "ציוד משרדי", direction: "הוצאה" }),
  ]);
  const text = buf.subarray(3).toString("utf8");
  assert.equal(text.includes("סופר פארם"), true);
  assert.equal(text.includes("ציוד משרדי"), true);
  assert.equal(text.includes("�"), false);
  // Round-trip the bytes through the canonical reader the Import Center uses.
  assert.equal(Buffer.from(text, "utf8").toString("utf8"), text);
});

check("an empty result set still produces a valid header-only file", () => {
  const buf = buildFinancialRecordsCsvBuffer([]);
  assert.deepEqual([...buf.subarray(0, 3)], BOM);
  assert.equal(
    buf.subarray(3).toString("utf8"),
    '"Date","Vendor","Category","Amount","Direction"'
  );
});

/* ================================================= 5. layer boundary ===== */

check("BOUNDARY: the CSV module imports no Prisma, auth or tenant code", () => {
  const src = fs.readFileSync("lib/reports/financial-records-csv.ts", "utf8");
  for (const needle of [
    "@/lib/prisma",
    "@prisma/client",
    "@/lib/auth",
    "@/lib/tenant/",
    "next/server",
  ]) {
    assert.equal(src.includes(needle), false, `must not import ${needle}`);
  }
});

check("STRUCTURAL: the route delegates and keeps no hand-rolled join(\",\")", () => {
  const raw = fs.readFileSync("app/api/reports/export/route.ts", "utf8");
  const blockComment = new RegExp(String.raw`/\*[\s\S]*?\*/`, "g");
  const lineComment = new RegExp(String.raw`^\s*//`);
  const src = raw
    .replace(blockComment, "")
    .split("\n")
    .filter((line) => !lineComment.test(line))
    .join("\n");

  assert.equal(
    src.includes("buildFinancialRecordsCsvBuffer"),
    true,
    "route must delegate to the canonical CSV builder"
  );
  assert.equal(
    src.includes('join(",")'),
    false,
    "a hand-rolled join reintroduces corruption and injection"
  );
  // The tenant's financial records must never sit in a shared cache or the
  // browser's disk cache after logout. The sibling accountant pack already
  // sets this; this endpoint did not until I-3.
  assert.equal(
    /"Cache-Control":\s*"private, no-store"/.test(src),
    true,
    "the CSV response must send Cache-Control: private, no-store"
  );

  // The auth / tenant / query path must be untouched by this fix.
  for (const needle of [
    "getCurrentUser",
    "runWithTenantContext",
    "withTenantTransaction",
    "tx.financialRecord.findMany",
  ]) {
    assert.equal(src.includes(needle), true, `route must still use ${needle}`);
  }
});

console.log(`\nFINANCIAL-RECORDS CSV VERIFY PASS — ${passed} checks green.`);
