/**
 * Tabular Export (I-3) — deterministic verifier.
 *
 * NO database and NO network: the descriptors' `readPage` is exercised against
 * an in-memory fake `tx` that records the query it was given. That is a
 * deliberate choice, not a shortcut — it lets the BLOCKING CI job assert the
 * properties that actually matter (keyset paging, tenant filtering, read-only,
 * column projection) on every push, instead of only where a database exists.
 * Cross-tenant behaviour against real Postgres RLS is proven separately by the
 * D2/P7 tenant matrix.
 *
 * Run: npx tsx lib/data-transfer/export/export.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { DATA_TRANSFER_DOMAINS } from "@/lib/data-transfer/domains";
import {
  EXPORTABLE_DOMAIN_IDS,
  EXPORT_DESCRIPTORS,
  getExportDescriptor,
  isExportableDomainId,
} from "@/lib/data-transfer/export/export-registry";
import { parseExportRequest } from "@/lib/data-transfer/export/export-request";
import {
  EXPORT_BATCH_SIZE,
  EXPORT_MAX_DURATION_SECONDS,
  EXPORT_MAX_ROWS_PER_DOMAIN,
  EXPORT_MAX_ROWS_TOTAL,
} from "@/lib/data-transfer/export/export-config";
import {
  buildExportArtifact,
  buildExportFilename,
  israelDateStamp,
} from "@/lib/data-transfer/export/export-package";
import { LEAD_DORMANT_FIELDS } from "@/lib/data-transfer/export/domains/leads.export";
import { readCsvTable } from "@/lib/data-transfer/format/csv-reader";
import { readXlsxTable } from "@/lib/data-transfer/format/xlsx-reader";
import { CSV_FORMULA_GUARD_PREFIX } from "@/lib/data-transfer/format/csv-writer";
import type { ExportedDomainTable } from "@/lib/data-transfer/export/export-runner";
import type { TenantTx } from "@/lib/tenant/transaction";

let passed = 0;

function check(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

/**
 * Read a source file with comments stripped.
 *
 * The structural checks below scan for forbidden constructs, and these files
 * DOCUMENT the constructs they refuse to use ("nothing here writes: no
 * createMany..."). A naive scan would fire on the very explanation of the rule.
 */
function readCode(path: string): string {
  const blockComment = new RegExp(String.raw`/\*[\s\S]*?\*/`, "g");
  const lineComment = new RegExp(String.raw`^\s*//`);
  return fs
    .readFileSync(path, "utf8")
    .replace(blockComment, "")
    .split("\n")
    .filter((line) => !lineComment.test(line))
    .join("\n");
}

