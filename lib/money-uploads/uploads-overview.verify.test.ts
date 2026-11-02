/**
 * העלאת דוחות וקבצים (/money/uploads, S1-B M3) — the pure read model, plus static checks on the reads behind it.
 * Pure: no database, no network; `now` is fixed.
 *
 *   npm run verify:money-uploads
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  ATTENTION_WINDOW_MS,
  HISTORY_LIMIT,
  TABULAR_IMPORT_HREF,
  bankModeOf,
  buildUploadsOverview,
  deriveAttention,
  domainLabel,
  legacyBatchToEntry,
  mergeHistory,
  runToEntry,
  type ImportRunInput,
  type LegacyBatchInput,
} from "./uploads-overview";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n    ${e instanceof Error ? e.message : String(e)}`);
  }
}

const NOW = new Date("2026-10-27T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function run(over: Partial<ImportRunInput> & { id: number }): ImportRunInput {
  return {
    domain: "customers",
    status: "COMPLETED",
    totalRows: 10,
    createdCount: 10,
    skippedCount: 0,
    failedCount: 0,
    startedAt: minutesAgo(10),
    completedAt: minutesAgo(9),
    ...over,
  };
}

function batch(over: Partial<LegacyBatchInput> & { importBatchId: string }): LegacyBatchInput {
  return {
    lineCount: 3,
    firstBookedAt: new Date("2026-09-01T12:00:00.000Z"),
    lastBookedAt: new Date("2026-09-30T12:00:00.000Z"),
    createdAt: minutesAgo(30),
    account: null,
    ...over,
  };
}

console.log("\n1. bank card routing — the server's decision only");

check("OFF → legacy (/payables/bank)", () => assert.equal(bankModeOf("OFF"), "legacy"));
check("ON → b1 (/payables/bank/import)", () => assert.equal(bankModeOf("ON"), "b1"));
check("UNKNOWN → unknown (no link; never legacy, never b1)", () => assert.equal(bankModeOf("UNKNOWN"), "unknown"));
check("the overview carries the mode", () => {
  for (const [state, mode] of [["ON", "b1"], ["OFF", "legacy"], ["UNKNOWN", "unknown"]] as const) {
    const o = buildUploadsOverview({ bankState: state, runs: [], legacyBatches: [], now: NOW, importAvailable: true });
    assert.equal(o.bank.mode, mode);
    assert.equal(o.historyAvailable, true);
    assert.deepEqual(o.history, []);
    assert.deepEqual(o.attention, []);
  }
});
check("a history read that failed never takes the bank card with it", () => {
  for (const [runs, legacyBatches] of [[null, []], [[], null], [null, null]] as const) {
    const o = buildUploadsOverview({ bankState: "OFF", runs, legacyBatches, now: NOW, importAvailable: true });
    assert.equal(o.bank.mode, "legacy", "the bank route is the flag's decision alone");
    assert.equal(o.historyAvailable, false, "a failed read says so");
    assert.deepEqual(o.history, [], "no partial history passed off as complete");
    assert.deepEqual(o.attention, [], "no attention derived from a history that was not read");
  }
});
check("a failed history read is not an empty history", () => {
  const failed = buildUploadsOverview({ bankState: "OFF", runs: null, legacyBatches: [], now: NOW, importAvailable: true });
  const empty = buildUploadsOverview({ bankState: "OFF", runs: [], legacyBatches: [], now: NOW, importAvailable: true });
  assert.notEqual(failed.historyAvailable, empty.historyAvailable);
});

console.log("\n2. domain labels");

check("every domain the ledger writes has a Hebrew label", () => {
  const expected: Record<string, string> = {
    bank_statement: "דף חשבון בנק",
    customers: "ייבוא לקוחות",
    suppliers: "ייבוא ספקים",
    leads: "ייבוא לידים",
    inventory: "ייבוא מלאי",
    documents: "ייבוא מסמכים",
    "historical-documents": "היסטוריה ממערכת קודמת",
  };
  for (const [d, label] of Object.entries(expected)) assert.equal(domainLabel(d), label, d);
});
check("an unknown domain gets a neutral label, never the raw string", () => {
  assert.equal(domainLabel("something_new"), "קליטת קובץ");
});

console.log("\n3. history entries");

check("a run maps ids, status, counts and dates — and says the file was not stored", () => {
  const e = runToEntry(run({ id: 7, domain: "bank_statement", createdCount: 40, skippedCount: 2, failedCount: 0 }));
  assert.equal(e.id, "run-7");
  assert.equal(e.source, "import_run");
  assert.equal(e.typeLabel, "דף חשבון בנק");
  assert.equal(e.statusLabel, "הושלם");
  assert.deepEqual(e.counts, { total: 10, created: 40, skipped: 2, failed: 0 });
  assert.equal(e.legacyPath, false);
  assert.equal(e.sourceFileStored, false);
  assert.equal(e.period, null);
});
check("status labels", () => {
  assert.equal(runToEntry(run({ id: 1, status: "PARTIAL" })).statusLabel, "הושלם חלקית");
  assert.equal(runToEntry(run({ id: 1, status: "FAILED" })).statusLabel, "נכשל");
  assert.equal(runToEntry(run({ id: 1, status: "EXECUTING", completedAt: null })).statusLabel, "בתהליך");
});
check("a legacy batch: RECORDED (never 'הושלם'), lines added, transaction period, old path, file not stored", () => {
  const e = legacyBatchToEntry(batch({ importBatchId: "upl-abc", lineCount: 12 }));
  assert.equal(e.id, "upl-abc");
  assert.equal(e.source, "legacy_bank_upload");
  assert.equal(e.domain, "bank_statement");
  assert.equal(e.status, "RECORDED");
  assert.equal(e.statusLabel, "נקלט");
  assert.deepEqual(e.counts, { total: null, created: 12, skipped: null, failed: null });
  assert.deepEqual(e.period, { from: "2026-09-01", to: "2026-09-30" });
  assert.equal(e.legacyPath, true);
  assert.equal(e.sourceFileStored, false);
});
check("a legacy batch's account is the label and last four digits only", () => {
  const e = legacyBatchToEntry(batch({ importBatchId: "upl-x", account: { label: "עסקי", last4: "001234" } }));
  assert.deepEqual(e.account, { label: "עסקי", last4: "1234" });
});
check("no output carries an amount, a description or a bank coordinate", () => {
  const o = buildUploadsOverview({
    bankState: "OFF",
    runs: [run({ id: 1, status: "FAILED", createdCount: 0, failedCount: 3 })],
    legacyBatches: [batch({ importBatchId: "upl-1", account: { label: "חשבון", last4: "9876" } })],
    now: NOW,
    importAvailable: true,
  });
  const json = JSON.stringify(o);
  for (const banned of ["amount", "description", "counterparty", "reference", "accountNumber", "coordinates", "contentHash", "bankCode", "branchCode"]) {
    assert.equal(json.includes(`"${banned}"`), false, `output must not carry "${banned}"`);
  }
});

console.log("\n4. merge, sort, limit");

check("both sources, newest first", () => {
  const h = mergeHistory(
    [run({ id: 1, startedAt: minutesAgo(60) }), run({ id: 2, startedAt: minutesAgo(5) })],
    [batch({ importBatchId: "upl-a", createdAt: minutesAgo(30) })]
  );
  assert.deepEqual(h.map((e) => e.id), ["run-2", "upl-a", "run-1"]);
});
check(`at most ${HISTORY_LIMIT}`, () => {
  const runs = Array.from({ length: 15 }, (_, i) => run({ id: i + 1, startedAt: minutesAgo(i * 2) }));
  const batches = Array.from({ length: 15 }, (_, i) => batch({ importBatchId: `upl-${i}`, createdAt: minutesAgo(i * 2 + 1) }));
  const h = mergeHistory(runs, batches);
  assert.equal(h.length, HISTORY_LIMIT);
  for (let i = 1; i < h.length; i++) assert.equal(h[i - 1].at >= h[i].at, true, "sorted newest first");
});
check("equal timestamps keep a deterministic order", () => {
  const t = minutesAgo(3);
  const a = mergeHistory([run({ id: 1, startedAt: t }), run({ id: 2, startedAt: t })], []);
  const b = mergeHistory([run({ id: 2, startedAt: t }), run({ id: 1, startedAt: t })], []);
  assert.deepEqual(a.map((e) => e.id), b.map((e) => e.id));
});
check("empty in, empty out", () => assert.deepEqual(mergeHistory([], []), []));

console.log("\n5. attention — derived, action vs info");

check("a COMPLETED run needs nothing", () => {
  assert.deepEqual(deriveAttention([run({ id: 1 })], NOW, { importAvailable: true }), []);
});
check("FAILED tabular run → action to the import screen (correct the file)", () => {
  const [a] = deriveAttention([run({ id: 3, status: "FAILED", createdCount: 0, failedCount: 10 })], NOW, { importAvailable: true });
  assert.equal(a.kind, "action");
  assert.equal(a.action?.href, TABULAR_IMPORT_HREF);
  assert.equal(a.title, "ייבוא לקוחות: הקליטה נכשלה");
  assert.equal(a.detail.includes("קובץ מתוקן"), true);
});
check("PARTIAL tabular run with failed rows → action, the count in the title", () => {
  const [a] = deriveAttention([run({ id: 4, domain: "inventory", status: "PARTIAL", createdCount: 8, failedCount: 2 })], NOW, {
    importAvailable: true,
  });
  assert.equal(a.kind, "action");
  assert.equal(a.title, "ייבוא מלאי: 2 שורות לא נקלטו");
});
check("one failed row reads in the singular", () => {
  const [a] = deriveAttention([run({ id: 4, status: "PARTIAL", createdCount: 8, failedCount: 1 })], NOW, { importAvailable: true });
  assert.equal(a.title, "ייבוא לקוחות: שורה אחת לא נקלטה");
});
check("PARTIAL without failed rows needs nothing", () => {
  assert.deepEqual(deriveAttention([run({ id: 5, status: "PARTIAL", failedCount: 0 })], NOW, { importAvailable: true }), []);
});
check("a non-tabular failure (documents, historical, bank) is info — no action is claimed", () => {
  for (const domain of ["documents", "historical-documents", "bank_statement", "unknown_domain"]) {
    const [a] = deriveAttention([run({ id: 6, domain, status: "FAILED", createdCount: 0, failedCount: 1 })], NOW, {
      importAvailable: true,
    });
    assert.equal(a.kind, "info", domain);
    assert.equal(a.action, undefined, domain);
  }
});
check("import screen not available → no item links to it", () => {
  const [a] = deriveAttention([run({ id: 3, status: "FAILED", createdCount: 0, failedCount: 10 })], NOW, { importAvailable: false });
  assert.equal(a.kind, "info");
  assert.equal(a.action, undefined);
});
check("EXECUTING for more than an hour → info", () => {
  const [a] = deriveAttention([run({ id: 8, status: "EXECUTING", startedAt: minutesAgo(61), completedAt: null, createdCount: null })], NOW, {
    importAvailable: true,
  });
  assert.equal(a.kind, "info");
  assert.equal(a.title, "ייבוא לקוחות: הקליטה לא הסתיימה");
});
check("EXECUTING for less than an hour → nothing (still running)", () => {
  assert.deepEqual(
    deriveAttention([run({ id: 9, status: "EXECUTING", startedAt: minutesAgo(30), completedAt: null })], NOW, { importAvailable: true }),
    []
  );
});
check("older than 30 days → history, not attention", () => {
  const old = new Date(NOW.getTime() - ATTENTION_WINDOW_MS - 60_000);
  assert.deepEqual(
    deriveAttention([run({ id: 10, status: "FAILED", startedAt: old, failedCount: 1, createdCount: 0 })], NOW, { importAvailable: true }),
    []
  );
});
check("actions come before information", () => {
  const items = deriveAttention(
    [
      run({ id: 1, status: "EXECUTING", startedAt: minutesAgo(120), completedAt: null }),
      run({ id: 2, domain: "documents", status: "FAILED", failedCount: 1, createdCount: 0 }),
      run({ id: 3, status: "FAILED", failedCount: 1, createdCount: 0 }),
    ],
    NOW,
    { importAvailable: true }
  );
  assert.deepEqual(items.map((i) => i.kind), ["action", "info", "info"]);
  assert.equal(items[0].id, "run-3-failed");
});
check("legacy uploads never produce attention (they have no outcome record)", () => {
  const o = buildUploadsOverview({
    bankState: "OFF",
    runs: [],
    legacyBatches: [batch({ importBatchId: "upl-1" })],
    now: NOW,
    importAvailable: true,
  });
  assert.deepEqual(o.attention, []);
  assert.equal(o.history.length, 1);
});

console.log("\n6. the reads behind it (static)");

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const service = strip(fs.readFileSync("lib/money-uploads/uploads-overview.service.ts", "utf8"));
const store = strip(fs.readFileSync("lib/data-transfer/import/execute/import-run-store.ts", "utf8"));
const route = strip(fs.readFileSync("app/api/money/uploads/route.ts", "utf8"));

check("the service writes nothing", () => {
  for (const w of [".create(", ".createMany(", ".update(", ".updateMany(", ".upsert(", ".delete(", ".deleteMany(", "$executeRaw"]) {
    assert.equal(service.includes(w), false, `service must not call ${w}`);
  }
});
check("the service never reaches the ledger tables itself (CI-IL-14)", () => {
  assert.equal(/importRun(Row)?\./.test(service), false);
  assert.equal(service.includes("listRecentImportRuns"), true);
});
check("the legacy grouping aggregates counts and dates only", () => {
  const start = service.indexOf("externalTransaction.groupBy(");
  const body = service.slice(start, service.indexOf("});", start));
  assert.equal(start >= 0, true);
  for (const banned of ["amount", "description", "counterpartyName", "reference"]) {
    assert.equal(body.includes(banned), false, `groupBy must not touch ${banned}`);
  }
  assert.equal(body.includes('startsWith: LEGACY_BATCH_PREFIX'), true);
  assert.equal(body.includes('source: "OWNER_UPLOAD"'), true);
  assert.equal(body.includes("businessId"), true);
});
check("the bank account is read as label + last four only", () => {
  const start = service.indexOf("businessBankAccount.findMany(");
  const body = service.slice(start, service.indexOf("})", start));
  assert.equal(body.includes("select: { id: true, label: true, accountLast4: true }"), true);
  assert.equal(/coordinates|fingerprint/.test(body), false);
});
check("the ledger read is tenant-bound, read-only, and selects no hash", () => {
  const start = store.indexOf("export async function listRecentImportRuns");
  const body = store.slice(start);
  assert.equal(start >= 0, true);
  assert.equal(body.includes("withTenantTransaction"), true);
  assert.equal(body.includes("where: { businessId }"), true);
  assert.equal(/Hash|retryKey|importRunRow|\.create\(|\.update\(/.test(body), false);
});
check("each history read fails on its own; the flag read is not wrapped (it is already fail-closed)", () => {
  assert.equal(/listRecentImportRuns\(businessId, HISTORY_LIMIT\)\.catch\(/.test(service), true);
  assert.equal(/listLegacyBankBatches\(businessId, HISTORY_LIMIT\)\.catch\(/.test(service), true);
  assert.equal(/bankFileImportState\(businessId\)\.catch\(/.test(service), false);
  // The failure is logged by name only — a database error message can carry configuration.
  assert.equal(service.includes('e instanceof Error ? e.name : "unknown"'), true);
  assert.equal(/e\.message/.test(service), false);
});
check("Z / settlement cards: a link ONLY for an explicit ON; OFF, UNKNOWN and absent keep them closed", () => {
  const base = { bankState: "OFF" as const, runs: [], legacyBatches: [], now: NOW, importAvailable: true };
  assert.deepEqual(buildUploadsOverview(base).revenueReports, { z: false, settlement: false });
  assert.deepEqual(buildUploadsOverview({ ...base, revenueReportStates: { z: "ON", settlement: "UNKNOWN" } }).revenueReports, { z: true, settlement: false });
  assert.deepEqual(buildUploadsOverview({ ...base, revenueReportStates: { z: "OFF", settlement: "ON" } }).revenueReports, { z: false, settlement: true });
  // A history that could not be read neither closes nor opens a card: the cards are the flag's decision alone.
  assert.deepEqual(buildUploadsOverview({ ...base, runs: null, revenueReportStates: { z: "ON", settlement: "ON" } }).revenueReports, { z: true, settlement: true });
});
check("history labels for the revenue report runs", () => {
  assert.equal(domainLabel("z_report"), "דוח Z מהקופה");
  assert.equal(domainLabel("settlement_report"), "דוח סליקה");
});
check("the flag reads for the Z / settlement cards are fail-closed and not wrapped", () => {
  assert.equal(service.includes('revenueReportUploadState(businessId, "z")'), true);
  assert.equal(service.includes('revenueReportUploadState(businessId, "settlement")'), true);
  assert.equal(/revenueReportUploadState\([^)]*\)\.catch\(/.test(service), false);
});
check("the screen: Z / settlement stay SoonCards unless the server said ON", () => {
  const screen = fs.readFileSync("features/money-uploads/uploads-screen.tsx", "utf8");
  assert.equal(screen.includes('load.state === "ready" && load.data.revenueReports ? load.data.revenueReports : { z: false, settlement: false }'), true);
  assert.equal(screen.includes('href="/money/revenue-reports/z/upload"'), true);
  assert.equal(screen.includes('href="/money/revenue-reports/settlement/upload"'), true);
  assert.equal((screen.match(/<SoonCard /g) ?? []).length, 2);
});
check("the route takes the business from the session and never caches", () => {
  assert.equal(route.includes("getCurrentUser(req)"), true);
  assert.equal(route.includes("getUploadsOverview(user.businessId)"), true);
  assert.equal(/searchParams|req\.json|formData/.test(route), false, "no business id from the request");
  assert.equal(route.includes('"private, no-store"'), true);
  assert.equal(route.includes("status: 401"), true);
  assert.equal(route.includes("status: 500"), true);
});

console.log(`\n[money-uploads] PASS=${passed} FAIL=${failed}`);
if (failed > 0) process.exit(1);
