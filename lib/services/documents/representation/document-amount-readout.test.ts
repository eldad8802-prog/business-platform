/**
 * T6 — Amount readout verify (run manually, NO network):
 *   npx tsx lib/services/documents/representation/document-amount-readout.test.ts
 *
 * Consumes the NEW representation (MoneyAmount[] + Roles). No Vision, no DB, no keywords.
 */

import type { OcrGeometryResult, OcrToken } from "../google-vision-ocr.service";
import { buildRepresentationFromOcr } from "./document-representation";
import { groupTokensGeometrically } from "./document-grouping";
import { findAmountRelationsFromMoneyAmounts } from "./document-amount-relations";
import { deriveMoneyAmounts } from "./document-money-amount";
import { deriveAmountRoles } from "./document-amount-roles";
import { readAmount } from "./document-amount-readout";

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

// Full pipeline via the MoneyAmount path (matches the real Shadow pipeline).
function readout(tokens: OcrToken[]) {
  const ocr: OcrGeometryResult = {
    text: tokens.map((t) => t.value).join(" "),
    tokens,
    geometryAvailable: tokens.some((t) => t.bbox !== null),
    pageCount: Math.max(1, ...tokens.map((t) => t.page)),
  };
  const rep = buildRepresentationFromOcr(ocr);
  const grouping = groupTokensGeometrically(rep);
  const moneyAmounts = deriveMoneyAmounts(rep);
  const relation = findAmountRelationsFromMoneyAmounts(moneyAmounts, grouping);
  const roles = deriveAmountRoles(relation, grouping);
  return readAmount(roles, moneyAmounts);
}

// money-shaped line (cents) so tokens become MoneyAmounts
function line(values: string[], y = 10): OcrToken[] {
  return values.map((v, i) =>
    tok(v, 1, { x: 10 + i * 30, y, width: 20, height: 12 })
  );
}

// --- Class A ---------------------------------------------------------------

function verifyArithmeticClosure() {
  const r = readout(line(["100.00", "17.00", "117.00"]));
  ok("A: closure → resolved", r.resolutionState === "resolved");
  ok("A: closure → value 117", r.value === 117);
  ok("A: basis arithmetic_total", r.basis === "arithmetic_total");
}

function verifySubtotalVatTotal() {
  // 60 + 40 = 100 (subtotal), 100 + 17 = 117 (subtotal + VAT = total)
  const r = readout(line(["60.00", "40.00", "100.00", "17.00", "117.00"]));
  ok("A: subtotal+VAT+total → resolved", r.resolutionState === "resolved");
  ok("A: subtotal+VAT+total → value 117", r.value === 117);
}

// --- Class B (MoneyAmount[]) -----------------------------------------------

function verifySingleAmountBottom() {
  const r = readout([tok("500.00", 1, { x: 420, y: 700, width: 30, height: 12 })]);
  ok("B: single bottom → resolved", r.resolutionState === "resolved");
  ok("B: single bottom → value 500", r.value === 500);
  ok("B: basis structural_uniqueness", r.basis === "structural_uniqueness");
}

function verifySingleAmountCenter() {
  const r = readout([tok("₪500", 1, { x: 250, y: 350, width: 30, height: 12 })]);
  ok("B: single center → resolved (position not needed)", r.resolutionState === "resolved");
  ok("B: single center → value 500", r.value === 500);
}

// RC5 — repeated equivalent amount → resolved, NOT ambiguous
function verifyEquivalentRepeatResolves() {
  const r = readout([
    tok("1,500.00", 1, { x: 10, y: 10, width: 40, height: 12 }),
    tok("1,500.00", 1, { x: 10, y: 60, width: 40, height: 12 }),
  ]);
  ok("B: 1500 ×2 → resolved (equivalent, not ambiguous)", r.resolutionState === "resolved");
  ok("B: 1500 ×2 → value 1500", r.value === 1500);
  ok("B: basis equivalent_repeat", r.basis === "equivalent_repeat");
}

function verifyMultipleDistinctMarked() {
  // distinct marked amounts, none summing → ambiguous (do not pick)
  const r = readout(line(["100.00", "250.00", "75.00"]));
  ok("B: multiple DISTINCT marked → ambiguous", r.resolutionState === "ambiguous");
  ok("B: multiple DISTINCT marked → no value", r.value === null);
}

