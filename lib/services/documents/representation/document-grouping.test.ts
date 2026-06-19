/**
 * T3 — Geometric grouping verify (run manually, NO network):
 *   npx tsx lib/services/documents/representation/document-grouping.test.ts
 *
 * Tests geometry-only grouping against synthetic representations.
 * No Vision API, no DB, no production paths, no content-based decisions.
 */

import type { OcrGeometryResult, OcrToken } from "../google-vision-ocr.service";
import { buildRepresentationFromOcr } from "./document-representation";
import { groupTokensGeometrically, type DocumentGroup } from "./document-grouping";

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

function rep(tokens: OcrToken[]) {
  const ocr: OcrGeometryResult = {
    text: tokens.map((t) => t.value).join(" "),
    tokens,
    geometryAvailable: tokens.some((t) => t.bbox !== null),
    pageCount: Math.max(1, ...tokens.map((t) => t.page)),
  };
  return buildRepresentationFromOcr(ocr);
}

const lines = (g: DocumentGroup[]) => g.filter((x) => x.groupType === "line");
const blocks = (g: DocumentGroup[]) => g.filter((x) => x.groupType === "block");
const columns = (g: DocumentGroup[]) => g.filter((x) => x.groupType === "column");
const tables = (g: DocumentGroup[]) => g.filter((x) => x.groupType === "tableCandidate");

// 1. line grouping: two y-bands → two lines; same band → one line
function verifyLineGrouping() {
  const r = rep([
    tok("A", 1, { x: 10, y: 287, width: 20, height: 20 }),
    tok("B", 1, { x: 40, y: 287, width: 20, height: 20 }),
    tok("C", 1, { x: 10, y: 355, width: 20, height: 20 }),
  ]);
  const { groups } = groupTokensGeometrically(r);
  ok("two line groups for two bands", lines(groups).length === 2);
  const top = lines(groups).find((l) => l.tokens.some((t) => t.value === "A"))!;
  ok("same-band tokens share a line", top.tokens.length === 2);
}

// 2. multi-page: groups per page, page preserved
function verifyMultiPage() {
  const r = rep([
    tok("P1", 1, { x: 1, y: 10, width: 5, height: 5 }),
    tok("P2", 2, { x: 1, y: 10, width: 5, height: 5 }),
  ]);
  const { groups } = groupTokensGeometrically(r);
  const lineGroups = lines(groups);
  ok("a line group on page 1", lineGroups.some((l) => l.page === 1));
  ok("a line group on page 2", lineGroups.some((l) => l.page === 2));
}

// 3. mixed RTL/LTR: Hebrew word + number on same band → same line, ordered by x
function verifyMixedRtl() {
  const r = rep([
    tok("21.90", 1, { x: 324, y: 476, width: 26, height: 12 }), // left
    tok("מרב", 1, { x: 443, y: 475, width: 15, height: 17 }),   // right (Hebrew)
  ]);
  const { groups } = groupTokensGeometrically(r);
  const ls = lines(groups);
  ok("hebrew + number on one line", ls.length === 1 && ls[0].tokens.length === 2);
  ok(
    "members ordered by x (geometry, not reading order)",
    ls[0].tokens[0].value === "21.90" && ls[0].tokens[1].value === "מרב"
  );
}

// 4. missing bbox → unplaced, not in groups, no crash
function verifyMissingBbox() {
  const r = rep([
    tok("HasBox", 1, { x: 1, y: 1, width: 5, height: 5 }),
    tok("NoBox", 1, null),
  ]);
  const { groups, unplacedTokens } = groupTokensGeometrically(r);
  ok("unplaced token captured", unplacedTokens.length === 1 && unplacedTokens[0].value === "NoBox");
  ok(
    "unplaced token not in any group",
    !groups.some((g) => g.tokens.some((t) => t.value === "NoBox"))
  );
}

// 5. coordinateMode pixels
function verifyPixels() {
  const r = rep([tok("X", 1, { x: 409, y: 287, width: 121, height: 63 })]);
  const { groups } = groupTokensGeometrically(r);
  ok("pixels mode propagated to groups", groups.every((g) => g.coordinateMode === "pixels"));
}

