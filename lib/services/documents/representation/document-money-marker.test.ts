/**
 * Money class-marker verify (run manually, NO network):
 *   npx tsx lib/services/documents/representation/document-money-marker.test.ts
 */

import type { DocumentToken } from "./document-representation";
import {
  computeMoneyMarkers,
  detectWithinTokenMarker,
  hasStrongMarker,
  isMoneyAmountMarker,
} from "./document-money-marker";

let failed = 0;
function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

function token(
  value: string,
  bbox: { x: number; y: number; width: number; height: number } | null
): DocumentToken {
  return {
    value,
    page: 1,
    geometry: { bbox, coordinateMode: "pixels", available: bbox !== null },
    confidence: 0,
    provenance: { source: "google_vision", unit: "word", page: 1, derivedFrom: [] },
  };
}

function verifyWithinToken() {
  ok("₪500 → currency symbol marker", detectWithinTokenMarker("₪500")?.currencySymbol === true);
  ok("162.68 → cents marker", detectWithinTokenMarker("162.68")?.cents === true);
  ok("1,500 → thousands marker", detectWithinTokenMarker("1,500")?.thousands === true);
  ok("1,500 → NOT comma-decimal cents", detectWithinTokenMarker("1,500")?.cents === false);
  ok("8,60 → comma-decimal counts as cents", detectWithinTokenMarker("8,60")?.cents === true);
  ok("8,60 → not thousands", detectWithinTokenMarker("8,60")?.thousands === false);
  ok("117 (bare) → no marker", detectWithinTokenMarker("117") === null);
  ok("word 'total' → no marker", detectWithinTokenMarker("total") === null);
  ok("hebrew 'סהכ' → no marker", detectWithinTokenMarker("סהכ") === null);
}

function verifyClassifiers() {
  ok("isMoneyAmountMarker true for cents", isMoneyAmountMarker(detectWithinTokenMarker("9.90")!));
  ok("hasStrongMarker only for symbol", hasStrongMarker(detectWithinTokenMarker("9.90")!) === false);
  ok("hasStrongMarker true for ₪", hasStrongMarker(detectWithinTokenMarker("₪9")!) === true);
}

function verifyAdjacency() {
  // a lone "₪" token immediately left of "500" on the same line confers the symbol
  const tokens = [
    token("₪", { x: 100, y: 10, width: 8, height: 12 }),
    token("500", { x: 110, y: 10, width: 24, height: 12 }),
    token("117", { x: 400, y: 200, width: 24, height: 12 }), // far away, no symbol
  ];
  const markers = computeMoneyMarkers(tokens);
  const five = tokens[1];
  const oneSeventeen = tokens[2];
  ok("adjacent ₪ confers currency marker to 500", hasStrongMarker(markers.get(five)));
  ok("adjacency source recorded", markers.get(five)?.source === "adjacent_symbol");
  ok("far token gets no marker", markers.get(oneSeventeen) === undefined);
}

function verifyContentIndependence() {
  // markers depend on symbols/shapes, never on words
  const tokens = [
    token("117.00", { x: 1, y: 1, width: 5, height: 5 }),
    token("TOTAL", { x: 50, y: 1, width: 30, height: 5 }),
    token("סהכ", { x: 90, y: 1, width: 20, height: 5 }),
  ];
  const markers = computeMoneyMarkers(tokens);
  ok("117.00 marked (cents)", isMoneyAmountMarker(markers.get(tokens[0])));
  ok("TOTAL not marked", markers.get(tokens[1]) === undefined);
  ok("סהכ not marked", markers.get(tokens[2]) === undefined);
}

function main() {
  verifyWithinToken();
  verifyClassifiers();
  verifyAdjacency();
  verifyContentIndependence();

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nmoney class-marker tests passed");
}

main();
