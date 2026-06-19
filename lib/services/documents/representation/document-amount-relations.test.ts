/**
 * T4 — Arithmetic amount relations verify (run manually, NO network):
 *   npx tsx lib/services/documents/representation/document-amount-relations.test.ts
 *
 * Geometry/arithmetic only — never reads token meaning. No Vision, no DB.
 */

import type { OcrGeometryResult, OcrToken } from "../google-vision-ocr.service";
import { buildRepresentationFromOcr } from "./document-representation";
import { groupTokensGeometrically } from "./document-grouping";
import {
  findAmountRelations,
  parseMoneyShape,
} from "./document-amount-relations";

let failed = 0;
function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

function tok(
  value: string,
  page: number,
  bbox: { x: number; y: number; width: number; height: number } | null
): OcrToken {
  return {
    value,
    page,
    bbox,
    confidence: 0,
    provenance: { source: "google_vision", unit: "word", page },
  };
}

function setup(tokens: OcrToken[]) {
  const ocr: OcrGeometryResult = {
    text: tokens.map((t) => t.value).join(" "),
    tokens,
    geometryAvailable: tokens.some((t) => t.bbox !== null),
    pageCount: 1,
  };
  const rep = buildRepresentationFromOcr(ocr);
  const grouping = groupTokensGeometrically(rep);
  return { rep, grouping };
}

function relate(tokens: OcrToken[]) {
  const { rep, grouping } = setup(tokens);
  return findAmountRelations(rep.tokens, grouping);
}

// helper: one line of money tokens (same y, increasing x) → no columns
function line(values: string[]): OcrToken[] {
  return values.map((v, i) =>
    tok(v, 1, { x: 10 + i * 30, y: 10, width: 20, height: 12 })
  );
}

// 0. parseMoneyShape rejects non-money shapes
function verifyParse() {
  ok("parses 1,500.00", parseMoneyShape("1,500.00") === 1500);
  ok("parses 1,500 (thousands)", parseMoneyShape("1,500") === 1500);
  ok("parses ₪117", parseMoneyShape("₪117") === 117);
  ok("parses 21.90", parseMoneyShape("21.90") === 21.9);
  ok("parses comma-decimal 8,60 → 8.60", parseMoneyShape("8,60") === 8.6);
  ok("parses comma-decimal 12,5 → 12.5", parseMoneyShape("12,5") === 12.5);
  ok("12,345 stays thousands → 12345", parseMoneyShape("12,345") === 12345);
  ok("rejects date 2026/02/16", parseMoneyShape("2026/02/16") === null);
  ok("rejects phone 02-6511900", parseMoneyShape("02-6511900") === null);
  ok("rejects id-with-letters 513461053b.m", parseMoneyShape("513461053b.m") === null);
  ok("rejects 1.538x", parseMoneyShape("1.538x") === null);
}

// 1. simple closure 100 + 17 = 117
function verifySimpleClosure() {
  const r = relate(line(["100", "17", "117"]));
  ok("simple → arithmeticClosure", r.relationType === "arithmeticClosure");
  ok("simple → resolved", r.resolutionState === "resolved");
  ok("simple result is 117", r.resultCandidate?.value === 117);
  ok(
    "simple operands are 100 and 17",
    r.operands.map((o) => o.value).sort((a, b) => a - b).join(",") === "17,100"
  );
}

// 2. VAT-like closure subtotal + VAT = total (no keywords used)
function verifyVatClosure() {
  const r = relate(line(["1000", "170", "1170"]));
  ok("vat-like → resolved", r.resolutionState === "resolved");
  ok("vat-like result 1170", r.resultCandidate?.value === 1170);
}

// 3. multiple closures → ambiguous
function verifyMultipleClosures() {
  const r = relate(line(["100", "17", "117", "33", "150"]));
  ok("multiple → ambiguousClosure", r.relationType === "ambiguousClosure");
  ok("multiple → ambiguous", r.resolutionState === "ambiguous");
  ok("multiple → no single result", r.resultCandidate === null);
  ok("multiple → ≥2 closures recorded", r.closures.length >= 2);
}