// 6. coordinateMode normalized — SAME ratios separate two normalized lines
function verifyNormalized() {
  const r = rep([
    tok("a", 1, { x: 0.1, y: 0.1, width: 0.05, height: 0.02 }),
    tok("b", 1, { x: 0.1, y: 0.3, width: 0.05, height: 0.02 }),
  ]);
  const { groups } = groupTokensGeometrically(r);
  ok("normalized mode propagated", groups.every((g) => g.coordinateMode === "normalized"));
  ok("two normalized lines via relative tolerance", lines(groups).length === 2);
}

// 7. provenance + structural strength (content-independent)
function verifyProvenanceAndStrength() {
  const r = rep([tok("Z", 1, { x: 5, y: 5, width: 5, height: 5 })]);
  const g = lines(groupTokensGeometrically(r).groups)[0];
  ok("group provenance source = grouping", g.provenance.source === "grouping");
  ok("group provenance unit = groupType", g.provenance.unit === "line");
  ok(
    "derivedFrom is geometric key (no value)",
    g.provenance.derivedFrom[0] === "p1:5,5"
  );
  ok("strength basis structural", g.strength.basis === "structural");
  ok("strength has no numeric score", g.strength.supports.every((s) => typeof s === "object"));
  ok("resolutionState set", g.resolutionState === "resolved");
}

// 8. independence from content: same geometry, different values → same structure
function verifyContentIndependence() {
  const geom: { x: number; y: number; width: number; height: number }[] = [
    { x: 10, y: 10, width: 20, height: 20 },
    { x: 40, y: 10, width: 20, height: 20 },
    { x: 10, y: 60, width: 20, height: 20 },
  ];
  const a = groupTokensGeometrically(
    rep(geom.map((b, i) => tok(`A${i}`, 1, b)))
  );
  const c = groupTokensGeometrically(
    rep([tok("סהכ", 1, geom[0]), tok("1,500.00", 1, geom[1]), tok("₪", 1, geom[2])])
  );
  ok(
    "same geometry → same line count regardless of content",
    lines(a.groups).length === lines(c.groups).length
  );
  ok(
    "same geometry → identical line bbox regardless of content",
    JSON.stringify(lines(a.groups).map((g) => g.bbox)) ===
      JSON.stringify(lines(c.groups).map((g) => g.bbox))
  );
}

// 9. blocks: 3 close lines + 1 far line → 2 blocks
function verifyBlocks() {
  const r = rep([
    tok("l1", 1, { x: 1, y: 10, width: 5, height: 10 }),
    tok("l2", 1, { x: 1, y: 30, width: 5, height: 10 }),
    tok("l3", 1, { x: 1, y: 50, width: 5, height: 10 }),
    tok("l4", 1, { x: 1, y: 200, width: 5, height: 10 }),
  ]);
  const { groups } = groupTokensGeometrically(r);
  ok("vertical gap splits into 2 blocks", blocks(groups).length === 2);
}

// 10. columns + tableCandidate: a 3×2 grid
function verifyTableCandidate() {
  const cells: OcrToken[] = [];
  const rows = [10, 30, 50];
  const cols = [100, 300];
  let i = 0;
  for (const y of rows) {
    for (const x of cols) {
      cells.push(tok(`c${i++}`, 1, { x, y, width: 20, height: 10 }));
    }
  }
  const { groups } = groupTokensGeometrically(rep(cells));
  ok("two columns detected", columns(groups).length === 2);
  ok("table candidate emitted", tables(groups).length >= 1);
  ok("table candidate is ambiguous", tables(groups).every((t) => t.resolutionState === "ambiguous"));
}

function main() {
  verifyLineGrouping();
  verifyMultiPage();
  verifyMixedRtl();
  verifyMissingBbox();
  verifyPixels();
  verifyNormalized();
  verifyProvenanceAndStrength();
  verifyContentIndependence();
  verifyBlocks();
  verifyTableCandidate();

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nT3 geometric grouping tests passed");
}

main();
