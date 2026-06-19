/**
 * T1 — Geometry Acquisition verify (run manually, NO network):
 *   npx tsx lib/services/documents/google-vision-ocr.geometry.test.ts
 *
 * Tests the PURE extraction helpers against simulated Vision responses.
 * Does not call the Vision API and does not touch production paths.
 */

import {
  boundingBoxFromPoly,
  extractTokensFromFullTextAnnotation,
  type VisionFullTextAnnotation,
} from "./google-vision-ocr.service";

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

// A word with vertices + symbols + confidence.
function word(
  text: string,
  vertices: { x: number; y: number }[] | null,
  confidence?: number
) {
  return {
    symbols: text.split("").map((ch) => ({ text: ch })),
    boundingBox: vertices ? { vertices } : null,
    ...(confidence !== undefined ? { confidence } : {}),
  };
}

function ftaFromWords(words: ReturnType<typeof word>[]): VisionFullTextAnnotation {
  return {
    text: words.map((w) => (w.symbols ?? []).map((s) => s.text).join("")).join(" "),
    pages: [{ blocks: [{ paragraphs: [{ words }] }] }],
  };
}

// 1. boundingBoxFromPoly: vertices → min/width/height
function verifyBoundingBoxFromVertices() {
  const box = boundingBoxFromPoly({
    vertices: [
      { x: 10, y: 20 },
      { x: 60, y: 20 },
      { x: 60, y: 50 },
      { x: 10, y: 50 },
    ],
  });
  ok("bbox x/y are min vertex", box?.x === 10 && box?.y === 20);
  ok("bbox width/height computed", box?.width === 50 && box?.height === 30);
}

// 2. boundingBoxFromPoly: normalizedVertices fallback + empty → null
function verifyBoundingBoxFallbacks() {
  const norm = boundingBoxFromPoly({
    normalizedVertices: [
      { x: 0.1, y: 0.2 },
      { x: 0.3, y: 0.4 },
    ],
  });
  ok("normalizedVertices used when vertices absent", norm !== null && norm.x === 0.1);

  ok("empty poly → null", boundingBoxFromPoly({ vertices: [] }) === null);
  ok("undefined poly → null", boundingBoxFromPoly(undefined) === null);
  ok(
    "vertices without numeric coords → null",
    boundingBoxFromPoly({ vertices: [{ x: null, y: null }] }) === null
  );
}

// 3. token extraction: value from symbols, bbox, confidence, page
function verifyTokenExtraction() {
  const fta = ftaFromWords([
    word("Total", [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 12 },
      { x: 0, y: 12 },
    ], 0.97),
    word("100.00", [
      { x: 50, y: 0 },
      { x: 110, y: 0 },
      { x: 110, y: 12 },
      { x: 50, y: 12 },
    ]),
  ]);

  const tokens = extractTokensFromFullTextAnnotation(fta, 1);

  ok("two tokens extracted", tokens.length === 2);
  ok("value reconstructed from symbols", tokens[0].value === "Total");
  ok("numeric value reconstructed", tokens[1].value === "100.00");
  ok("bbox present", tokens[0].bbox?.width === 40 && tokens[1].bbox?.x === 50);
  ok("confidence captured when present", tokens[0].confidence === 0.97);
  ok("confidence null when absent", tokens[1].confidence === null);
  ok("page number set", tokens[0].page === 1);
  ok(
    "provenance recorded",
    tokens[0].provenance.source === "google_vision" &&
      tokens[0].provenance.unit === "word"
  );
}

// 4. tokens without bbox → bbox null, NOT guessed
function verifyMissingBbox() {
  const fta = ftaFromWords([word("NoBox", null)]);
  const tokens = extractTokensFromFullTextAnnotation(fta, 1);
  ok("token still extracted without geometry", tokens.length === 1);
  ok("missing bbox is null (not guessed)", tokens[0].bbox === null);
}

// 5. image path shape (single fullTextAnnotation, page 1)
function verifyImageShape() {
  const fta = ftaFromWords([
    word("A", [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }]),
  ]);
  const tokens = extractTokensFromFullTextAnnotation(fta, 1);
  ok("image: page 1 tokens", tokens.length === 1 && tokens[0].page === 1);
}

// 6. PDF path shape: two page responses → page numbers 1 and 2
function verifyPdfPaging() {
  const pageResponses: { fullTextAnnotation: VisionFullTextAnnotation }[] = [
    { fullTextAnnotation: ftaFromWords([word("P1", [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }])]) },
    { fullTextAnnotation: ftaFromWords([word("P2", [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }])]) },
  ];

  const tokens = pageResponses.flatMap((p, i) =>
    extractTokensFromFullTextAnnotation(p.fullTextAnnotation, i + 1)
  );

  ok("pdf: two tokens across two pages", tokens.length === 2);
  ok("pdf: page numbers 1 and 2", tokens[0].page === 1 && tokens[1].page === 2);
}

// 7. empty / malformed annotation → no tokens, no throw
function verifyEmptyAnnotation() {
  ok("null fta → no tokens", extractTokensFromFullTextAnnotation(null, 1).length === 0);
  ok(
    "fta without pages → no tokens",
    extractTokensFromFullTextAnnotation({ text: "x" }, 1).length === 0
  );
}

function main() {
  verifyBoundingBoxFromVertices();
  verifyBoundingBoxFallbacks();
  verifyTokenExtraction();
  verifyMissingBbox();
  verifyImageShape();
  verifyPdfPaging();
  verifyEmptyAnnotation();

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nT1 geometry acquisition tests passed");
}

main();