// 4. no closure → unresolved
function verifyNoClosure() {
  const r = relate(line(["100", "17", "200"]));
  ok("no closure → unresolved", r.relationType === "unresolved");
  ok("no closure → unresolved state", r.resolutionState === "unresolved");
  ok("no closure → strength unestablished", r.strength.basis === "unestablished");
}

// 5. decimal precision (exact + floating point)
function verifyDecimalPrecision() {
  const r = relate(line(["100.00", "17.00", "117.00"]));
  ok("decimals → result 117", r.resultCandidate?.value === 117);
  ok("decimals → exact closure", r.closures.every((c) => c.exact));

  const fp = relate(line(["0.1", "0.2", "0.3"]));
  ok("floating point 0.1+0.2=0.3 closes", fp.resolutionState === "resolved");
  ok("floating point closure is exact (round2)", fp.closures.every((c) => c.exact));
}

// 6. duplicate values 10 + 10 = 20
function verifyDuplicates() {
  const r = relate(line(["10", "10", "20"]));
  ok("duplicates → resolved", r.resolutionState === "resolved");
  ok("duplicates result 20", r.resultCandidate?.value === 20);
  ok(
    "duplicates use two distinct 10 tokens",
    r.operands.length === 2 && r.operands.every((o) => o.value === 10)
  );
}

// 7. tokens without geometry still participate, no crash
function verifyNoGeometry() {
  const r = relate([
    tok("100", 1, null), // no bbox
    tok("17", 1, { x: 40, y: 10, width: 20, height: 12 }),
    tok("117", 1, { x: 70, y: 10, width: 20, height: 12 }),
  ]);
  ok("no-geometry numeric still closes", r.relationType === "arithmeticClosure");
  ok("no-geometry result 117", r.resultCandidate?.value === 117);
  ok(
    "strength notes partial geometric placement",
    r.strength.supports.some((s) => s.unit === "operands_partially_placed")
  );
}

// 8. content-independence: labels never change the arithmetic
function verifyContentIndependence() {
  const withEnglish = relate([
    ...line(["100", "17", "117"]),
    tok("TOTAL", 1, { x: 200, y: 10, width: 30, height: 12 }),
    tok("Subtotal", 1, { x: 200, y: 30, width: 40, height: 12 }),
  ]);
  const withHebrew = relate([
    ...line(["100", "17", "117"]),
    tok("סהכ", 1, { x: 200, y: 10, width: 30, height: 12 }),
    tok("לתשלום", 1, { x: 200, y: 30, width: 40, height: 12 }),
  ]);
  ok("english labels → result 117", withEnglish.resultCandidate?.value === 117);
  ok("hebrew labels → result 117", withHebrew.resultCandidate?.value === 117);
  ok(
    "labels are not among involved tokens",
    !withHebrew.involvedTokens.some((t) =>
      ["סהכ", "לתשלום"].includes(t.value)
    )
  );
}

// 9. lineSum via geometric column: Σ(column) = total elsewhere
function verifyLineSum() {
  const tokens: OcrToken[] = [
    tok("7.00", 1, { x: 300, y: 10, width: 20, height: 12 }),
    tok("11.00", 1, { x: 300, y: 30, width: 20, height: 12 }),
    tok("13.00", 1, { x: 300, y: 50, width: 20, height: 12 }),
    tok("31.00", 1, { x: 520, y: 120, width: 20, height: 12 }), // total elsewhere
  ];
  const r = relate(tokens);
  ok("column sum → lineSum", r.relationType === "lineSum");
  ok("lineSum → resolved", r.resolutionState === "resolved");
  ok("lineSum result 31", r.resultCandidate?.value === 31);
  ok(
    "lineSum operands are the 3 column amounts",
    r.operands.length === 3 &&
      r.operands.map((o) => o.value).sort((a, b) => a - b).join(",") === "7,11,13"
  );
}

function main() {
  verifyParse();
  verifySimpleClosure();
  verifyVatClosure();
  verifyMultipleClosures();
  verifyNoClosure();
  verifyDecimalPrecision();
  verifyDuplicates();
  verifyNoGeometry();
  verifyContentIndependence();
  verifyLineSum();

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nT4 arithmetic amount relations tests passed");
}

main();