async function checkAsync(label: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

// tsx compiles this file to CJS (the repo is not "type": "module"), so every
// case lives inside main() rather than at top level.
async function main(): Promise<void> {

/* ============================================ 1. registry + scope ======== */

check("the export registry is exactly the TABULAR domains, derived not hardcoded", () => {
  const tabular = DATA_TRANSFER_DOMAINS.filter((d) => d.kind === "tabular").map(
    (d) => d.id
  );
  assert.deepEqual([...EXPORTABLE_DOMAIN_IDS], tabular);
  assert.deepEqual(tabular, ["customers", "suppliers", "leads", "inventory"]);
});

check("Documents and issued documents are NOT tabular-exportable", () => {
  assert.equal(isExportableDomainId("documents"), false);
  assert.equal(isExportableDomainId("issued-documents"), false);
  assert.equal(isExportableDomainId("nope"), false);
  assert.equal(isExportableDomainId(""), false);
});

check("every descriptor has Hebrew headers, an ASCII slug and a legal sheet name", () => {
  const hebrew = /[֐-׿]/;
  for (const d of EXPORT_DESCRIPTORS) {
    assert.equal(/^[a-z][a-z0-9-]*$/.test(d.fileSlug), true, d.id);
    assert.equal(d.sheetName.length <= 31, true, d.id);
    assert.equal(hebrew.test(d.sheetName), true, d.id);
    assert.equal(d.columns.length > 0, true, d.id);
    for (const c of d.columns) {
      assert.equal(hebrew.test(c.header), true, `${d.id}: ${c.header}`);
    }
    // Header labels must be unique inside a sheet, or a later import cannot
    // map them back unambiguously.
    assert.equal(
      new Set(d.columns.map((c) => c.header)).size,
      d.columns.length,
      `${d.id} has duplicate headers`
    );
  }
});

check("no internal field name reaches a column header", () => {
  const forbidden = [
    "businessId",
    "customerId",
    "categoryId",
    "updatedAt",
    "imageUrl",
    "id",
    "Prisma",
  ];
  for (const d of EXPORT_DESCRIPTORS) {
    for (const c of d.columns) {
      for (const word of forbidden) {
        assert.equal(
          c.header.includes(word),
          false,
          `${d.id} header "${c.header}" contains "${word}"`
        );
      }
    }
  }
});

/* ================================ 2. Leads dormant fields (re-derived) === */

check("leads-dormant-fields: the six omitted columns still have NO writer", () => {
  // This is the guard that keeps the omission honest. It re-derives the
  // evidence rather than trusting the decision made at design time: if a real
  // product flow starts writing one of these, THIS FAILS, and the export must
  // be re-evaluated.
  //
  // The sweep is DISCOVERED, not a hardcoded file list. The Leads domain keeps
  // growing (lead-intelligence, lead-auto-capture arrived after this guard was
  // written), and a fixed list quietly goes blind on whatever was added last.
  //
  // Matching is scoped to `lead` WRITE payloads specifically, because
  // `Conversation.currentStage` and `Conversation.temperatureScore` are real,
  // actively-written fields on a DIFFERENT table — a file-wide scan would fire
  // on `tx.conversation.create({ currentStage: "NEW" })` and be disabled as a
  // false alarm within a week.
  const sources: string[] = [];
  const sweep = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) sweep(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        sources.push(full);
      }
    }
  };
  sweep("lib/services/crm");
  sweep("app/api/leads");
  sweep("app/api/conversations");

  assert.equal(sources.length >= 5, true, "lead write paths not found to scan");

  const blockComment = new RegExp(String.raw`/\*[\s\S]*?\*/`, "g");
  const lineComment = new RegExp(String.raw`^\s*//`);
  // `tx.lead.create({ ... })` / `.lead.updateMany({ ... })` and friends.
  const LEAD_WRITE = /\.lead\.(create|createMany|update|updateMany|upsert)\s*\(\s*\{/g;

  let scannedWrites = 0;

  for (const path of sources) {
    const src = fs
      .readFileSync(path, "utf8")
      .replace(blockComment, "")
      .split("\n")
      .filter((line) => !lineComment.test(line))
      .join("\n");

    // Any `data.<field> =` in a lead file is a write no matter where it sits.
    for (const field of LEAD_DORMANT_FIELDS) {
      assert.equal(
        new RegExp(String.raw`\bdata\.${field}\s*=`).test(src),
        false,
        `${path} assigns Lead.${field} — re-evaluate whether it belongs in the export`
      );
    }

    // And the payload of every lead write is inspected on its own.
    LEAD_WRITE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = LEAD_WRITE.exec(src)) !== null) {
      scannedWrites += 1;
      // Take a generous window after the call opens; brace-matching a TS blob
      // is overkill when the payload is always the first thing inside.
      const body = src.slice(match.index, match.index + 1200);
      for (const field of LEAD_DORMANT_FIELDS) {
        assert.equal(
          new RegExp(String.raw`^\s*${field}\s*:`, "m").test(body),
          false,
          `${path} writes Lead.${field} — re-evaluate whether it belongs in the export`
        );
      }
    }
  }

  // The sweep must actually have found lead writes, or it proves nothing.
  assert.equal(scannedWrites >= 3, true, `only ${scannedWrites} lead writes scanned`);
});

