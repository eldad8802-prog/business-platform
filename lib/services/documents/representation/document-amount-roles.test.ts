/**
 * T5 — Amount role slice verify (run manually, NO network):
 *   npx tsx lib/services/documents/representation/document-amount-roles.test.ts
 *
 * Structural role decision over T4 relations. No Vision, no DB, no keywords.
 */

import type { OcrGeometryResult, OcrToken } from "../google-vision-ocr.service";
import { buildRepresentationFromOcr } from "./document-representation";
import { groupTokensGeometrically } from "./document-grouping";
import { findAmountRelations } from "./document-amount-relations";
import { deriveAmountRoles } from "./document-amount-roles";

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

function pipeline(tokens: OcrToken[]) {
  const ocr: OcrGeometryResult = {
    text: tokens.map((t) => t.value).join(" "),
    tokens,
    geometryAvailable: tokens.some((t) => t.bbox !== null),
    pageCount: Math.max(1, ...tokens.map((t) => t.page)),
  };
  const rep = buildRepresentationFromOcr(ocr);
  const grouping = groupTokensGeometrically(rep);
  const relation = findAmountRelations(rep.tokens, grouping);
  const roles = deriveAmountRoles(relation, grouping);
  return { relation, roles };
}

function line(values: string[], y = 10): OcrToken[] {
  return values.map((v, i) =>
    tok(v, 1, { x: 10 + i * 30, y, width: 20, height: 12 })
  );
}

const vals = (refs: { value: number }[] | undefined | null) =>
  (refs ?? []).map((r) => r.value).sort((a, b) => a - b).join(",");

// 1. single closure in a summary area
function verifySingleSummaryClosure() {
  const { roles } = pipeline(line(["100", "17", "117"]));
  ok("single summary → resolved", roles.resolutionState === "resolved");
  ok("total candidate is 117", roles.totalCandidate?.refs[0].value === 117);
  ok("intermediates are 100 & 17", vals(roles.intermediates?.refs) === "17,100");
  ok("no line items", roles.lineItems === null);
  ok("total strength structural", roles.totalCandidate?.strength.basis === "structural");
}

// 2. line-item table + separate total
function verifyLineItemsAndTotal() {
  const { roles } = pipeline([
    tok("7.00", 1, { x: 300, y: 10, width: 20, height: 12 }),
    tok("11.00", 1, { x: 300, y: 30, width: 20, height: 12 }),
    tok("13.00", 1, { x: 300, y: 50, width: 20, height: 12 }),
    tok("31.00", 1, { x: 520, y: 120, width: 20, height: 12 }),
  ]);
  ok("line-item case → resolved", roles.resolutionState === "resolved");
  ok("total candidate is 31", roles.totalCandidate?.refs[0].value === 31);
  ok("line items are 7,11,13", vals(roles.lineItems?.refs) === "7,11,13");
  ok("total backed by line-item sum", roles.totalCandidate?.strength.supports.some((s) => s.unit === "backed_by_line_item_sum") ?? false);
}

// 3. two closures (chained) → T4 ambiguous, T5 RESOLVES via graph terminal
function verifyAmbiguityReduction() {
  const { relation, roles } = pipeline(line(["50", "50", "17", "100", "117"]));
  ok("T4 saw ambiguous closures", relation.resolutionState === "ambiguous");
  ok("T5 resolves the total structurally", roles.resolutionState === "resolved");
  ok("T5 total candidate is 117 (terminal)", roles.totalCandidate?.refs[0].value === 117);
  ok("100 classified intermediate (subtotal)", (roles.intermediates?.refs ?? []).some((r) => r.value === 100));
}

// 4. two disconnected closures → no clear summary area → ambiguous, do NOT pick
function verifyNoClearSummary() {
  const { roles } = pipeline([
    ...line(["100", "17", "117"], 10),
    ...line(["200", "50", "250"], 200).map((t, i) => ({
      ...t,
      bbox: { x: 300 + i * 30, y: 200, width: 20, height: 12 },
    })),
  ]);
  ok("disconnected terminals → ambiguous", roles.resolutionState === "ambiguous");
  ok("ambiguous → no total picked", roles.totalCandidate === null);
  ok("ambiguous → competing terminals exposed", roles.competingTerminals.length >= 2);
}

// 5. single-amount document → no closure → unresolved (not enough structure)
function verifySingleAmount() {
  const { relation, roles } = pipeline([
    tok("500.00", 1, { x: 400, y: 300, width: 30, height: 12 }),
  ]);
  ok("single amount → T4 unresolved", relation.relationType === "unresolved");
  ok("single amount → T5 unresolved", roles.resolutionState === "unresolved");
  ok("single amount → no total candidate", roles.totalCandidate === null);
  ok("single amount → strength unestablished", roles.strength.basis === "unestablished");
}

// 6. content-independence: labels never change the structural total
function verifyContentIndependence() {
  const a = pipeline([
    ...line(["100", "17", "117"]),
    tok("TOTAL", 1, { x: 200, y: 10, width: 30, height: 12 }),
  ]);
  const b = pipeline([
    ...line(["100", "17", "117"]),
    tok("סהכ", 1, { x: 200, y: 10, width: 30, height: 12 }),
  ]);
  ok("english label → total 117", a.roles.totalCandidate?.refs[0].value === 117);
  ok("hebrew label → total 117", b.roles.totalCandidate?.refs[0].value === 117);
}

// 7. image + PDF coordinate modes both resolve the same structural total
function verifyCoordinateModes() {
  const pixels = pipeline(line(["100", "17", "117"])); // pixel coords
  const normalized = pipeline([
    tok("100", 1, { x: 0.1, y: 0.1, width: 0.05, height: 0.02 }),
    tok("17", 1, { x: 0.2, y: 0.1, width: 0.05, height: 0.02 }),
    tok("117", 1, { x: 0.3, y: 0.1, width: 0.05, height: 0.02 }),
  ]);
  ok("pixels → total 117", pixels.roles.totalCandidate?.refs[0].value === 117);
  ok("normalized → total 117", normalized.roles.totalCandidate?.refs[0].value === 117);
}

function main() {
  verifySingleSummaryClosure();
  verifyLineItemsAndTotal();
  verifyAmbiguityReduction();
  verifyNoClearSummary();
  verifySingleAmount();
  verifyContentIndependence();
  verifyCoordinateModes();

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nT5 amount role slice tests passed");
}

main();
