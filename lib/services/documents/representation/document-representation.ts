/**
 * T2 — Node Contract + Representation Container (IN-MEMORY ONLY).
 *
 * Defines the base representation that downstream derivation layers (T3+) will
 * read from: Token + Geometry + Provenance + Resolution State + Strength.
 *
 * Strictly additive and interpretation-free:
 *   - No DB, no persistence, no production wiring.
 *   - No Group / Relation / Role / Assertion / Amount detection.
 *   - No keywords, no literals, no score tuning, no thresholds.
 *
 * The only behaviour here is to carry T1 output (`runGoogleVisionOCRWithGeometry`)
 * into a typed container, never guessing anything that OCR did not provide.
 */

import type { OcrGeometryResult, OcrToken } from "../google-vision-ocr.service";

// --- Geometry ---------------------------------------------------------------

/**
 * image OCR (textDetection) returns PIXEL vertices.
 * PDF OCR (DOCUMENT_TEXT_DETECTION) returns NORMALIZED 0..1 vertices.
 * "unknown" when no token carried a box.
 */
export type CoordinateMode = "pixels" | "normalized" | "unknown";

export type BoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TokenGeometry = {
  /** null = OCR provided no usable box for this token. NEVER guessed. */
  bbox: BoundingBox | null;
  coordinateMode: CoordinateMode;
  /** Convenience mirror of (bbox !== null). */
  available: boolean;
};

// --- Provenance / Node contract --------------------------------------------

export type Provenance = {
  /** Origin of the content, e.g. "google_vision". */
  source: string;
  /** Granularity, e.g. "word". Optional. */
  unit?: string;
  page?: number;
  /** Upstream node/token references. Empty for raw tokens. */
  derivedFrom: string[];
};

export type ResolutionState = "resolved" | "ambiguous" | "unresolved";

/**
 * Structural placeholder — NOT a score.
 * T2 only ever emits `basis: "unestablished"`. Derived layers (T3+) will set
 * `basis: "structural"` and populate `supports` with the relations/zones that
 * justify the node. There is intentionally no numeric field to assign.
 */
export type Strength = {
  basis: "unestablished" | "structural";
  supports: Provenance[];
};

/**
 * Uniform contract for DERIVED nodes (Group / Relation / Role / Assertion).
 * Defined now so all later layers share one shape; no layer is built in T2.
 */
export type RepresentationNode<TContent> = {
  content: TContent;
  provenance: Provenance;
  resolutionState: ResolutionState;
  strength: Strength;
};

// --- Token / Representation -------------------------------------------------

export type DocumentToken = {
  value: string;
  /** Reserved for purely-technical normalization (e.g. whitespace). NOT semantic. Unset in T2. */
  normalizedValue?: string;
  page: number;
  geometry: TokenGeometry;
  confidence?: number | null;
  provenance: Provenance;
};

export type GeometryAvailability = "available" | "partial" | "unavailable";

export type DocumentRepresentation = {
  /** Verbatim OCR text (shadow copy from T1). Carried, never interpreted. */
  text: string;
  pageCount: number;
  coordinateMode: CoordinateMode;
  geometryAvailability: GeometryAvailability;
  tokens: DocumentToken[];
  source: Provenance;
};

// --- Helpers ----------------------------------------------------------------

/** Default strength for anything not yet established by structure. */
export function unestablishedStrength(): Strength {
  return { basis: "unestablished", supports: [] };
}

/**
 * Infer the coordinate space from the token boxes themselves:
 *   any coordinate > 1  → pixels
 *   else any coordinate > 0 (all ≤ 1) → normalized
 *   no boxes at all → unknown
 */
export function inferCoordinateMode(tokens: OcrToken[]): CoordinateMode {
  const coords: number[] = [];
  for (const t of tokens) {
    if (!t.bbox) continue;
    coords.push(t.bbox.x, t.bbox.y, t.bbox.width, t.bbox.height);
  }
  if (coords.length === 0) return "unknown";
  if (coords.some((v) => v > 1)) return "pixels";
  if (coords.some((v) => v > 0)) return "normalized";
  return "unknown";
}

function deriveGeometryAvailability(
  total: number,
  boxed: number
): GeometryAvailability {
  if (total === 0 || boxed === 0) return "unavailable";
  if (boxed === total) return "available";
  return "partial";
}

/**
 * Adapter: carry a T1 OCR result into the representation container.
 * Pure structural mapping — no interpretation, no guessing of missing boxes.
 */
export function buildRepresentationFromOcr(
  ocr: OcrGeometryResult,
  source?: Partial<Provenance>
): DocumentRepresentation {
  const coordinateMode = inferCoordinateMode(ocr.tokens);

  const tokens: DocumentToken[] = ocr.tokens.map((t) => ({
    value: t.value,
    page: t.page,
    geometry: {
      bbox: t.bbox, // null stays null — never fabricated
      coordinateMode,
      available: t.bbox !== null,
    },
    confidence: t.confidence,
    provenance: {
      source: t.provenance.source,
      unit: t.provenance.unit,
      page: t.provenance.page,
      derivedFrom: [],
    },
  }));

  const boxed = tokens.filter((t) => t.geometry.available).length;

  return {
    text: ocr.text,
    pageCount: ocr.pageCount,
    coordinateMode,
    geometryAvailability: deriveGeometryAvailability(tokens.length, boxed),
    tokens,
    source: {
      source: source?.source ?? "google_vision",
      unit: source?.unit,
      page: source?.page,
      derivedFrom: source?.derivedFrom ?? [],
    },
  };
}