check("the Leads descriptor exports none of the dormant fields", () => {
  const src = fs.readFileSync(
    "lib/data-transfer/export/domains/leads.export.ts",
    "utf8"
  );
  // Inside the `select` block only — the constant listing them is expected.
  const selectBlock = /select:\s*\{([\s\S]*?)\},/.exec(src)?.[1] ?? "";
  assert.equal(selectBlock.length > 0, true);
  for (const field of LEAD_DORMANT_FIELDS) {
    assert.equal(
      new RegExp(String.raw`\b${field}\s*:\s*true`).test(selectBlock),
      false,
      `leads export selects dormant field ${field}`
    );
  }
});

/* ============================================= 3. request validation ===== */

check("a valid selection is normalized into registry order", () => {
  const parsed = parseExportRequest({
    domains: ["inventory", "customers", "customers"],
    format: "csv",
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    // Deduplicated, and NOT in the caller's order — two clients asking for the
    // same thing must get identical output.
    assert.deepEqual(parsed.request.domains, ["customers", "inventory"]);
    assert.equal(parsed.request.format, "csv");
  }
});

check("format defaults to xlsx when omitted", () => {
  const parsed = parseExportRequest({ domains: ["customers"] });
  assert.equal(parsed.ok && parsed.request.format, "xlsx");
});

check("malformed selections FAIL CLOSED with a specific code", () => {
  const cases: Array<[unknown, string]> = [
    [null, "INVALID_BODY"],
    ["customers", "INVALID_BODY"],
    [[], "INVALID_BODY"],
    [{ domains: "customers" }, "INVALID_BODY"],
    [{ domains: [] }, "NO_DOMAINS"],
    [{ domains: ["documents"] }, "UNKNOWN_DOMAIN"],
    [{ domains: ["issued-documents"] }, "UNKNOWN_DOMAIN"],
    [{ domains: ["../../etc/passwd"] }, "UNKNOWN_DOMAIN"],
    [{ domains: ["Customer"] }, "UNKNOWN_DOMAIN"],
    [{ domains: [null] }, "UNKNOWN_DOMAIN"],
    [{ domains: ["customers"], format: "pdf" }, "UNSUPPORTED_FORMAT"],
    [{ domains: ["customers"], format: 7 }, "UNSUPPORTED_FORMAT"],
    [{ domains: new Array(40).fill("customers") }, "TOO_MANY_DOMAINS"],
  ];
  for (const [body, code] of cases) {
    const parsed = parseExportRequest(body);
    assert.equal(parsed.ok, false, JSON.stringify(body));
    if (!parsed.ok) assert.equal(parsed.code, code, JSON.stringify(body));
  }
});

check("a rejection never echoes the offending value back", () => {
  const parsed = parseExportRequest({ domains: ["<script>alert(1)</script>"] });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.message.includes("script"), false);
});

check("the request contract has no tenant, table, column or limit field", () => {
  const src = readCode("lib/data-transfer/export/export-request.ts");
  for (const field of ["businessId", "tenant", "table", "columns", "limit", "where"]) {
    assert.equal(
      new RegExp(String.raw`record\.${field}|body\.${field}`).test(src),
      false,
      `request parser reads ${field} from the client`
    );
  }
});

/* ================================== 4. descriptors: keyset + tenant ===== */

type RecordedQuery = {
  where?: { businessId?: number; id?: { gt?: number } };
  orderBy?: { id?: string };
  take?: number;
  select?: Record<string, unknown>;
};

/** Fake tx that records the query and returns synthetic rows. */
function fakeTx(rows: Record<string, unknown>[], sink: RecordedQuery[]): TenantTx {
  const model = {
    findMany: async (args: RecordedQuery) => {
      sink.push(args);
      return rows;
    },
  };
  return {
    customer: model,
    supplier: model,
    lead: model,
    inventoryItem: model,
  } as unknown as TenantTx;
}

await checkAsync("every descriptor pages by KEYSET and filters by tenant", async () => {
  for (const descriptor of EXPORT_DESCRIPTORS) {
    const sink: RecordedQuery[] = [];
    await descriptor.readPage(fakeTx([], sink), 42, 17, 500);
    const q = sink[0];
    assert.equal(q.where?.businessId, 42, descriptor.id);
    assert.equal(q.where?.id?.gt, 17, descriptor.id);
    assert.equal(q.orderBy?.id, "asc", descriptor.id);
    assert.equal(q.take, 500, descriptor.id);
    // OFFSET paging can skip or repeat rows while data changes mid-export.
    assert.equal("skip" in q, false, descriptor.id);
  }
});

