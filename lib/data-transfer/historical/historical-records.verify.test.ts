/**
 * I-8B.6 — the historical READ path: what can be proven without a database.
 *
 * The tenant behaviour itself needs PostgreSQL, because the failure this guards
 * against is a PostgreSQL failure: under the restricted runtime role a SELECT
 * with no tenant context does not raise, it returns zero rows. That is proven in
 * `.i8b6/battery.mjs` against real PG17, through the same NOBYPASSRLS role
 * production runs as.
 *
 * What is proven here is the SHAPE of the read path: that it is read-only by
 * construction, that the tenant can only come from the session, that nothing on
 * it can reach billing, payments, the authority or the customer record, and that
 * paging is total and bounded.
 *
 * Run: npx tsx lib/data-transfer/historical/historical-records.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  clampHistoricalPage,
  historicalDayToUtc,
  HISTORICAL_RECORDS_MAX_FACETS,
  HISTORICAL_RECORDS_MAX_PAGE,
  HISTORICAL_RECORDS_MAX_REVERSED_BY,
  HISTORICAL_RECORDS_PAGE_SIZE,
  EMPTY_HISTORICAL_FILTERS,
} from "@/lib/data-transfer/historical/historical-records";

let passed = 0;
const failures: string[] = [];

function check(label: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failures.push(label);
    console.log(`FAIL  ${label} — ${(error as Error).message}`);
  }
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

const SERVICE = "lib/data-transfer/historical/historical-records.ts";
const LIST_ROUTE = "app/api/data-transfer/historical/records/route.ts";
const DETAIL_ROUTE = "app/api/data-transfer/historical/records/[id]/route.ts";
const TEMPLATE_ROUTE =
  "app/api/data-transfer/import/historical/template/route.ts";

console.log("\nI-8B.6 — historical records read path, structural guarantees\n");

/* ================================================== 1. read only ========= */

check("the service performs no write of any kind", () => {
  const src = codeOf(SERVICE);
  for (const verb of [
    "create(",
    "createMany",
    "update(",
    "updateMany",
    "upsert",
    "delete(",
    "deleteMany",
    "$executeRaw",
    "$executeRawUnsafe",
  ]) {
    assert.ok(!src.includes(verb), `the read service calls ${verb}`);
  }
});

check("the service reaches exactly one model, and it is the historical one", () => {
  const src = codeOf(SERVICE);
  const models = [...src.matchAll(/tx\.([A-Za-z]+)\./g)].map((m) => m[1]);
  assert.ok(models.length > 0, "no model access found at all");
  assert.deepEqual([...new Set(models)], ["historicalFiscalDocument"]);
});

check("neither route exposes a mutating method", () => {
  for (const route of [LIST_ROUTE, DETAIL_ROUTE, TEMPLATE_ROUTE]) {
    const src = codeOf(route);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.ok(
        !new RegExp(`export\\s+async\\s+function\\s+${method}\\b`).test(src),
        `${route} exports ${method}`
      );
    }
    assert.match(src, /export\s+async\s+function\s+GET\b/, `${route} has no GET`);
  }
});

/* ================================================== 2. the tenant ======== */

