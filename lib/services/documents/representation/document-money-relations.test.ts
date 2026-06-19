/**
 * MA-T2 — relations over MoneyAmounts only + value-equivalence (NO network):
 *   npx tsx lib/services/documents/representation/document-money-relations.test.ts
 */

import type { OcrGeometryResult, OcrToken } from "../google-vision-ocr.service";
import { buildRepresentationFromOcr } from "./document-representation";
import { groupTokensGeometrically } from "./document-grouping";
import { deriveMoneyAmounts } from "./document-money-amount";
import { findAmountRelationsFromMoneyAmounts } from "./document-amount-relations";

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

function relate(tokens: OcrToken[]) {
  const ocr: OcrGeometryResult = {
    text: tokens.map((t) => t.value).join(" "),
    tokens,
    geometryAvailable: tokens.some((t) => t.bbox !== null),
    pageCount: 1,
  };
  const rep = buildRepresentationFromOcr(ocr);
  const grouping = groupTokensGeometrically(rep);
  const amounts = deriveMoneyAmounts(rep);
  return findAmountRelationsFromMoneyAmounts(amounts, grouping);
}

const lineAt = (i: number, y = 10) => ({ x: 10 + i * 40, y, width: 30, height: 12 });

// 1. phones / ids / barcodes never enter the closure graph
function verifyNoiseExcluded() {
  // values chosen so that, as bare numbers, spurious closures WOULD form,
  // but as money amounts only the cents-marked ones participate.
  const r = relate([
    tok("100.00", lineAt(0)),
    tok("17.00", lineAt(1)),
    tok("117.00", lineAt(2)),
    tok("0505668802", lineAt(3)), // phone
    tok("312260110", lineAt(4)), // id
    tok("00031305024903", lineAt(5)), // barcode
    tok("2026", lineAt(6)), // year
  ]);
  ok("noise excluded → closure still found among money", r.relationType === "arithmeticClosure");
  ok("noise excluded → result 117", r.resultCandidate?.value === 117);
  ok(
    "no noise token among involved",
    !r.involvedTokens.some((t) => ["0505668802", "312260110", "00031305024903", "2026"].includes(t.value))
  );
}

// 2. same amount twice → equivalentRepeat, NOT ambiguous
function verifyEquivalentRepeat() {
  const r = relate([
    tok("1,500.00", lineAt(0, 10)),
    tok("1,500.00", lineAt(0, 40)),
  ]);
  ok("repeated 1500 → equivalentRepeat", r.relationType === "equivalentRepeat");
  ok("repeated 1500 → not ambiguous", r.resolutionState !== "ambiguous");
  ok("repeated 1500 → equivalence group recorded", (r.equivalentGroups ?? []).some((g) => g.value === 1500 && g.count === 2));
  ok("repeated 1500 → combined provenance (2 tokens)", (r.equivalentGroups ?? [])[0]?.tokens.length === 2);
}

// 3. real closure on money amounts works
function verifyClosure() {
  const r = relate([tok("100.00", lineAt(0)), tok("17.00", lineAt(1)), tok("117.00", lineAt(2))]);
  ok("money closure → resolved", r.resolutionState === "resolved");
  ok("money closure → 117", r.resultCandidate?.value === 117);
}

// 4. two genuinely different closures → ambiguous
function verifyTwoClosures() {
  const r = relate([
    tok("100.00", lineAt(0)),
    tok("17.00", lineAt(1)),
    tok("117.00", lineAt(2)),
    tok("33.00", lineAt(3)),
    tok("150.00", lineAt(4)),
  ]);
  ok("two different closures → ambiguous", r.relationType === "ambiguousClosure");
}

// 5. equivalent results corroborate (not competing): 100+17=117 and also 117 repeated
function verifyEquivalentResultsNotCompeting() {
  // 60+57=117 and 100+17=117 → same result value 117 → resolved, not ambiguous
  const r = relate([
    tok("60.00", lineAt(0)),
    tok("57.00", lineAt(1)),
    tok("100.00", lineAt(2)),
    tok("17.00", lineAt(3)),
    tok("117.00", lineAt(4)),
  ]);
  ok("equivalent results → resolved (not ambiguous)", r.resolutionState === "resolved");
  ok("equivalent results → 117", r.resultCandidate?.value === 117);
}

// 6. content-independence
function verifyContentIndependence() {
  const a = relate([tok("100.00", lineAt(0)), tok("17.00", lineAt(1)), tok("117.00", lineAt(2)), tok("TOTAL", lineAt(3))]);
  const b = relate([tok("100.00", lineAt(0)), tok("17.00", lineAt(1)), tok("117.00", lineAt(2)), tok("סהכ", lineAt(3))]);
  ok("labels do not change result (117)", a.resultCandidate?.value === 117 && b.resultCandidate?.value === 117);
}

// column: same x, increasing y (forms a T3 column)
function column(values: string[], x = 300): OcrToken[] {
  return values.map((v, i) =>
    tok(v, { x, y: 10 + i * 20, width: 30, height: 12 })
  );
}

// in-column total: repeated total = Σ(3 items in same column) → resolved
function verifyInColumnTotal() {
  const r = relate(column(["100.00", "50.00", "12.68", "162.68", "162.68"]));
  ok("in-column total → resolved", r.resolutionState === "resolved");
  ok("in-column total → result 162.68", r.resultCandidate?.value === 162.68);
  ok(
    "in-column total → closure kind inColumnTotal present",
    r.closures.some((c) => c.kind === "inColumnTotal")
  );
}

// single (non-repeated) total in column → in-column-total does NOT fire
function verifyInColumnTotalNeedsRepeat() {
  const r = relate(column(["100.00", "50.00", "12.68", "162.68"]));
  ok(
    "single in-column total → no inColumnTotal closure",
    !r.closures.some((c) => c.kind === "inColumnTotal")
  );
  ok("single in-column total → not resolved via sum", r.resolutionState !== "resolved");
}

// two distinct in-column totals (two columns) → ambiguous, do not pick
function verifyInColumnTotalUniqueness() {
  const r = relate([
    ...column(["30.00", "20.00", "50.00", "50.00"], 100),
    ...column(["41.00", "33.00", "74.00", "74.00"], 400),
  ]);
  ok("two distinct in-column totals → ambiguous", r.resolutionState === "ambiguous");
  ok("two distinct in-column totals → no single result", r.resultCandidate === null);
}

function main() {
  verifyNoiseExcluded();
  verifyEquivalentRepeat();
  verifyClosure();
  verifyTwoClosures();
  verifyEquivalentResultsNotCompeting();
  verifyContentIndependence();
  verifyInColumnTotal();
  verifyInColumnTotalNeedsRepeat();
  verifyInColumnTotalUniqueness();

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nMA-T2 money relations tests passed");
}

main();
