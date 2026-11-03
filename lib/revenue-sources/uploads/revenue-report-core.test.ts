/**
 * Revenue report uploads — the pure core, the registry, the form edge and static checks. docs/revenue-report-uploads.md
 * Pure: no database, no network, no clock (the service is only driven to the point where it refuses an unsupported
 * format, which happens before any database access).
 *
 *   npm run test:revenue-report-uploads:core
 *
 * The TEST-ONLY fixture parser below exists in this file only. It is never registered in SHIPPED_PARSERS (asserted).
 */
process.env.AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || "rru-core-synthetic-token-secret-at-least-32-chars";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://nobody:nothing@127.0.0.1:1/never";

import assert from "node:assert/strict";
import fs from "node:fs";

import { IMPORTED_HISTORY_OVERLAP_ENABLED, OVERLAP_EFFECT, closeOverlapsOf, holdsClose, type OverlapEvidence } from "../overlap";
import type { ReportFile, SettlementDraft, SettlementParser, ZReportDraft, ZReportParser } from "./contract";
import {
  RE_EXTERNAL_ID,
  RE_SCOPE,
  checkDecisions,
  checkZConfirmation,
  classifySettlement,
  classifyZ,
  correctionExternalIdOf,
  decisionsHashOf,
  dedupeInFile,
  draftsHashOf,
  isCalendarDay,
  parserHashOf,
  registersToConfirm,
  resolveRegisterKey,
  resolveZDrafts,
  settlementBaseIdOf,
  settlementStageOneCode,
  sourceScopeOf,
  validateSettlementDraft,
  validateZDraft,
  zExternalIdOf,
  zKeyOf,
  type Classification,
  type ExistingClose,
  type ExistingSettlement,
  type ZRow,
} from "./core";
import { SHIPPED_PARSERS, SHIPPED_REGISTRY, createParserRegistry } from "./registry";

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name} — ${e instanceof Error ? e.message : String(e)}`);
  }
}

const B = (n: number) => BigInt(n);
const file = (text: string, filename = "report.csv"): ReportFile => ({ bytes: Buffer.from(text, "utf8"), filename, mime: "text/csv" });

function z(over: Partial<ZReportDraft> = {}): ZReportDraft {
  return {
    businessDay: "2026-10-01",
    registerKey: "1",
    zNumber: B(101),
    grossMinor: B(100_000),
    discountMinor: B(5_000),
    refundMinor: B(2_000),
    voidMinor: B(1_000),
    totalMinor: B(92_000),
    vatMinor: B(13_368),
    transactionCount: 40,
    tenders: [
      { method: "CASH", amountMinor: B(30_000) },
      { method: "CARD", label: "visa", amountMinor: B(62_000), count: 25 },
    ],
    vatLines: [{ category: "STANDARD", rateBasisPoints: 1700, taxableMinor: B(78_632), vatMinor: B(13_368) }],
    sourceRow: 2,
    ...over,
  };
}
function st(over: Partial<SettlementDraft> = {}): SettlementDraft {
  return { acquirer: "fixture_acq", valueDate: "2026-10-03", externalId: "S-1", grossMinor: B(62_000), feeMinor: B(930), netMinor: B(61_070), sourceRow: 2, ...over };
}
const okRow = (d: ZReportDraft): ZRow => {
  const v = validateZDraft(d);
  if (!v.ok) throw new Error(`fixture invalid: ${v.codes.join(",")}`);
  return v.row;
};

/** TEST-ONLY fixture parser: a made-up "FIXTURE-Z" text format. It describes no real system. */
const TEST_ONLY_Z: ZReportParser = {
  kind: "z",
  key: "test_only_fixture",
  version: 1,
  label: "קובץ בדיקה",
  capture: "FILE_STRUCTURED",
  detect: (f) => (f.bytes.toString("utf8").startsWith("FIXTURE-Z") ? 1 : 0),
  parse: () => ({ drafts: [z()], errors: [] }),
};
const TEST_ONLY_S: SettlementParser = {
  kind: "settlement",
  key: "test_only_fixture",
  version: 1,
  label: "קובץ בדיקה",
  capture: "FILE_STRUCTURED",
  sourceKind: "ACQUIRER",
  detect: (f) => (f.bytes.toString("utf8").startsWith("FIXTURE-S") ? 0.9 : 0),
  parse: () => ({ shape: "BATCH_SUMMARY", drafts: [st()], errors: [] }),
};

async function main() {
  console.log("== registry ==");
  await check("the shipped registry has ZERO parsers (no vendor format is guessed)", () => {
    assert.equal(SHIPPED_PARSERS.length, 0);
    assert.equal(SHIPPED_REGISTRY.parsers.length, 0);
    assert.equal(Object.isFrozen(SHIPPED_PARSERS), true);
  });
  await check("no parser module exists next to the registry (a vendor parser needs a real sample first)", () => {
    const files = fs.readdirSync("lib/revenue-sources/uploads").sort();
    // report-values.ts reads ONE printed amount / date exactly (format-independent helpers, no vendor) — not a parser.
    assert.deepEqual(files, ["contract.ts", "core.ts", "http.ts", "registry.ts", "report-values.test.ts", "report-values.ts", "revenue-report-core.test.ts", "service.ts"]);
  });
  await check("the fixture parser is TEST-ONLY: never named outside this test", () => {
    for (const f of ["registry.ts", "service.ts", "http.ts", "core.ts", "contract.ts", "report-values.ts"]) {
      assert.equal(fs.readFileSync(`lib/revenue-sources/uploads/${f}`, "utf8").includes("test_only_fixture"), false, f);
    }
  });
  for (const kind of ["z", "settlement"] as const) {
    await check(`shipped registry: any ${kind} file → NO_PARSER`, () => {
      for (const f of [file("FIXTURE-Z\n"), file("a,b,c\n1,2,3"), file("%PDF-1.7", "z.pdf"), file("")]) {
        assert.deepEqual(SHIPPED_REGISTRY.select(kind, f), { ok: false, reason: "NO_PARSER" });
      }
    });
  }
  await check("a registered parser is selected only for its kind and above the threshold", () => {
    const r = createParserRegistry([TEST_ONLY_Z, TEST_ONLY_S]);
    const pz = r.select("z", file("FIXTURE-Z\n"));
    assert.equal(pz.ok && pz.parser.key, "test_only_fixture");
    assert.equal(r.select("settlement", file("FIXTURE-Z\n")).ok, false);
    assert.equal(r.select("z", file("something else")).ok, false);
    assert.equal(r.byKey("settlement", "test_only_fixture")?.kind, "settlement");
    assert.equal(r.byKey("z", "nope"), null);
  });
  await check("two parsers equally sure → AMBIGUOUS, never a silent pick; a throwing detector is ignored", () => {
    const twin = { ...TEST_ONLY_Z, key: "test_only_twin" };
    assert.deepEqual(createParserRegistry([TEST_ONLY_Z, twin]).select("z", file("FIXTURE-Z")), { ok: false, reason: "AMBIGUOUS" });
    const thrower: ZReportParser = { ...TEST_ONLY_Z, key: "test_only_thrower", detect: () => { throw new Error("x"); } };
    const r = createParserRegistry([thrower, TEST_ONLY_Z]).select("z", file("FIXTURE-Z"));
    assert.equal(r.ok && r.parser.key, "test_only_fixture");
  });
  await check("registration refuses a non-token key, a bad version and a duplicate", () => {
    assert.throws(() => createParserRegistry([{ ...TEST_ONLY_Z, key: "Bad Key" }]));
    assert.throws(() => createParserRegistry([{ ...TEST_ONLY_Z, version: 0 }]));
    assert.throws(() => createParserRegistry([TEST_ONLY_Z, TEST_ONLY_Z]));
  });
  await check("the service answers FORMAT_NOT_SUPPORTED (422) with the shipped registry, before any database access", async () => {
    const { analyzeRevenueReport, commitRevenueReport, RevenueReportError } = await import("./service");
    for (const kind of ["z", "settlement"] as const) {
      const input = { businessId: 1, userId: 1, kind, filename: "x.csv", bytes: Buffer.from("FIXTURE-Z\n1,2"), mime: "text/csv" };
      await assert.rejects(analyzeRevenueReport(input), (e: unknown) => e instanceof RevenueReportError && e.code === "FORMAT_NOT_SUPPORTED" && e.status === 422);
      // A forged / missing token never reaches the parser.
      await assert.rejects(commitRevenueReport({ ...input, token: "forged" }), (e: unknown) => e instanceof RevenueReportError && e.code === "TOKEN_INVALID");
    }
  });
  await check("the Hebrew FORMAT_NOT_SUPPORTED message asks for a sample", async () => {
    const { REPORT_ERROR_TEXT } = await import("./http");
    assert.match(REPORT_ERROR_TEXT.FORMAT_NOT_SUPPORTED, /^עדיין לא תומכים בקובץ מהמערכת הזו\. שלחו לנו דוגמה/);
  });

  console.log("== contract: Z (RevenueDailyClose CHECKs) ==");
  await check("a valid Z passes; its source key and scope match the table's token CHECKs", () => {
    const v = validateZDraft(z());
    assert.equal(v.ok, true);
    if (!v.ok) return;
    assert.equal(v.row.externalId, "z:101");
    assert.match(v.row.externalId, RE_EXTERNAL_ID);
    assert.match(sourceScopeOf("z", "some_parser"), RE_SCOPE);
    assert.equal(sourceScopeOf("settlement", "p1"), "upload.settlement.p1");
    assert.equal(v.row.validation, "PASSED");
    assert.match(v.row.factsHash, /^[0-9a-f]{64}$/);
  });
  await check("a Z without a Z number is keyed by its day", () => assert.equal(zExternalIdOf({ zNumber: null, businessDay: "2026-10-01" }), "day:2026-10-01"));
  const zBad: [string, Partial<ZReportDraft>, string][] = [
    ["total ≠ gross − discount − refunds − voids", { totalMinor: B(92_001) }, "TOTAL_MISMATCH"],
    ["negative gross", { grossMinor: B(-1), totalMinor: B(-8_001) }, "AMOUNT_INVALID"],
    ["negative VAT", { vatMinor: B(-1) }, "AMOUNT_INVALID"],
    ["a non-bigint amount", { grossMinor: 100 as unknown as bigint }, "AMOUNT_INVALID"],
    ["an amount beyond 2^53", { grossMinor: B(2) ** B(60), totalMinor: B(2) ** B(60) - B(8_000) }, "AMOUNT_TOO_LARGE"],
    ["an impossible day", { businessDay: "2026-02-30" }, "BUSINESS_DAY_INVALID"],
    ["a register key with a space", { registerKey: "קופה 1" }, "REGISTER_KEY_INVALID"],
    ["an empty register key", { registerKey: "" }, "REGISTER_KEY_INVALID"],
    ["an unsupported currency", { currency: "GBP" as never }, "CURRENCY_INVALID"],
    ["a negative Z number", { zNumber: B(-1) }, "Z_NUMBER_INVALID"],
    ["a fractional transaction count", { transactionCount: 1.5 }, "TRANSACTION_COUNT_INVALID"],
    ["a period ending before it starts", { period: { start: new Date("2026-10-01T20:00:00Z"), end: new Date("2026-10-01T08:00:00Z") } }, "PERIOD_INVALID"],
    ["a tender label that is free text", { tenders: [{ method: "CARD", label: "ויזה", amountMinor: B(92_000) }] }, "TENDER_INVALID"],
    ["an unknown tender method", { tenders: [{ method: "BITCOIN" as never, amountMinor: B(92_000) }] }, "TENDER_INVALID"],
    ["the same tender twice", { tenders: [{ method: "CASH", amountMinor: B(1) }, { method: "CASH", amountMinor: B(2) }] }, "TENDER_DUPLICATE"],
    ["an exempt VAT line with a rate", { vatLines: [{ category: "EXEMPT", rateBasisPoints: 1700, taxableMinor: B(1), vatMinor: B(0) }] }, "VAT_LINE_INVALID"],
    ["a zero-rated line with VAT", { vatLines: [{ category: "ZERO_RATED", rateBasisPoints: 0, taxableMinor: B(1), vatMinor: B(1) }] }, "VAT_LINE_INVALID"],
    ["a rate above 100%", { vatLines: [{ category: "STANDARD", rateBasisPoints: 10001, taxableMinor: B(1), vatMinor: B(1) }] }, "VAT_LINE_INVALID"],
    ["the same VAT rate twice", { vatLines: [{ category: "STANDARD", rateBasisPoints: 1700, taxableMinor: B(1), vatMinor: B(0) }, { category: "STANDARD", rateBasisPoints: 1700, taxableMinor: B(2), vatMinor: B(0) }] }, "VAT_LINE_DUPLICATE"],
  ];
  for (const [name, over, code] of zBad) {
    await check(`Z refused: ${name} → ${code}`, () => {
      const v = validateZDraft(z(over));
      assert.equal(v.ok, false);
      if (!v.ok) {
        assert.equal(v.codes.includes(code), true, v.codes.join(","));
        assert.equal(v.sourceRow, 2);
      }
    });
  }
  await check("Z consistency the table does not enforce is a WARNING kept on the row, never a silent fix", () => {
    const v = validateZDraft(z({ tenders: [{ method: "CASH", amountMinor: B(1) }], vatLines: [] }));
    assert.equal(v.ok && v.row.validation, "WARNINGS");
    assert.deepEqual(v.ok && v.row.validationCodes, ["TENDERS_TOTAL_MISMATCH"]);
    if (v.ok) assert.equal(v.row.totalMinor, B(92_000));
  });
  await check("the facts hash ignores line order and changes with any fact", () => {
    const a = okRow(z());
    const b = okRow(z({ tenders: [...z().tenders].reverse() }));
    const c = okRow(z({ grossMinor: B(100_001), totalMinor: B(92_001) }));
    assert.equal(a.factsHash, b.factsHash);
    assert.notEqual(a.factsHash, c.factsHash);
  });

  console.log("== contract: settlement (RevenueSettlement CHECKs) ==");
  await check("a valid settlement passes", () => assert.equal(validateSettlementDraft(st()).ok, true));
  const sBad: [string, Partial<SettlementDraft>, string][] = [
    ["net ≠ gross − fee − other", { netMinor: B(61_071) }, "NET_MISMATCH"],
    ["a negative fee", { feeMinor: B(-1), netMinor: B(62_001) }, "AMOUNT_INVALID"],
    ["an acquirer that is not a token", { acquirer: "Isracard Ltd" }, "ACQUIRER_INVALID"],
    ["an empty external id", { externalId: "" }, "EXTERNAL_ID_INVALID"],
    ["an external id with spaces", { externalId: "S 1" }, "EXTERNAL_ID_INVALID"],
    ["an impossible value date", { valueDate: "2026-13-01" }, "VALUE_DATE_INVALID"],
    ["installment number above the count", { installments: { number: 4, count: 3 } }, "INSTALLMENT_INVALID"],
    ["100 installments", { installments: { number: 1, count: 100 } }, "INSTALLMENT_INVALID"],
  ];
  for (const [name, over, code] of sBad) {
    await check(`settlement refused: ${name} → ${code}`, () => {
      const v = validateSettlementDraft(st(over));
      assert.equal(v.ok, false);
      if (!v.ok) assert.equal(v.codes.includes(code), true, v.codes.join(","));
    });
  }
  await check("calendar days", () => {
    assert.equal(isCalendarDay("2024-02-29"), true);
    assert.equal(isCalendarDay("2026-02-29"), false);
    assert.equal(isCalendarDay("2026-1-01"), false);
  });

  console.log("== in-file duplicates ==");
  await check("the same Z twice is read once; the same key with other numbers is CONFLICT_IN_FILE for both", () => {
    const same = dedupeInFile([validateZDraft(z()), validateZDraft(z({ sourceRow: 3 }))], zKeyOf);
    assert.equal(same.rows.length, 1);
    assert.equal(same.repeatedInFile, 1);
    const diff = dedupeInFile([validateZDraft(z()), validateZDraft(z({ grossMinor: B(100_100), totalMinor: B(92_100), sourceRow: 3 }))], zKeyOf);
    assert.equal(diff.rows.length, 0);
    assert.deepEqual(diff.invalid.map((i) => i.codes[0]), ["CONFLICT_IN_FILE", "CONFLICT_IN_FILE"]);
  });
  await check("the drafts hash changes when what was read changes", () => {
    const r = [okRow(z())];
    assert.notEqual(draftsHashOf(r, []), draftsHashOf(r, [{ sourceRow: 5, codes: ["AMOUNT_INVALID"] }]));
  });

  console.log("== classification ==");
  const scope = "upload.z.p";
  const row = okRow(z());
  const ex = (over: Partial<ExistingClose>): ExistingClose => ({
    id: 1, sourceScope: scope, registerKey: "1", externalId: "z:101", businessDay: "2026-10-01", revision: 1, superseded: false,
    sourcePayloadHash: row.factsHash, currency: "ILS", totalMinor: B(92_000), ...over,
  });
  await check("NEW when nothing is recorded on the register and day", () => assert.deepEqual(classifyZ(row, scope, []), { status: "NEW" }));
  await check("EXISTING when the same Z (same facts) is recorded — the replay case", () => assert.deepEqual(classifyZ(row, scope, [ex({})]), { status: "EXISTING", existingId: 1 }));
  await check("CONFLICT SAME_Z: same Z, other numbers → SKIP / SUPERSEDE of the chain's LATEST revision", () => {
    const c = classifyZ(row, scope, [ex({ id: 1, sourcePayloadHash: "a".repeat(64), superseded: true }), ex({ id: 7, revision: 2, sourcePayloadHash: "b".repeat(64) })]);
    assert.equal(c.status, "CONFLICT");
    if (c.status === "CONFLICT") {
      assert.equal(c.conflict, "SAME_Z");
      assert.deepEqual(c.supersedes, { id: 7, revision: 2 });
      assert.deepEqual(c.allowed, ["SKIP", "SUPERSEDE"]);
    }
  });
  await check("CONFLICT SAME_DAY: another Z of this register and day with other numbers → SKIP / ADD (never SUPERSEDE)", () => {
    const c = classifyZ(row, scope, [ex({ id: 3, externalId: "z:100", sourcePayloadHash: "c".repeat(64), totalMinor: B(5) })]);
    assert.equal(c.status === "CONFLICT" && c.conflict, "SAME_DAY");
    assert.deepEqual(c.status === "CONFLICT" && c.allowed, ["SKIP", "ADD"]);
  });
  await check("the same facts recorded from another source on this register and day → EXISTING (not counted twice)", () => {
    assert.deepEqual(classifyZ(row, scope, [ex({ id: 9, sourceScope: "pos.other", externalId: "x" })]), { status: "EXISTING", existingId: 9 });
  });
  await check("a superseded revision of another register-day Z is not a conflict", () => {
    assert.deepEqual(classifyZ(row, scope, [ex({ id: 4, externalId: "z:99", superseded: true, sourcePayloadHash: "d".repeat(64) })]), { status: "NEW" });
  });
  await check("settlement: NEW / EXISTING / CONFLICT (SKIP only — a settlement has no revisions)", () => {
    const s = validateSettlementDraft(st());
    assert.equal(s.ok, true);
    if (!s.ok) return;
    const sc = "upload.settlement.p";
    const base = { id: 5, sourceScope: sc, externalId: "S-1", rejected: false, currency: "ILS", grossMinor: B(62_000), netMinor: B(61_070) };
    assert.deepEqual(classifySettlement(s.row, sc, []), { status: "NEW" });
    assert.deepEqual(classifySettlement(s.row, sc, [{ ...base, sourcePayloadHash: s.row.factsHash }]), { status: "EXISTING", existingId: 5 });
    const c = classifySettlement(s.row, sc, [{ ...base, sourcePayloadHash: "e".repeat(64) }]);
    assert.deepEqual(c.status === "CONFLICT" && c.allowed, ["SKIP"]);
    assert.deepEqual(classifySettlement(s.row, sc, [{ ...base, sourceScope: "upload.settlement.other", sourcePayloadHash: "f".repeat(64) }]), { status: "NEW" });
  });

  console.log("== decisions ==");
  const classes: Classification[] = [
    { status: "NEW" },
    classifyZ(row, scope, [ex({ sourcePayloadHash: "b".repeat(64) })]),
    classifyZ(row, scope, [ex({ externalId: "z:1", sourcePayloadHash: "c".repeat(64) })]),
  ];
  await check("every conflict needs a decision — no default", () => assert.deepEqual(checkDecisions(classes, { 1: "SKIP" }), { ok: false, code: "DECISIONS_REQUIRED", missing: 1 }));
  await check("a decision the conflict does not allow is refused (SUPERSEDE on SAME_DAY)", () => assert.equal(checkDecisions(classes, { 1: "SKIP", 2: "SUPERSEDE" }).ok, false));
  await check("a decision on a row that is not a conflict is refused", () => assert.equal(checkDecisions(classes, { 0: "ADD", 1: "SKIP", 2: "ADD" }).ok, false));
  await check("allowed decisions on every conflict pass", () => assert.deepEqual(checkDecisions(classes, { 1: "SUPERSEDE", 2: "ADD" }), { ok: true }));
  await check("decision / parser hashes are stable, ordered and distinct per kind", () => {
    assert.equal(decisionsHashOf("z", { 2: "ADD", 1: "SKIP" }), decisionsHashOf("z", { 1: "SKIP", 2: "ADD" }));
    assert.notEqual(decisionsHashOf("z", { 1: "SKIP" }), decisionsHashOf("settlement", { 1: "SKIP" }));
    assert.notEqual(parserHashOf("z", "p", 1), parserHashOf("z", "p", 2));
    assert.notEqual(parserHashOf("z", "p", 1), parserHashOf("settlement", "p", 1));
  });

  // Synthetic drafts only: these prove the RULES of the approved directions, never that any real export is read right.
  console.log("== owner decisions 2026-11-03 (synthetic — rules only, no real format) ==");
  const src = (p: string) => fs.readFileSync(p, "utf8");
  const { analyzeRevenueReport, RevenueReportError } = await import("./service");
  const svcInput = (kind: "z" | "settlement") => ({ businessId: 1, userId: 1, kind, filename: "x.csv", bytes: Buffer.from("FIXTURE-S\n"), mime: "text/csv" });

  // D-5
  for (const shape of ["TRANSACTION_LIST", "INSTALLMENT_LIST"] as const) {
    await check(`D-5: a settlement ${shape} is refused as a whole (422 SETTLEMENT_FILE_NOT_SUMMARY), before any database access`, async () => {
      const parser: SettlementParser = { ...TEST_ONLY_S, parse: () => ({ shape, drafts: [st()], errors: [] }) };
      await assert.rejects(analyzeRevenueReport(svcInput("settlement"), { registry: createParserRegistry([parser]) }),
        (e: unknown) => e instanceof RevenueReportError && e.code === "SETTLEMENT_FILE_NOT_SUMMARY" && e.status === 422 && e.detail.shape === shape);
    });
  }
  await check("D-5: the refusal explains in Hebrew that only a summary of credits is taken, and that nothing was recorded", async () => {
    const { REPORT_ERROR_TEXT, REPORT_ROW_CODE_TEXT } = await import("./http");
    assert.match(REPORT_ERROR_TEXT.SETTLEMENT_FILE_NOT_SUMMARY, /^בשלב זה אפשר לקלוט רק דוח זיכויים מסוכם/);
    assert.match(REPORT_ERROR_TEXT.SETTLEMENT_FILE_NOT_SUMMARY, /פירוט עסקאות או של תשלומים/);
    assert.match(REPORT_ERROR_TEXT.SETTLEMENT_FILE_NOT_SUMMARY, /לא נקלט דבר\.$/);
    assert.equal(typeof REPORT_ROW_CODE_TEXT.INSTALLMENT_ROW_NOT_SUPPORTED, "string");
  });
  await check("D-5: an installment row inside a summary is refused by row (INSTALLMENT_ROW_NOT_SUPPORTED); a batch row passes", () => {
    assert.equal(settlementStageOneCode(st({ installments: { number: 1, count: 3 } })), "INSTALLMENT_ROW_NOT_SUPPORTED");
    assert.equal(settlementStageOneCode(st()), null);
  });

  // D-7
  await check("D-7: no expense from a settlement's fee — the service, the overlap reader and the layers report create none", () => {
    const code = (p: string) => src(p).split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));
    for (const p of ["lib/revenue-sources/uploads/service.ts", "lib/revenue-sources/overlap.ts", "lib/revenue-truth/layers-report.ts", "lib/revenue-truth/deposit-proposals.ts"]) {
      const lines = code(p);
      assert.deepEqual(lines.filter((l) => /expense|\.(create|update|upsert|delete)(Many)?\(/i.test(l)), [], p);
    }
    // The fee reaches exactly one writer: the settlement row itself.
    assert.equal(code("lib/revenue-sources/uploads/service.ts").filter((l) => /feeMinor/.test(l)).length > 0, true);
    assert.equal(/financialRecord\.(create|update|upsert)/.test(src("lib/revenue-sources/overlap.ts")), false);
  });

  // D-8
  await check("D-8: one agora between tenders and the total is a MISMATCH by default (no blanket tolerance); the difference is reported", () => {
    const v = validateZDraft(z({ tenders: [{ method: "CASH", amountMinor: B(30_000) }, { method: "CARD", label: "visa", amountMinor: B(62_001) }] }));
    assert.equal(v.ok && v.row.validationCodes.includes("TENDERS_TOTAL_MISMATCH"), true);
    assert.equal(v.ok && v.row.differences.tendersMinusTotalMinor, B(1));
    assert.equal(v.ok && v.row.differences.vatLinesMinusVatMinor, B(0));
    assert.equal(v.ok && v.row.totalMinor, B(92_000), "never adjusted");
  });
  await check("D-8: within a parser's PROVEN precision → a ROUNDING code (still kept and shown); beyond it → MISMATCH", () => {
    const off = (n: number) => z({ tenders: [{ method: "CASH", amountMinor: B(30_000) }, { method: "CARD", label: "visa", amountMinor: B(62_000 + n) }] });
    const within = validateZDraft(off(-40), { roundingToleranceMinor: 50 });
    assert.deepEqual(within.ok && within.row.validationCodes, ["TENDERS_ROUNDING_DIFFERENCE"]);
    assert.equal(within.ok && within.row.differences.tendersMinusTotalMinor, B(-40));
    const beyond = validateZDraft(off(51), { roundingToleranceMinor: 50 });
    assert.deepEqual(beyond.ok && beyond.row.validationCodes, ["TENDERS_TOTAL_MISMATCH"]);
    const exact = validateZDraft(z(), { roundingToleranceMinor: 50 });
    assert.deepEqual(exact.ok && exact.row.validationCodes, []);
  });
  await check("D-8: a parser's tolerance must be a non-negative integer (registry); none of the shipped code declares one", () => {
    assert.throws(() => createParserRegistry([{ ...TEST_ONLY_Z, roundingToleranceMinor: -1 }]));
    assert.throws(() => createParserRegistry([{ ...TEST_ONLY_Z, roundingToleranceMinor: 0.5 }]));
    assert.doesNotThrow(() => createParserRegistry([{ ...TEST_ONLY_Z, roundingToleranceMinor: 0 }]));
    for (const f of ["core.ts", "service.ts", "registry.ts"]) {
      assert.equal(/roundingToleranceMinor:\s*[1-9]/.test(src(`lib/revenue-sources/uploads/${f}`)), false, f);
    }
  });

  // D-10 / D-11
  const noDay = z({ businessDay: null, period: { start: new Date("2026-10-01T18:00:00Z"), end: new Date("2026-10-01T23:30:00Z") } });
  await check("D-10: a Z without a printed business day is a QUESTION — not derived from its period or time", () => {
    const r = resolveZDrafts([noDay, z({ zNumber: B(102), sourceRow: 3 })], null, null);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.questions, [{ index: 0, sourceRow: 2, missing: ["BUSINESS_DAY"] }]);
    assert.equal(r.drafts.length, 1);
    assert.equal(r.drafts[0].zNumber, B(102));
  });
  await check("D-10: the owner's answer fills the day; the Z is then keyed and validated with it", () => {
    const r = resolveZDrafts([noDay], { 0: { businessDay: "2026-10-01" } }, null);
    assert.equal(r.ok && r.questions.length, 0);
    const v = r.ok ? validateZDraft(r.drafts[0]) : null;
    assert.equal(v?.ok && v.row.businessDay, "2026-10-01");
  });
  await check("D-10: an answer may not override a PRINTED day, name an unknown row, or be an impossible date (ANSWERS_INVALID)", () => {
    for (const answers of [{ 0: { businessDay: "2026-10-02" } }, { 5: { businessDay: "2026-10-01" } }, { 0: { businessDay: "2026-02-30" } }, { 0: {} }] as Record<number, { businessDay?: string }>[]) {
      assert.deepEqual(resolveZDrafts([z()], answers, null), { ok: false, code: "ANSWERS_INVALID" }, JSON.stringify(answers));
    }
    assert.deepEqual(resolveZDrafts([noDay], { 0: { businessDay: "2026-02-30" } }, null), { ok: false, code: "ANSWERS_INVALID" });
  });
  await check("D-10: there is no cut-off hour anywhere in the pipeline (a printed time never moves the day)", () => {
    for (const f of ["core.ts", "service.ts", "contract.ts", "report-values.ts", "http.ts", "registry.ts"]) {
      const text = src(`lib/revenue-sources/uploads/${f}`);
      assert.equal(/getHours|getUTCHours|jerusalemHour|jerusalemClock|setHours|cut-?off\s*=|"0?6:00"/i.test(text), false, f);
    }
  });
  await check("D-11: a missing register is asked (no definition exists → always asked); never defaulted to \"1\"", () => {
    const noReg = z({ registerKey: null });
    const r = resolveZDrafts([noReg], null, null);
    assert.deepEqual(r.ok && r.questions, [{ index: 0, sourceRow: 2, missing: ["REGISTER"] }]);
    const both = resolveZDrafts([z({ registerKey: null, businessDay: null })], null, null);
    assert.deepEqual(both.ok && both.questions[0].missing, ["BUSINESS_DAY", "REGISTER"]);
    const answered = resolveZDrafts([noReg], { 0: { registerKey: "pos-2" } }, null);
    assert.equal(answered.ok && answered.drafts[0].registerKey, "pos-2");
    assert.deepEqual(resolveZDrafts([noReg], { 0: { registerKey: "קופה 1" } }, null), { ok: false, code: "ANSWERS_INVALID" });
    assert.deepEqual(resolveZDrafts([z()], { 0: { registerKey: "9" } }, null), { ok: false, code: "ANSWERS_INVALID" }, "a printed register is never overridden");
    assert.equal(/const DEFINED_REGISTERS: readonly string\[\] \| null = null;/.test(src("lib/revenue-sources/uploads/service.ts")), true);
  });
  await check("D-11: the business's SINGLE defined register is used; two defined → asked; a printed one always wins", () => {
    assert.equal(resolveRegisterKey(null, ["7"]), "7");
    assert.equal(resolveRegisterKey(null, ["7", "8"]), null);
    assert.equal(resolveRegisterKey(null, []), null);
    assert.equal(resolveRegisterKey("3", ["7"]), "3");
    assert.equal(resolveRegisterKey("", ["7"]), "", "an empty printed register is not replaced — it fails validation");
  });
  await check("D-10/D-11: what was asked is part of the drafts hash (the token binds the answers)", () => {
    const r = [okRow(z())];
    assert.notEqual(draftsHashOf(r, []), draftsHashOf(r, [], [{ index: 1, sourceRow: 3, missing: ["BUSINESS_DAY"] }]));
    assert.equal(draftsHashOf(r, []), draftsHashOf(r, [], []));
  });

  // D-1 / D-11 interim: register + sales source selected AND confirmed on every upload
  await check("confirm: every register in the file, once, sorted", () => {
    assert.deepEqual(registersToConfirm([{ registerKey: "2" }, { registerKey: "1" }, { registerKey: "2" }]), ["1", "2"]);
  });
  await check("confirm: missing / unconfirmed / partial → CONFIRMATION_REQUIRED; nothing is defaulted", () => {
    const regs = ["1", "2"];
    assert.deepEqual(checkZConfirmation(regs, null), { ok: false, code: "CONFIRMATION_REQUIRED", registers: ["1", "2"] });
    assert.equal(checkZConfirmation(regs, { confirmed: false, registers: { 1: "THIS_Z_REPORT", 2: "THIS_Z_REPORT" } }).ok, false, "a choice without the confirmation tick is not a confirmation");
    assert.deepEqual(checkZConfirmation(regs, { confirmed: true, registers: { 1: "THIS_Z_REPORT" } }), { ok: false, code: "CONFIRMATION_REQUIRED", registers: ["2"] });
    assert.deepEqual(checkZConfirmation([], null), { ok: true }, "nothing to record, nothing to confirm");
  });
  await check("confirm: another register / an unknown choice → CONFIRMATION_INVALID; recorded another way → SALES_SOURCE_NOT_SUPPORTED", () => {
    const regs = ["1", "2"];
    assert.equal((checkZConfirmation(regs, { confirmed: true, registers: { 1: "THIS_Z_REPORT", 2: "THIS_Z_REPORT", 3: "THIS_Z_REPORT" } }) as { code: string }).code, "CONFIRMATION_INVALID");
    assert.equal((checkZConfirmation(regs, { confirmed: true, registers: { 1: "THIS_Z_REPORT", 2: "MAYBE" as never } }) as { code: string }).code, "CONFIRMATION_INVALID");
    assert.deepEqual(checkZConfirmation(regs, { confirmed: true, registers: { 1: "THIS_Z_REPORT", 2: "INVOICES_OR_OTHER_SYSTEM" } }), { ok: false, code: "SALES_SOURCE_NOT_SUPPORTED", registers: ["2"] });
    assert.deepEqual(checkZConfirmation(regs, { confirmed: true, registers: { 2: "THIS_Z_REPORT", 1: "THIS_Z_REPORT" } }), { ok: true });
  });
  await check("confirm: recorded in the run's decisions hash (audit); absent → the v1 hash unchanged", () => {
    const c = { confirmed: true, registers: { 1: "THIS_Z_REPORT" as const } };
    assert.notEqual(decisionsHashOf("z", {}, c), decisionsHashOf("z", {}));
    assert.equal(decisionsHashOf("z", {}, null), decisionsHashOf("z", {}));
    assert.equal(decisionsHashOf("z", {}, { confirmed: true, registers: { 2: "THIS_Z_REPORT", 1: "THIS_Z_REPORT" } }), decisionsHashOf("z", {}, { confirmed: true, registers: { 1: "THIS_Z_REPORT", 2: "THIS_Z_REPORT" } }));
  });
  await check("confirm: the service checks it on every Z commit, before the transaction, with no standing definition", () => {
    const svc = src("lib/revenue-sources/uploads/service.ts");
    const at = svc.indexOf("checkZConfirmation(registersToConfirm(p.prepared.rows), input.confirmation)");
    assert.ok(at > 0 && at < svc.indexOf("return tenantTx(", at), "checked before the transaction");
    assert.equal(/DEFINED_SALES_SOURCES|standingSalesSource/.test(svc), false, "nothing stands in for the owner's confirmation");
  });

  // D-4
  await check("D-4: a report id that looks like a stored correction is refused (EXTERNAL_ID_RESERVED); ids round-trip", () => {
    const v = validateSettlementDraft(st({ externalId: "S-1#c2" }));
    assert.equal(!v.ok && v.codes.includes("EXTERNAL_ID_RESERVED"), true);
    assert.equal(validateSettlementDraft(st({ externalId: "S-1#c" })).ok, true);
    assert.equal(validateSettlementDraft(st({ externalId: "S-1#c1" })).ok, true);
    assert.equal(correctionExternalIdOf("S-1", 1), "S-1");
    assert.equal(correctionExternalIdOf("S-1", 3), "S-1#c3");
    assert.equal(settlementBaseIdOf("S-1#c3"), "S-1");
    assert.equal(settlementBaseIdOf("S-1"), "S-1");
  });
  await check("D-4: the <id>#c<n> link is unambiguous — every stored id maps to exactly one report id and one version", () => {
    // Report ids a parser may emit (accepted) never end in a correction suffix, so base(stored) is a function and
    // (base, n) → stored is its inverse. Ids that merely LOOK close stay their own report ids.
    let accepted = 0;
    for (const id of ["S-1", "S-1#c", "S-1#c1", "S-1#c01", "S-1#c0", "A#c1#c", "c2", "#c"]) {
      if (!validateSettlementDraft(st({ externalId: id })).ok) continue;
      accepted++;
      assert.equal(settlementBaseIdOf(id), id, id);
      for (const n of [2, 3, 10, 11, 99]) {
        const stored = correctionExternalIdOf(id, n);
        assert.equal(settlementBaseIdOf(stored), id, stored);
        assert.notEqual(stored, correctionExternalIdOf(id, n + 1));
      }
    }
    assert.ok(accepted >= 6, String(accepted));
    for (const reserved of ["S-1#c2", "S-1#c10", "A#c1#c3"]) {
      const v = validateSettlementDraft(st({ externalId: reserved }));
      assert.equal(!v.ok && v.codes.includes("EXTERNAL_ID_RESERVED"), true, reserved);
    }
    // A correction of an id near the 200-char limit cannot be stored → it stays a SKIP-only conflict, never a truncation.
    assert.equal(RE_EXTERNAL_ID.test(correctionExternalIdOf("x".repeat(198), 2)), false);
  });
  await check("D-4: correct = reject, then upload — the corrected file is NEW beside the rejected row (history kept)", () => {
    const s = validateSettlementDraft(st({ feeMinor: B(1_000), netMinor: B(61_000) }));
    if (!s.ok) throw new Error("fixture");
    const sc = "upload.settlement.p";
    const rec = (o: Partial<ExistingSettlement>): ExistingSettlement => ({ id: 5, sourceScope: sc, externalId: "S-1", rejected: false, sourcePayloadHash: "e".repeat(64), currency: "ILS", grossMinor: B(62_000), netMinor: B(61_070), ...o });
    // live → still SKIP-only: never two live versions
    assert.deepEqual(classifySettlement(s.row, sc, [rec({})]).status === "CONFLICT" && classifySettlement(s.row, sc, [rec({})]), {
      status: "CONFLICT", conflict: "SAME_SETTLEMENT", existingIds: [5], supersedes: null, allowed: ["SKIP"], existingTotals: [{ currency: "ILS", totalMinor: B(61_070) }],
    });
    assert.deepEqual(classifySettlement(s.row, sc, [rec({ rejected: true })]), { status: "NEW", corrects: { rejectedIds: [5], externalId: "S-1#c2" } });
    assert.deepEqual(classifySettlement(s.row, sc, [rec({ rejected: true }), rec({ id: 9, externalId: "S-1#c2", rejected: true, sourcePayloadHash: "f".repeat(64) })]),
      { status: "NEW", corrects: { rejectedIds: [5, 9], externalId: "S-1#c3" } });
    const c = classifySettlement(s.row, sc, [rec({ rejected: true }), rec({ id: 9, externalId: "S-1#c2", sourcePayloadHash: "f".repeat(64) })]);
    assert.equal(c.status === "CONFLICT" && c.existingIds.join(), "9", "a live correction blocks a further version");
    assert.deepEqual(classifySettlement(s.row, sc, [rec({ rejected: true, sourcePayloadHash: s.row.factsHash })]), { status: "EXISTING", existingId: 5 },
      "re-uploading the rejected numbers writes nothing (and does not revive it)");
    assert.deepEqual(classifySettlement(s.row, sc, [rec({ externalId: "S-10", rejected: true })]), { status: "NEW" }, "another id is not part of the chain");
  });

  // D-2 / D-12
  const ev = (o: Partial<OverlapEvidence> = {}): OverlapEvidence => ({ recordedIncome: [], importedHistory: [], ...o });
  const zc = { businessDay: "2026-10-01", currency: "ILS", totalMinor: B(92_000) };
  await check("D-2: an approved income document of the Z's day that reads as a Z → HOLD (the Z waits for the owner)", () => {
    const o = closeOverlapsOf(zc, ev({ recordedIncome: [{ financialRecordId: 1, documentId: 11, day: "2026-10-01", amountMinor: B(5), looksLikeZ: true }] }));
    assert.deepEqual(o, [{ overlap: "RECORDED_INCOME_DOCUMENT", basis: "Z_DOCUMENT_SAME_DAY", effect: "HOLD", ref: "document:11" }]);
    assert.equal(holdsClose(o), true);
  });
  await check("suspicion: same day + exactly the same amount (no Z text) is NOT proof → QUESTION only: never holds, never removes", () => {
    const o = closeOverlapsOf(zc, ev({ recordedIncome: [{ financialRecordId: 2, documentId: 12, day: "2026-10-01", amountMinor: B(92_000), looksLikeZ: false }] }));
    assert.deepEqual(o, [{ overlap: "RECORDED_INCOME_DOCUMENT", basis: "AMOUNT_SAME_DAY", effect: "QUESTION", ref: "document:12" }]);
    assert.equal(holdsClose(o), false, "the exact-total heuristic alone excludes nothing");
    assert.deepEqual({ ...OVERLAP_EFFECT }, { Z_DOCUMENT_SAME_DAY: "HOLD", HISTORY_SAME_DAY: "HOLD", AMOUNT_SAME_DAY: "QUESTION" }, "only D-2 / D-12 hold");
    // Z text AND the same amount: one overlap per document, the stronger basis (HOLD).
    assert.deepEqual(closeOverlapsOf(zc, ev({ recordedIncome: [{ financialRecordId: 3, documentId: 13, day: "2026-10-01", amountMinor: B(92_000), looksLikeZ: true }] })).map((x) => x.basis), ["Z_DOCUMENT_SAME_DAY"]);
  });
  await check("suspicion: nothing in the overlap code or the read model decides, links, confirms or removes anything", () => {
    for (const p of ["lib/revenue-sources/overlap.ts", "lib/revenue-truth/read-model.ts"]) {
      const code = src(p).replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
      for (const forbidden of ["recordDecision", "proposeLink", "revenueDecision.", "revenueLink.", ".create(", ".update(", ".delete(", ".upsert(", "executeRaw"]) {
        assert.equal(code.includes(forbidden), false, p + ": " + forbidden);
      }
    }
    // The read model only excludes a Z for an overlap whose effect is HOLD.
    assert.equal(src("lib/revenue-truth/read-model.ts").includes('o.effect === "HOLD" ? overlapsOf : suspectedOf'), true);
  });
  await check("D-2: an ordinary invoice of that day (other amount, no Z text), or a Z-like document of another day → no overlap", () => {
    assert.deepEqual(closeOverlapsOf(zc, ev({ recordedIncome: [
      { financialRecordId: 3, documentId: 13, day: "2026-10-01", amountMinor: B(91_999), looksLikeZ: false },
      { financialRecordId: 4, documentId: 14, day: "2026-10-02", amountMinor: B(92_000), looksLikeZ: true },
    ] })), []);
    assert.deepEqual(closeOverlapsOf({ ...zc, currency: "USD" }, ev({ recordedIncome: [{ financialRecordId: 5, documentId: 15, day: "2026-10-01", amountMinor: B(92_000), looksLikeZ: false }] })), [],
      "a record has no currency: an amount match is ILS only");
  });
  await check("D-12: imported history of the SAME day → overlap for that Z only; history of other days never blocks it", () => {
    const hd = (id: number, day: string) => ({ historicalDocumentId: id, day, totalMinor: B(1), currency: "ILS", sourceSystemCode: "prev" });
    const h = ev({ importedHistory: [hd(21, "2026-10-01"), hd(22, "2026-09-30")] });
    assert.deepEqual(closeOverlapsOf(zc, h), [{ overlap: "IMPORTED_HISTORY", basis: "HISTORY_SAME_DAY", effect: "HOLD", ref: "history:21" }]);
    assert.deepEqual(closeOverlapsOf({ ...zc, businessDay: "2026-10-02" }, h), []);
  });
  await check("D-12: the imported-history overlap reader is OFF (a literal false), and the loader reaches it only behind it", () => {
    assert.equal(IMPORTED_HISTORY_OVERLAP_ENABLED, false);
    const code = src("lib/revenue-sources/overlap.ts");
    assert.equal(/export const IMPORTED_HISTORY_OVERLAP_ENABLED = false;/.test(code), true);
    assert.equal(code.includes("importedHistory: IMPORTED_HISTORY_OVERLAP_ENABLED ? await loadImportedHistoryEvidenceInTx("), true);
    assert.equal(/process\.env/.test(code), false, "not an environment switch");
    // The overlap code never names the history model itself: it goes through the one listed reader.
    assert.equal(new RegExp(["historical", "fiscal"].join(""), "i").test(code), false);
  });
  await check("D-2: the documents Z-guard override is NOT persisted (so the overlap is recognised from stored rows)", () => {
    const route = src("app/api/documents/[id]/approve/route.ts");
    assert.equal(route.includes("confirmedNotRevenueReport === true"), true);
    assert.equal(/confirmedNotRevenueReport\s*:/.test(route.replace(/confirmedNotRevenueReport\?: boolean;/, "")), false, "the answer is not written to any row");
  });

  console.log("== the form edge ==");
  const { parseDecisions, parseAnswers, parseConfirmation, readReportForm } = await import("./http");
  await check("confirmation: {confirmed, registers: {<register token>: choice}} only", () => {
    assert.deepEqual(parseConfirmation('{"confirmed":true,"registers":{"1":"THIS_Z_REPORT","b-2":"INVOICES_OR_OTHER_SYSTEM"}}'),
      { confirmed: true, registers: { 1: "THIS_Z_REPORT", "b-2": "INVOICES_OR_OTHER_SYSTEM" } });
    assert.equal(parseConfirmation(null), null);
    for (const bad of ['{"confirmed":"yes","registers":{}}', '{"confirmed":true}', '{"confirmed":true,"registers":{"1":"Z"}}',
      '{"confirmed":true,"registers":{"a b":"THIS_Z_REPORT"}}', '{"confirmed":true,"registers":{},"x":1}', "[1]", "{"]) {
      assert.throws(() => parseConfirmation(bad), (e: unknown) => (e as { code?: string }).code === "CONFIRMATION_INVALID", bad);
    }
  });
  await check("answers: draft indexes with a businessDay / registerKey string only", () => {
    assert.deepEqual(parseAnswers('{"0":{"businessDay":"2026-10-01"},"3":{"registerKey":"2"}}'), { 0: { businessDay: "2026-10-01" }, 3: { registerKey: "2" } });
    assert.equal(parseAnswers(null), null);
    for (const bad of ['{"x":{}}', '{"0":"2026-10-01"}', '{"0":{"day":"2026-10-01"}}', '{"0":{"businessDay":1}}', "[1]", "{"]) {
      assert.throws(() => parseAnswers(bad), (e: unknown) => (e as { code?: string }).code === "ANSWERS_INVALID", bad);
    }
  });
  await check("decisions: row indexes and the three decisions only", () => {
    assert.deepEqual(parseDecisions('{"0":"SKIP","12":"SUPERSEDE","3":"ADD"}'), { 0: "SKIP", 12: "SUPERSEDE", 3: "ADD" });
    assert.equal(parseDecisions(null), null);
    for (const bad of ['{"-1":"SKIP"}', '{"1.5":"SKIP"}', '{"x":"SKIP"}', '{"1":"IMPORT"}', "[1]", "{", '{"1":1}']) {
      assert.throws(() => parseDecisions(bad), (e: unknown) => (e as { code?: string }).code === "DECISIONS_INVALID", bad);
    }
  });
  await check("the business and user come from the session actor, never from the form", async () => {
    const form = new FormData();
    form.set("file", new File([Buffer.from("FIXTURE-Z")], "z.csv", { type: "text/csv" }));
    form.set("businessId", "999");
    form.set("userId", "999");
    form.set("token", "t");
    const req = new Request("http://lab/api/money/revenue-reports/z/analyze", { method: "POST", body: form });
    const { input, token } = await readReportForm(req, { businessId: 7, userId: 8 }, "z");
    assert.equal(input.businessId, 7);
    assert.equal(input.userId, 8);
    assert.equal(input.kind, "z");
    assert.equal(token, "t");
  });

  console.log("== static ==");
  const read = (p: string) => fs.readFileSync(p, "utf8");
  const service = read("lib/revenue-sources/uploads/service.ts");
  await check("the service writes revenue truth and the run ledger only — never income, documents or bank lines", () => {
    for (const forbidden of [/financialRecord/i, /financialEvent/i, /billingDocument/i, /externalTransaction/i, /paymentTransaction/i, /\.(create|update|upsert|delete)(Many)?\(/]) {
      const hits = service.split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && forbidden.test(l));
      // `.create(` etc. only through import-run-store / revenue-truth store: the service itself issues no raw write.
      assert.deepEqual(hits, [], `${forbidden}: ${hits.join(" | ")}`);
    }
  });
  await check("every route is session-only, flag-gated, no-store; the business never comes from the request", () => {
    for (const p of [
      "app/api/money/revenue-reports/route.ts",
      "app/api/money/revenue-reports/z/analyze/route.ts",
      "app/api/money/revenue-reports/z/commit/route.ts",
      "app/api/money/revenue-reports/settlement/analyze/route.ts",
      "app/api/money/revenue-reports/settlement/commit/route.ts",
    ]) {
      const src = read(p);
      assert.equal(src.includes("reportRoute(req,"), true, p);
      assert.equal(/searchParams|req\.json|businessId:\s*Number/.test(src), false, p);
    }
    const http = read("lib/revenue-sources/uploads/http.ts");
    assert.equal(http.includes('"private, no-store"'), true);
    assert.equal(http.includes("getCurrentUser(req)"), true);
    assert.equal(http.includes("status: 404"), true);
  });
  await check("the screens never show a combined income figure and say the file is not kept", () => {
    const up = read("features/revenue-reports/upload-screen.tsx");
    const list = read("features/revenue-reports/list-screen.tsx");
    assert.equal(up.includes("הקובץ נבדק ולא נשמר בדוביז."), true);
    assert.equal(list.includes("אלה דוחות, לא רישומי הכנסה."), true);
    assert.equal(/reduce\(/.test(list), false, "the list sums nothing");
  });

  console.log(`\n[revenue-report-uploads core] PASS=${passed} FAIL=${failed}`);
  if (failed > 0 || passed === 0) process.exit(1);
}

void main();