function verifyUnmarkedStandalone() {
  // bare integers → not MoneyAmounts → unresolved
  const r = readout(line(["100", "250", "75"]));
  ok("B: unmarked standalone → unresolved", r.resolutionState === "unresolved");
  ok("B: unmarked standalone → no value", r.value === null);
}

function verifyZeroGuard() {
  const r = readout([tok("0.00", 1, { x: 400, y: 700, width: 30, height: 12 })]);
  ok("lone 0.00 → unresolved (not 0)", r.resolutionState === "unresolved");
  ok("lone 0.00 → no value", r.value === null);
}

// --- Ambiguous terminals ---------------------------------------------------

// RC3-DER — repeated total inside the value column = Σ(items) → resolved
function verifyInColumnTotal() {
  const r = readout([
    tok("100.00", 1, { x: 300, y: 10, width: 30, height: 12 }),
    tok("50.00", 1, { x: 300, y: 30, width: 30, height: 12 }),
    tok("12.68", 1, { x: 300, y: 50, width: 30, height: 12 }),
    tok("162.68", 1, { x: 300, y: 70, width: 30, height: 12 }),
    tok("162.68", 1, { x: 300, y: 90, width: 30, height: 12 }),
  ]);
  ok("in-column total → resolved", r.resolutionState === "resolved");
  ok("in-column total → value 162.68", r.value === 162.68);
  ok("in-column total → basis arithmetic_total", r.basis === "arithmetic_total");
}

function verifyMarkerCorroboratedTerminal() {
  // two disconnected closures → two terminals; only one terminal carries ₪
  const r = readout([
    ...line(["100.00", "17.00", "117.00"], 10),
    tok("200.00", 1, { x: 300, y: 200, width: 20, height: 12 }),
    tok("50.00", 1, { x: 330, y: 200, width: 20, height: 12 }),
    tok("₪250.00", 1, { x: 360, y: 200, width: 30, height: 12 }),
  ]);
  ok("marker-corroborated terminal → resolved", r.resolutionState === "resolved");
  ok("marker-corroborated terminal → value 250", r.value === 250);
  ok("basis marker_corroborated_terminal", r.basis === "marker_corroborated_terminal");
}

function verifyAmbiguousTotals() {
  const r = readout([
    ...line(["100.00", "17.00", "117.00"], 10),
    ...["200.00", "50.00", "250.00"].map((v, i) =>
      tok(v, 1, { x: 300 + i * 30, y: 200, width: 20, height: 12 })
    ),
  ]);
  ok("ambiguous totals → ambiguous", r.resolutionState === "ambiguous");
  ok("ambiguous → no value (not picked)", r.value === null);
}

// --- image / PDF + content-independence ------------------------------------

function verifyCoordinateModes() {
  const pixels = readout(line(["100.00", "17.00", "117.00"]));
  const normalized = readout([
    tok("100.00", 1, { x: 0.1, y: 0.1, width: 0.05, height: 0.02 }),
    tok("17.00", 1, { x: 0.2, y: 0.1, width: 0.05, height: 0.02 }),
    tok("117.00", 1, { x: 0.3, y: 0.1, width: 0.05, height: 0.02 }),
  ]);
  ok("image (pixels) → value 117", pixels.value === 117);
  ok("PDF (normalized) → value 117", normalized.value === 117);
}

function verifyContentIndependence() {
  const a = readout([...line(["100.00", "17.00", "117.00"]), tok("TOTAL", 1, { x: 200, y: 10, width: 30, height: 12 })]);
  const b = readout([...line(["100.00", "17.00", "117.00"]), tok("סהכ לתשלום", 1, { x: 200, y: 10, width: 60, height: 12 })]);
  ok("labels never change the value (117)", a.value === 117 && b.value === 117);
}

function main() {
  verifyArithmeticClosure();
  verifySubtotalVatTotal();
  verifySingleAmountBottom();
  verifySingleAmountCenter();
  verifyEquivalentRepeatResolves();
  verifyMultipleDistinctMarked();
  verifyUnmarkedStandalone();
  verifyZeroGuard();
  verifyInColumnTotal();
  verifyMarkerCorroboratedTerminal();
  verifyAmbiguousTotals();
  verifyCoordinateModes();
  verifyContentIndependence();

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nT6 amount readout tests passed");
}

main();
