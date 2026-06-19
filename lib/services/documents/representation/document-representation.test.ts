/**
 * T2 — Representation container verify (run manually, NO network):
 *   npx tsx lib/services/documents/representation/document-representation.test.ts
 *
 * Tests the in-memory container + T1 adapter against synthetic OCR results.
 * No Vision API, no DB, no production paths.
 */

import type { OcrGeometryResult, OcrToken } from "../google-vision-ocr.service";
import {
  buildRepresentationFromOcr,
  inferCoordinateMode,
  unestablishedStrength,
  type RepresentationNode,
} from "./document-representation";

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
  page: number,
  bbox: { x: number; y: number; width: number; height: number } | null,
  confidence: number | null
): OcrToken {
  return {
    value,
    page,
    bbox,
    confidence,
    provenance: { source: "google_vision", unit: "word", page },
  };
}

function ocrResult(tokens: OcrToken[], pageCount = 1): OcrGeometryResult {
  return {
    text: tokens.map((t) => t.value).join(" "),
    tokens,
    geometryAvailable: tokens.some((t) => t.bbox !== null),
    pageCount,
  };
}

// 1. create representation from tokens
function verifyBuild() {
  const ocr = ocrResult([
    token("חשבונית", 1, { x: 455, y: 435, width: 34, height: 16 }, 0),
    token("21.90", 1, { x: 324, y: 476, width: 26, height: 12 }, 0),
  ]);
  const rep = buildRepresentationFromOcr(ocr, { source: "google_vision" });
  ok("token count carried", rep.tokens.length === 2);
  ok("text carried verbatim", rep.text === "חשבונית 21.90");
  ok("pageCount carried", rep.pageCount === 1);
}

// 2. bbox valid (carried through unchanged)
function verifyBbox() {
  const ocr = ocrResult([token("X", 1, { x: 10, y: 20, width: 30, height: 40 }, 0.9)]);
  const rep = buildRepresentationFromOcr(ocr);
  const g = rep.tokens[0].geometry;
  ok("bbox carried", g.bbox?.x === 10 && g.bbox?.width === 30 && g.bbox?.height === 40);
  ok("geometry.available true when bbox present", g.available === true);
}

// 3. image coordinate mode (pixels: coords > 1)
function verifyImageMode() {
  const ocr = ocrResult([token("A", 1, { x: 409, y: 287, width: 121, height: 63 }, 0)]);
  ok("inferCoordinateMode → pixels", inferCoordinateMode(ocr.tokens) === "pixels");
  ok("representation coordinateMode pixels", buildRepresentationFromOcr(ocr).coordinateMode === "pixels");
}

// 4. PDF coordinate mode (normalized: all coords ≤ 1)
function verifyPdfMode() {
  const ocr = ocrResult([
    token("ROYAL", 1, { x: 0.4554, y: 0.051, width: 0.0235, height: 0.0071 }, 0.98),
  ]);
  ok("inferCoordinateMode → normalized", inferCoordinateMode(ocr.tokens) === "normalized");
  ok("representation coordinateMode normalized", buildRepresentationFromOcr(ocr).coordinateMode === "normalized");
}

// 5. token without bbox → geometry unavailable, NOT guessed
function verifyMissingBbox() {
  const ocr = ocrResult([
    token("HasBox", 1, { x: 1, y: 1, width: 5, height: 5 }, 0),
    token("NoBox", 1, null, 0),
  ]);
  const rep = buildRepresentationFromOcr(ocr);
  const noBox = rep.tokens.find((t) => t.value === "NoBox")!;
  ok("missing bbox stays null (not guessed)", noBox.geometry.bbox === null);
  ok("missing bbox → available false", noBox.geometry.available === false);
  ok("mixed boxes → geometryAvailability partial", rep.geometryAvailability === "partial");

  const allMissing = buildRepresentationFromOcr(ocrResult([token("N", 1, null, null)]));
  ok("all missing → geometryAvailability unavailable", allMissing.geometryAvailability === "unavailable");
  ok("no boxes → coordinateMode unknown", allMissing.coordinateMode === "unknown");
}

// 6. provenance preserved
function verifyProvenance() {
  const ocr = ocrResult([token("Y", 2, { x: 1, y: 1, width: 2, height: 2 }, 0)]);
  const rep = buildRepresentationFromOcr(ocr);
  const p = rep.tokens[0].provenance;
  ok("provenance source preserved", p.source === "google_vision");
  ok("provenance unit preserved", p.unit === "word");
  ok("provenance page preserved", p.page === 2);
  ok("token derivedFrom empty (raw token)", Array.isArray(p.derivedFrom) && p.derivedFrom.length === 0);
}

// 7. Strength placeholder is structural, not a score
function verifyStrengthPlaceholder() {
  const s = unestablishedStrength();
  ok("strength basis unestablished", s.basis === "unestablished");
  ok("strength has no numeric score (supports array only)", Array.isArray(s.supports) && s.supports.length === 0);
}

// 8. Node contract is usable for future derived nodes (type-level smoke)
function verifyNodeContract() {
  const node: RepresentationNode<{ note: string }> = {
    content: { note: "placeholder" },
    provenance: { source: "t2", derivedFrom: [] },
    resolutionState: "unresolved",
    strength: unestablishedStrength(),
  };
  ok("node contract holds content+provenance+resolutionState+strength",
    node.resolutionState === "unresolved" && node.strength.basis === "unestablished");
}

function main() {
  verifyBuild();
  verifyBbox();
  verifyImageMode();
  verifyPdfMode();
  verifyMissingBbox();
  verifyProvenance();
  verifyStrengthPlaceholder();
  verifyNodeContract();

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nT2 representation container tests passed");
}

main();