await checkAsync("an empty page reports lastId null so the runner stops", async () => {
  for (const descriptor of EXPORT_DESCRIPTORS) {
    const page = await descriptor.readPage(fakeTx([], []), 1, 0, 500);
    assert.deepEqual(page.cells, [], descriptor.id);
    assert.equal(page.lastId, null, descriptor.id);
  }
});

await checkAsync("cells align 1:1 with the declared columns", async () => {
  const rows: Record<string, Record<string, unknown>[]> = {
    customers: [{ id: 5, name: "אבי", phone: "972501234567", createdAt: new Date() }],
    suppliers: [{ id: 6, name: "ספק", createdAt: new Date() }],
    leads: [{ id: 7, customerName: "ליד", status: "NEW", createdAt: new Date() }],
    inventory: [{ id: 8, name: "פריט", unitType: "UNIT", currentQuantity: 3, minimumQuantity: 0, createdAt: new Date() }],
  };
  for (const descriptor of EXPORT_DESCRIPTORS) {
    const page = await descriptor.readPage(
      fakeTx(rows[descriptor.id] ?? [], []),
      1,
      0,
      500
    );
    assert.equal(page.cells.length, 1, descriptor.id);
    assert.equal(
      page.cells[0].length,
      descriptor.columns.length,
      `${descriptor.id}: ${page.cells[0].length} cells vs ${descriptor.columns.length} columns`
    );
    assert.equal(page.lastId, rows[descriptor.id][0].id, descriptor.id);
  }
});

await checkAsync("owner-facing values: phone readable, enum in Hebrew, empty stays empty", async () => {
  const customers = getExportDescriptor("customers");
  const page = await customers.readPage(
    fakeTx(
      [
        {
          id: 1,
          name: "אבי כהן",
          phone: "972501234567",
          email: null,
          city: null,
          legalName: null,
          taxId: null,
          taxIdType: "AUTHORIZED_DEALER",
          notes: null,
          isActive: true,
          createdAt: new Date(Date.UTC(2026, 0, 15)),
        },
      ],
      []
    ),
    1,
    0,
    500
  );
  const [name, phone, email, , , taxType, , , active] = page.cells[0];
  assert.equal(name, "אבי כהן");
  assert.equal(phone, "050-123-4567", "stored canonical phone must display readably");
  assert.equal(email, null, "missing value must be an EMPTY cell, not 'null'");
  assert.equal(taxType, "עוסק מורשה");
  assert.equal(active, "כן");
});

await checkAsync("inventory keeps a zero quantity and blanks a truly missing one", async () => {
  const inventory = getExportDescriptor("inventory");
  const page = await inventory.readPage(
    fakeTx(
      [
        {
          id: 1,
          name: "פריט",
          unitType: "KG",
          currentQuantity: 0,
          minimumQuantity: 0,
          reorderPoint: null,
          costPerUnit: null,
          isActive: true,
          createdAt: new Date(),
          category: { name: "ניקיון" },
        },
      ],
      []
    ),
    1,
    0,
    500
  );
  const cells = page.cells[0];
  assert.equal(cells[3], "ניקיון", "category must export as its NAME");
  assert.equal(cells[4], "ק״ג");
  assert.equal(cells[6], 0, "zero stock is a fact, not a blank");
  assert.equal(cells[8], null, "an unset reorder point must be blank, not 0");
});

check("no descriptor performs a write", () => {
  const forbidden = ["create(", "createMany", "update(", "updateMany", "upsert(", "delete(", "deleteMany", "$executeRaw"];
  const dir = "lib/data-transfer/export/domains";
  for (const file of fs.readdirSync(dir)) {
    const src = readCode(`${dir}/${file}`);
    for (const needle of forbidden) {
      assert.equal(src.includes(needle), false, `${file} contains ${needle}`);
    }
  }
});

