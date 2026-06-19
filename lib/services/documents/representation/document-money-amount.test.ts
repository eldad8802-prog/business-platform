/**
 * MA-T1 — MoneyAmount τ foundation verify (run manually, NO network):
 *   npx tsx lib/services/documents/representation/document-money-amount.test.ts
 */

import type { OcrGeometryResult, OcrToken } from "../google-vision-ocr.service";
import { buildRepresentationFromOcr } from "./document-representation";
import { deriveMoneyAmounts, type MoneyAmount } from "./document-money-amount";

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
  bbox: { x: number; y: number; width: number; height: number } | null,
  page = 1
): OcrToken {
  return {
    value,
    page,
    bbox,
    confidence: 0,
    provenance: { source: "google_vision", unit: "word", page },
  };
}

function derive(tokens: OcrToken[]): MoneyAmount[] {
  const ocr: OcrGeometryResult = {
    text: tokens.map((t) => t.value).join(" "),
    tokens,
    geometryAvailable: tokens.some((t) => t.bbox !== null),
    pageCount: Math.max(1, ...tokens.map((t) => t.page)),
  };
  return deriveMoneyAmounts(buildRepresentationFromOcr(ocr));
}

const oneLine = (i: number) => ({ x: 10 + i * 40, y: 10, width: 30, height: 12 });

function verifyCents() {
  const m = derive([tok("21.90", oneLine(0))]);
  ok("21.90 → MoneyAmount", m.length === 1 && m[0].magnitude === 21.9);
  ok("21.90 → cents evidence", m[0].moneyEvidence.includes("cents"));
  ok("21.90 → publishable", m[0].publishable === true);
}

function verifyThousands() {
  const m = derive([tok("1,500.00", oneLine(0))]);
  ok("1,500.00 → MoneyAmount magnitude 1500", m.length === 1 && m[0].magnitude === 1500);
  ok("1,500.00 → thousands + cents evidence",
    m[0].moneyEvidence.includes("thousands") && m[0].moneyEvidence.includes("cents"));

  const t = derive([tok("1,500", oneLine(0))]);
  ok("1,500 → MoneyAmount magnitude 1500 (thousands preserved)", t.length === 1 && t[0].magnitude === 1500);
}

function verifyCommaDecimal() {
  const m = derive([tok("8,60", oneLine(0))]);
  ok("8,60 → MoneyAmount magnitude 8.60", m.length === 1 && m[0].magnitude === 8.6);
  ok("8,60 → cents evidence (comma-decimal)", m[0].moneyEvidence.includes("cents"));
  ok("8,60 → publishable", m[0].publishable === true);
}

function verifyAdjacentSymbol() {
  const m = derive([
    tok("₪", { x: 100, y: 10, width: 8, height: 12 }),
    tok("500", { x: 110, y: 10, width: 24, height: 12 }),
  ]);
  ok("₪ + 500 → MoneyAmount magnitude 500", m.length === 1 && m[0].magnitude === 500);
  ok("₪ + 500 → adjacent_symbol evidence", m[0].moneyEvidence.includes("adjacent_symbol"));
  ok("₪ + 500 → unit ILS", m[0].unit === "ILS");
  ok("₪ + 500 → both tokens in sourceTokens", m[0].sourceTokens.length === 2);
}

function verifyWithinSymbol() {
  const m = derive([tok("$1,200.00", oneLine(0))]);
  ok("$1,200.00 → MoneyAmount", m.length === 1 && m[0].magnitude === 1200);
  ok("$1,200.00 → currency_symbol evidence + USD",
    m[0].moneyEvidence.includes("currency_symbol") && m[0].unit === "USD");
}

function verifyRejections() {
  ok("2026 (year) → not money", derive([tok("2026", oneLine(0))]).length === 0);
  ok("0505668802 (phone) → not money", derive([tok("0505668802", oneLine(0))]).length === 0);
  ok("312260110 (id) → not money", derive([tok("312260110", oneLine(0))]).length === 0);
  ok("long barcode → not money", derive([tok("00031305024903", oneLine(0))]).length === 0);
  ok("bare 117 → not money", derive([tok("117", oneLine(0))]).length === 0);
}

function verifyZeroNonPublishable() {
  const m = derive([tok("0.00", oneLine(0))]);
  ok("0.00 → candidate produced (cents)", m.length === 1);
  ok("0.00 → NOT publishable", m[0].publishable === false);
}

function verifyContentIndependence() {
  const a = derive([tok("21.90", oneLine(0)), tok("TOTAL", oneLine(1))]);
  const b = derive([tok("21.90", oneLine(0)), tok("סהכ", oneLine(1))]);
  ok("english label ignored", a.length === 1 && a[0].magnitude === 21.9);
  ok("hebrew label ignored", b.length === 1 && b[0].magnitude === 21.9);
  ok("words never become money amounts", a.every((x) => x.magnitude === 21.9));
}

function verifyProvenance() {
  const m = derive([tok("9.90", { x: 5, y: 7, width: 20, height: 12 })]);
  ok("provenance source", m[0].provenance.source === "money_amount");
  ok("provenance derivedFrom geometric", m[0].provenance.derivedFrom[0] === "p1:5,7");
  ok("strength structural", m[0].strength.basis === "structural");
}

function verifyCoordinateModes() {
  const pixels = derive([
    tok("₪", { x: 100, y: 10, width: 8, height: 12 }),
    tok("500", { x: 110, y: 10, width: 24, height: 12 }),
  ]);
  const normalized = derive([
    tok("₪", { x: 0.10, y: 0.10, width: 0.008, height: 0.012 }),
    tok("500", { x: 0.11, y: 0.10, width: 0.024, height: 0.012 }),
  ]);
  ok("pixels adjacency → money 500", pixels.length === 1 && pixels[0].magnitude === 500);
  ok("normalized adjacency → money 500", normalized.length === 1 && normalized[0].magnitude === 500);
}

function main() {
  verifyCents();
  verifyThousands();
  verifyCommaDecimal();
  verifyAdjacentSymbol();
  verifyWithinSymbol();
  verifyRejections();
  verifyZeroNonPublishable();
  verifyContentIndependence();
  verifyProvenance();
  verifyCoordinateModes();

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nMA-T1 MoneyAmount foundation tests passed");
}

main();