check("the tenant comes from the session, never from the request", () => {
  for (const route of [LIST_ROUTE, DETAIL_ROUTE]) {
    const src = codeOf(route);
    assert.match(src, /getCurrentUser\(req\)/, `${route} must resolve a session`);
    assert.match(
      src,
      /runWithTenantContext\(\{\s*businessId:\s*user\.businessId\s*\}/,
      `${route} must establish the SESSION tenant`
    );
    // No businessId may be read from the URL, the body or a header.
    assert.ok(
      !/businessId["']?\s*\)/.test(src.replace(/user\.businessId/g, "")),
      `${route} appears to read a businessId from the request`
    );
    assert.ok(
      !src.includes('params.get("businessId")') &&
        !src.includes("params.get('businessId')"),
      `${route} reads businessId from the query string`
    );
  }
});

check("every query runs inside the tenant transaction, not the global client", () => {
  const src = codeOf(SERVICE);
  assert.match(src, /withTenantTransaction/);
  // The global singleton must not appear at all: it carries no tenant GUC.
  assert.ok(!src.includes("@/lib/prisma"), "the service imports the global client");
  assert.ok(!/\bprisma\./.test(src), "the service queries the global client");
  // Prisma is imported for its types and Decimal only, never for a client.
  assert.ok(!src.includes("new PrismaClient"), "the service constructs a client");
});

check("the detail read cannot distinguish 'missing' from 'another tenant'", () => {
  const service = codeOf(SERVICE);
  // One `findFirst` scoped by businessId, and `null` for both outcomes.
  assert.match(service, /findFirst\(\{\s*where:\s*\{\s*businessId,\s*id\s*\}/);
  assert.match(service, /if\s*\(!row\)\s*return null;/);

  const route = codeOf(DETAIL_ROUTE);
  // A single not-found response, used for a bad id and for an absent record.
  assert.equal((route.match(/status:\s*404/g) ?? []).length, 1);
  assert.ok(
    !route.includes("403"),
    "a 403 here would confirm another business's record exists"
  );
});

/* ================================================== 3. the firewall ====== */

check("nothing on the read path can reach billing, payments or the authority", () => {
  const forbidden = [
    "billingDocument",
    "BillingDocument",
    "billingDocumentLine",
    "financialEvent",
    "paymentAllocation",
    "receiptPayment",
    "authoritySubmission",
    "BillingDocumentNumberSequence",
    "allocationNumber",
    "uniform",
  ];
  for (const file of [SERVICE, LIST_ROUTE, DETAIL_ROUTE, TEMPLATE_ROUTE]) {
    const src = codeOf(file);
    for (const needle of forbidden) {
      assert.ok(!src.includes(needle), `${file} references ${needle}`);
    }
  }
});

check("the read path neither creates nor links a customer", () => {
  for (const file of [SERVICE, LIST_ROUTE, DETAIL_ROUTE]) {
    const src = codeOf(file);
    // The snapshot columns are fine — they are evidence. `tx.customer` is not.
    assert.ok(!/tx\.customer\b/.test(src), `${file} queries the customer table`);
    assert.ok(!/\bcustomerId\b/.test(src), `${file} handles a customer id`);
  }
});

check("no internal handle is selected into the owner-facing shape", () => {
  const src = codeOf(SERVICE);
  const select = src.slice(src.indexOf("const LIST_SELECT"), src.indexOf("type ListRow"));
  for (const column of ["businessId", "documentId", "importRunId", "updatedAt"]) {
    assert.ok(!select.includes(column), `LIST_SELECT exposes ${column}`);
  }
  // The reversal id is selected only to derive a boolean, and is dropped.
  assert.match(src, /reversesLinked:\s*row\.reversesHistoricalDocumentId !== null/);
  assert.ok(
    !src.includes("reversesHistoricalDocumentId: row.reversesHistoricalDocumentId"),
    "the reversal id is handed to the client"
  );
});

/* ================================================== 4. paging =========== */

check("the ordering is TOTAL — a primary-key tie-break, not just a date", () => {
  const src = codeOf(SERVICE);
  const orderBy = src.slice(src.indexOf("const ORDER_BY"), src.indexOf("const LIST_SELECT"));
  assert.match(orderBy, /originalIssueDate/);
  assert.match(orderBy, /\{\s*id:\s*"desc"\s*\}/);
  // Undated rows last, so "newest first" means what it says.
  assert.match(orderBy, /nulls:\s*"last"/);
});

check("a page number is clamped into a real page, always", () => {
  assert.equal(clampHistoricalPage(1), 1);
  assert.equal(clampHistoricalPage(7), 7);
  assert.equal(clampHistoricalPage(0), 1);
  assert.equal(clampHistoricalPage(-40), 1);
  assert.equal(clampHistoricalPage(1.5), 1);
  assert.equal(clampHistoricalPage(NaN), 1);
  assert.equal(clampHistoricalPage(undefined), 1);
  assert.equal(clampHistoricalPage("3"), 1);
  assert.equal(clampHistoricalPage(90_000), HISTORICAL_RECORDS_MAX_PAGE);
});

check("the skip a clamped page produces is never negative", () => {
  for (const requested of [undefined, 0, -1, -999, 1.2, NaN, 10 ** 9]) {
    const page = clampHistoricalPage(requested);
    assert.ok((page - 1) * HISTORICAL_RECORDS_PAGE_SIZE >= 0, String(requested));
  }
});

check("every bound is a positive integer", () => {
  for (const [name, value] of [
    ["PAGE_SIZE", HISTORICAL_RECORDS_PAGE_SIZE],
    ["MAX_PAGE", HISTORICAL_RECORDS_MAX_PAGE],
    ["MAX_FACETS", HISTORICAL_RECORDS_MAX_FACETS],
    ["MAX_REVERSED_BY", HISTORICAL_RECORDS_MAX_REVERSED_BY],
  ] as const) {
    assert.ok(Number.isInteger(value) && value > 0, name);
  }
});

check("the whole list is never loaded — every multi-row read is bounded", () => {
  const src = codeOf(SERVICE);
  const reads = [
    ...src.matchAll(/(findMany|groupBy)\(\{[\s\S]*?\n      \}\)/g),
  ].map((m) => m[0]);
  assert.ok(reads.length >= 2, "expected the page read and the facet read");
  for (const call of reads) {
    assert.match(call, /take:/, `an unbounded read: ${call.slice(0, 70)}`);
  }
  // The nested reversal list is bounded too.
  assert.match(src, /take: HISTORICAL_RECORDS_MAX_REVERSED_BY/);
});

check("the source-system facet is grouped by PostgreSQL, not de-duped in memory", () => {
  // `findMany({ distinct })` post-processes, so a bounded take would drop a
  // source system that appears once in a long history.
  const src = codeOf(SERVICE);
  assert.match(src, /groupBy\(\{\s*by: \["sourceSystemCode"\]/);
  assert.ok(
    !src.includes('distinct: ["sourceSystemCode"]'),
    "the facet is de-duplicated after fetching"
  );
});

/* ================================================== 5. dates ============ */

check("a calendar day becomes UTC midnight, matching what the writer stored", () => {
  const day = historicalDayToUtc("2024-03-17");
  assert.ok(day !== null);
  assert.equal(day!.toISOString(), "2024-03-17T00:00:00.000Z");
});

check("a filter boundary does not shift by the server's timezone", () => {
  // The property that matters: the day goes in and the SAME day comes back out,
  // whatever the host offset is. A local-midnight construction fails this.
  for (const text of ["2024-01-01", "2024-12-31", "2024-02-29", "2000-02-29"]) {
    const day = historicalDayToUtc(text);
    assert.ok(day !== null, text);
    assert.equal(day!.toISOString().slice(0, 10), text);
  }
});

check("an impossible day is refused, never rolled forward", () => {
  for (const text of [
    "2025-02-30",
    "2023-02-29",
    "2100-02-29",
    "2024-13-01",
    "2024-00-10",
    "2024-04-31",
  ]) {
    assert.equal(historicalDayToUtc(text), null, text);
  }
});

check("a malformed day is refused rather than parsed loosely", () => {
  for (const text of [
    "",
    "17/03/2024",
    "2024-3-7",
    "2024-03-17T10:00:00Z",
    "yesterday",
    "2024-03-17 ",
  ]) {
    assert.equal(historicalDayToUtc(text), null, JSON.stringify(text));
  }
});

/* ================================================== 6. filters ========== */

check("no filter names a business", () => {
  assert.deepEqual(Object.keys(EMPTY_HISTORICAL_FILTERS).sort(), [
    "documentTypeCode",
    "issuedFrom",
    "issuedTo",
    "originalDocumentNumber",
    "sourceSystemCode",
  ]);
  for (const value of Object.values(EMPTY_HISTORICAL_FILTERS)) {
    assert.equal(value, null);
  }
});

check("the type filter is closed to the engine's own vocabulary", () => {
  const src = codeOf(LIST_ROUTE);
  assert.match(src, /HISTORICAL_DOCUMENT_TYPES/);
  assert.match(src, /includes\(typeRaw\)/);
});

check("a filter value is bounded, and is never echoed back on failure", () => {
  const src = codeOf(LIST_ROUTE);
  assert.match(src, /MAX_FILTER_LENGTH/);
  // The error branch logs the error NAME only — a filter value can be a
  // customer's invoice number, and that does not belong in a log line.
  assert.match(src, /error instanceof Error \? error\.name : "UnknownError"/);
  assert.ok(
    !/console\.error\([^)]*params/s.test(src),
    "a filter value reaches the log"
  );
});

/* ================================================== 7. the template ===== */

check("the historical template has its own route and takes no domain", () => {
  const src = codeOf(TEMPLATE_ROUTE);
  assert.match(src, /buildHistoricalImportTemplate/);
  // No domain parameter: the capability is the route, not a value in a list.
  assert.ok(!src.includes("isTemplateDomainId"), "the route gates on a domain list");
  assert.ok(!src.includes("isExportableDomainId"), "the route gates on a domain list");
  assert.ok(!src.includes('searchParams.get("domain")'), "the route takes a domain");
  // And it reads no business data, so nothing tenant-scoped is needed.
  assert.ok(!src.includes("runWithTenantContext"));
  assert.ok(!src.includes("withTenantTransaction"));
});

check("the shared template route still refuses the historical domain", () => {
  const src = codeOf("app/api/data-transfer/template/route.ts");
  assert.match(src, /isTemplateDomainId\(domain\)/);
  assert.ok(
    !src.includes("historical"),
    "the shared route learned about the historical domain"
  );
});

console.log(
  `\n  ${passed} checks passed, ${failures.length} failed\n`
);
if (failures.length > 0) {
  failures.forEach((f) => console.log(`  FAILED: ${f}`));
  process.exitCode = 1;
}