check("the runner writes nothing and opens no long transaction", () => {
  const src = readCode("lib/data-transfer/export/export-runner.ts");
  for (const needle of ["create(", "createMany", "update(", "upsert(", "delete("]) {
    assert.equal(src.includes(needle), false, `runner contains ${needle}`);
  }
  // One short tenant transaction per PAGE, inside the paging loop.
  assert.equal(src.includes("withTenantTransaction"), true);
  assert.equal(src.includes("runWithTenantContext"), true);
});

check("engine limits live in one config module, not inline", () => {
  assert.equal(EXPORT_BATCH_SIZE, 500);
  assert.equal(EXPORT_MAX_ROWS_PER_DOMAIN > EXPORT_BATCH_SIZE, true);
  assert.equal(EXPORT_MAX_ROWS_TOTAL >= EXPORT_MAX_ROWS_PER_DOMAIN, true);
  for (const file of ["export-runner.ts", "export-package.ts"]) {
    const src = readCode(`lib/data-transfer/export/${file}`);
    assert.equal(
      /take:\s*\d+|LIMIT\s+\d+/.test(src),
      false,
      `${file} hardcodes a page size`
    );
  }
});

/* ===================================== 5. packaging: XLSX / CSV / ZIP === */

function table(
  id: "customers" | "suppliers",
  rows: (string | number | Date | null)[][]
): ExportedDomainTable {
  const descriptor = getExportDescriptor(id);
  return { id, descriptor, rows };
}

const AT = new Date(Date.UTC(2026, 8, 2, 21, 30)); // 2026-09-03 in Israel (UTC+3)

check("the filename date is the ISRAELI calendar day", () => {
  assert.equal(israelDateStamp(AT), "2026-09-03");
  assert.equal(israelDateStamp(new Date(Date.UTC(2026, 8, 2, 12, 0))), "2026-09-02");
});

check("file names are business-readable, ASCII, and carry no tenant name", () => {
  const one = buildExportFilename([table("customers", [])], "xlsx", AT);
  const many = buildExportFilename(
    [table("customers", []), table("suppliers", [])],
    "zip",
    AT
  );
  assert.equal(one, "dubiz-customers-2026-09-03.xlsx");
  assert.equal(many, "dubiz-export-2026-09-03.zip");
  for (const name of [one, many]) {
    assert.equal(/^[\x20-\x7e]+$/.test(name), true, name);
    assert.equal(/["\\/;\r\n]/.test(name), false, name);
  }
});

await checkAsync("ONE domain + XLSX -> one workbook, one sheet, typed cells", async () => {
  const artifact = await buildExportArtifact(
    [table("customers", [["אבי כהן", "050-123-4567", null, null, null, "עוסק מורשה", null, null, "כן", new Date(Date.UTC(2026, 0, 15))]])],
    "xlsx",
    AT
  );
  assert.equal(artifact.filename, "dubiz-customers-2026-09-03.xlsx");
  assert.equal(
    artifact.contentType,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );

  const sheet = await readXlsxTable(artifact.body);
  assert.equal(sheet.sheetName, "לקוחות");
  assert.equal(sheet.headers[0], "שם");
  assert.equal(sheet.rows[0][0], "אבי כהן");
  assert.equal(sheet.rows[0][9] instanceof Date, true, "a date column must be a real date");
});

await checkAsync("ALL FOUR domains + XLSX -> ONE workbook with four sheets", async () => {
  const tables = EXPORT_DESCRIPTORS.map((d) => ({
    id: d.id,
    descriptor: d,
    rows: [d.columns.map(() => "x")],
  })) as ExportedDomainTable[];

  const artifact = await buildExportArtifact(tables, "xlsx", AT);
  assert.equal(artifact.filename, "dubiz-export-2026-09-03.xlsx");

  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(artifact.body as unknown as ArrayBuffer);
  assert.deepEqual(
    wb.worksheets.map((w) => w.name),
    ["לקוחות", "ספקים", "לידים", "מלאי"]
  );
  for (const ws of wb.worksheets) {
    assert.equal(ws.views[0].rightToLeft, true, ws.name);
    assert.equal(ws.views[0].state, "frozen", ws.name);
    assert.equal(ws.getRow(1).getCell(1).font?.bold, true, ws.name);
    assert.equal(ws.autoFilter != null, true, ws.name);
  }
});

await checkAsync("ONE domain + CSV -> a single .csv, BOM, readable back", async () => {
  const artifact = await buildExportArtifact(
    [table("customers", [["אבי כהן", "050-123-4567", null, null, null, null, null, null, "כן", null]])],
    "csv",
    AT
  );
  assert.equal(artifact.filename, "dubiz-customers-2026-09-03.csv");
  assert.equal(artifact.contentType, "text/csv; charset=utf-8");
  assert.deepEqual([...artifact.body.subarray(0, 3)], [0xef, 0xbb, 0xbf]);

  const parsed = readCsvTable(artifact.body);
  assert.equal(parsed.headers[0], "שם");
  assert.equal(parsed.rows[0][0], "אבי כהן");
});

await checkAsync("MANY domains + CSV -> a .zip of one .csv per domain", async () => {
  const artifact = await buildExportArtifact(
    [table("customers", []), table("suppliers", [])],
    "csv",
    AT
  );
  assert.equal(artifact.filename, "dubiz-export-2026-09-03.zip");
  assert.equal(artifact.contentType, "application/zip");
  // PK zip signature, and both member names present in the central directory.
  assert.deepEqual([...artifact.body.subarray(0, 2)], [0x50, 0x4b]);
  const raw = artifact.body.toString("latin1");
  assert.equal(raw.includes("dubiz-customers-2026-09-03.csv"), true);
  assert.equal(raw.includes("dubiz-suppliers-2026-09-03.csv"), true);
  // NOT a stacked multi-table CSV.
  assert.equal(artifact.filename.endsWith(".csv"), false);
});

await checkAsync("an empty domain exports headers only — never an error", async () => {
  const xlsx = await buildExportArtifact([table("customers", [])], "xlsx", AT);
  const sheet = await readXlsxTable(xlsx.body);
  assert.equal(sheet.headers.length, getExportDescriptor("customers").columns.length);
  assert.equal(sheet.rows.length, 0);

  const csv = await buildExportArtifact([table("customers", [])], "csv", AT);
  const parsed = readCsvTable(csv.body);
  assert.equal(parsed.rows.length, 0);
  assert.equal(parsed.headers[0], "שם");
});

/* ============================================ 6. hostile cell content === */

const HOSTILE_ROW = [
  '=HYPERLINK("http://evil","x")',
  "+1+1",
  "@SUM(A1:A9)",
  "\t=cmd|' /C calc'!A0",
  'שם עם "מרכאות", פסיק\nושורה חדשה',
  "-2+3",
  "-187.77",
  "0501234567",
  "כן",
  null,
];

await checkAsync("CSV export neutralizes formulas and survives quotes/commas/newlines", async () => {
  const artifact = await buildExportArtifact(
    [table("customers", [HOSTILE_ROW])],
    "csv",
    AT
  );
  const text = artifact.body.subarray(3).toString("utf8");
  for (const payload of ['=HYPERLINK("http://evil","x")', "+1+1", "@SUM(A1:A9)", "-2+3"]) {
    assert.equal(
      text.includes(`"${CSV_FORMULA_GUARD_PREFIX}${payload.replace(/"/g, '""')}"`),
      true,
      payload
    );
  }
  // A numeric-looking negative stays a bare number.
  assert.equal(text.includes('"-187.77"'), true);
  assert.equal(text.includes(`"${CSV_FORMULA_GUARD_PREFIX}-187.77"`), false);

  // Round-trips: the embedded comma / quote / newline do not corrupt the row.
  const parsed = readCsvTable(artifact.body);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].length, parsed.headers.length);
  assert.equal(
    String(parsed.rows[0][4]).includes('שם עם "מרכאות", פסיק\nושורה חדשה'),
    true
  );
});

await checkAsync("XLSX export stores formula-looking text as TEXT", async () => {
  const artifact = await buildExportArtifact(
    [table("customers", [HOSTILE_ROW])],
    "xlsx",
    AT
  );
  const sheet = await readXlsxTable(artifact.body);
  assert.equal(sheet.rows[0][0], '=HYPERLINK("http://evil","x")');
  assert.equal(sheet.rows[0][1], "+1+1");
  assert.equal(sheet.rows[0][2], "@SUM(A1:A9)");
});

/* ============================================= 7. route contract ======== */

check("the export route derives the tenant from the session only", () => {
  const src = readCode("app/api/data-transfer/export/route.ts");
  assert.equal(src.includes("getCurrentUser"), true);
  assert.equal(src.includes("user.businessId"), true);
  // No client-supplied tenant, in any spelling.
  assert.equal(/body\s*\.\s*businessId|businessId\s*:\s*body/.test(src), false);
  assert.equal(src.includes("searchParams.get(\"businessId\")"), false);
});

check("every export response forbids caching", () => {
  const src = fs.readFileSync("app/api/data-transfer/export/route.ts", "utf8");
  const returns = src.split("return ").slice(1);
  assert.equal(returns.length >= 4, true, "expected success + 400 + 413 + 500 paths");
  for (const block of returns) {
    assert.equal(
      block.includes("private, no-store") || block.includes("authRequiredResponse"),
      true,
      "an export response path is missing Cache-Control: private, no-store"
    );
  }
});

check("the route's maxDuration literal matches the engine config", () => {
  // Next validates route-segment config by STATIC ANALYSIS and rejects an
  // imported constant there ("Invalid segment configuration export detected"),
  // so this one number cannot live in export-config.ts with the others. This
  // check is what keeps the literal and the config from drifting apart.
  const src = readCode("app/api/data-transfer/export/route.ts");
  const match = /export const maxDuration = (\d+);/.exec(src);
  assert.notEqual(match, null, "route must declare a LITERAL maxDuration");
  assert.equal(Number(match?.[1]), EXPORT_MAX_DURATION_SECONDS);
});

check("the legacy /api/reports/export also forbids caching now", () => {
  const src = fs.readFileSync("app/api/reports/export/route.ts", "utf8");
  assert.equal(src.includes('"Cache-Control": "private, no-store"'), true);
});

/* ============================================ 8. release is coherent === */

check("RELEASED: the hub is listed and Export is a real link", () => {
  const release = fs.readFileSync(
    "components/settings/import-export/import-export-release.ts",
    "utf8"
  );
  assert.equal(/IMPORT_EXPORT_RELEASED = true/.test(release), true);

  const actions = fs.readFileSync(
    "components/settings/import-export/import-export-actions.ts",
    "utf8"
  );
  assert.equal(/key: "export",[\s\S]*?available: true/.test(actions), true);
});

check("an UNAVAILABLE hub action can never become a link or a dead control", () => {
  // Import stopped being pending in I-5, but the MECHANISM stays: it is how
  // Documents and Invoices import get presented before they exist. What is
  // pinned here is the contract — a not-yet-usable action is non-interactive
  // and says so, never a link to nothing, never a disabled-looking control.
  const src = readCode("components/settings/import-export/ImportExportPendingRow.tsx");
  assert.equal(src.includes("<Link"), false, "pending row must not navigate");
  assert.equal(src.includes("href"), false, "pending row must not carry an href");
  assert.equal(src.includes("<button"), false, "pending row must not look pressable");
  assert.equal(src.includes("disabled"), false, "a disabled control reads as a bug");
  assert.equal(src.includes("בקרוב"), true);

  // And the hub must still route unavailable actions through it.
  const hub = readCode("components/settings/import-export/ImportExportHub.tsx");
  assert.equal(hub.includes("action.available"), true);
  assert.equal(hub.includes("ImportExportPendingRow"), true);
});

console.log(`\nTABULAR EXPORT VERIFY PASS — ${passed} checks green.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
