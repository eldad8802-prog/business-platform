/**
 * T3 — Group: Geometric Grouping (IN-MEMORY ONLY).
 *
 * Builds lines / columns / blocks / table candidates from
 * `DocumentRepresentation.tokens` using ONLY geometry. Token `value` is copied
 * into groups for carry-through provenance but is NEVER read to make a grouping
 * decision. No keywords, no literals, no semantic zones, no amounts/dates/vendor.
 *
 * Tolerances are RELATIVE to the document's own measured scale (median token
 * height/width). Because they multiply per-document medians, the same ratios
 * behave identically for pixel (image) and normalized (PDF) coordinates — they
 * are geometric relationships, not pixel magic numbers and not tuned to any
 * specific document.
 *
 * Strictly additive: no DB, no persistence, no production wiring.
 * No Relation, no arithmetic, no Role, no Field Readout.
 */

import type {
  BoundingBox,
  CoordinateMode,
  DocumentRepresentation,
  DocumentToken,
  Provenance,
  ResolutionState,
  Strength,
} from "./document-representation";

// Structural ratios (relative to per-document median scale; unit-agnostic).
const SAME_LINE_CENTER_TOLERANCE_RATIO = 0.6; // vertical centres within 0.6×median height
const SAME_COLUMN_EDGE_TOLERANCE_RATIO = 0.6; // left edges within 0.6×median width
const BLOCK_GAP_RATIO = 1.8; // inter-line gap > 1.8×median gap → new block
const TABLE_MIN_ROWS = 3;
const TABLE_MIN_COLUMNS = 2;

export type GroupType = "line" | "column" | "block" | "tableCandidate";

export type DocumentGroup = {
  groupType: GroupType;
  tokens: DocumentToken[];
  /** Union of member boxes; null only if there were no boxed members. */
  bbox: BoundingBox | null;
  page: number;
  coordinateMode: CoordinateMode;
  provenance: Provenance;
  resolutionState: ResolutionState;
  strength: Strength;
};

export type DocumentGrouping = {
  groups: DocumentGroup[];
  /** Tokens with no bbox — never placed, never guessed. */
  unplacedTokens: DocumentToken[];
};

type PlacedToken = DocumentToken & { geometry: { bbox: BoundingBox } };

function isPlaced(t: DocumentToken): t is PlacedToken {
  return t.geometry.bbox !== null;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function centerY(t: PlacedToken): number {
  return t.geometry.bbox.y + t.geometry.bbox.height / 2;
}

function unionBbox(boxes: BoundingBox[]): BoundingBox | null {
  if (boxes.length === 0) return null;
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.width));
  const maxY = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Geometry-only provenance key — never uses token value. */
function geomKey(t: PlacedToken): string {
  return `p${t.page}:${t.geometry.bbox.x},${t.geometry.bbox.y}`;
}

function makeGroup(
  groupType: GroupType,
  members: PlacedToken[],
  page: number,
  coordinateMode: CoordinateMode,
  resolutionState: ResolutionState,
  supportUnit: string
): DocumentGroup {
  return {
    groupType,
    tokens: members,
    bbox: unionBbox(members.map((m) => m.geometry.bbox)),
    page,
    coordinateMode,
    provenance: {
      source: "grouping",
      unit: groupType,
      page,
      derivedFrom: members.map(geomKey),
    },
    resolutionState,
    strength: {
      basis: "structural",
      supports: [{ source: "geometry", unit: supportUnit, derivedFrom: [] }],
    },
  };
}

type Line = { members: PlacedToken[]; top: number; bottom: number };

function buildLines(tokens: PlacedToken[], medianHeight: number): Line[] {
  const tol = medianHeight * SAME_LINE_CENTER_TOLERANCE_RATIO;
  const sorted = [...tokens].sort((a, b) => centerY(a) - centerY(b));

  const lines: PlacedToken[][] = [];
  let current: PlacedToken[] = [];
  let currentMeanCy = 0;

  for (const t of sorted) {
    const cy = centerY(t);
    if (current.length === 0) {
      current = [t];
      currentMeanCy = cy;
      continue;
    }
    if (Math.abs(cy - currentMeanCy) <= tol) {
      current.push(t);
      currentMeanCy = mean(current.map(centerY));
    } else {
      lines.push(current);
      current = [t];
      currentMeanCy = cy;
    }
  }
  if (current.length > 0) lines.push(current);

  return lines.map((members) => ({
    members: [...members].sort(
      (a, b) => a.geometry.bbox.x - b.geometry.bbox.x
    ),
    top: Math.min(...members.map((m) => m.geometry.bbox.y)),
    bottom: Math.max(...members.map((m) => m.geometry.bbox.y + m.geometry.bbox.height)),
  }));
}

/** Split ordered lines into blocks by vertical gap relative to the median gap. */
function buildBlocks(lines: Line[]): Line[][] {
  if (lines.length === 0) return [];
  const ordered = [...lines].sort((a, b) => a.top - b.top);
  if (ordered.length === 1) return [ordered];

  const gaps: number[] = [];
  for (let i = 1; i < ordered.length; i++) {
    gaps.push(Math.max(0, ordered[i].top - ordered[i - 1].bottom));
  }
  const medianGap = median(gaps);
  const threshold = medianGap * BLOCK_GAP_RATIO;

  const blocks: Line[][] = [];
  let block: Line[] = [ordered[0]];
  for (let i = 1; i < ordered.length; i++) {
    const gap = ordered[i].top - ordered[i - 1].bottom;
    if (medianGap > 0 && gap > threshold) {
      blocks.push(block);
      block = [ordered[i]];
    } else {
      block.push(ordered[i]);
    }
  }
  blocks.push(block);
  return blocks;
}

/** Cluster tokens by left-edge x (alignment) across ≥2 lines. */
function buildColumns(
  tokens: PlacedToken[],
  medianWidth: number
): PlacedToken[][] {
  const tol = medianWidth * SAME_COLUMN_EDGE_TOLERANCE_RATIO;
  const sorted = [...tokens].sort(
    (a, b) => a.geometry.bbox.x - b.geometry.bbox.x
  );

  const clusters: PlacedToken[][] = [];
  let current: PlacedToken[] = [];
  let currentMeanX = 0;

  for (const t of sorted) {
    const x = t.geometry.bbox.x;
    if (current.length === 0) {
      current = [t];
      currentMeanX = x;
      continue;
    }
    if (Math.abs(x - currentMeanX) <= tol) {
      current.push(t);
      currentMeanX = mean(current.map((m) => m.geometry.bbox.x));
    } else {
      clusters.push(current);
      current = [t];
      currentMeanX = x;
    }
  }
  if (current.length > 0) clusters.push(current);

  // Keep only clusters that span ≥2 distinct vertical centres (i.e. ≥2 rows).
  return clusters.filter((c) => {
    const rows = new Set(c.map((t) => Math.round(centerY(t))));
    return rows.size >= 2;
  });
}

export function groupTokensGeometrically(
  rep: DocumentRepresentation
): DocumentGrouping {
  const unplacedTokens = rep.tokens.filter((t) => !isPlaced(t));
  const placed = rep.tokens.filter(isPlaced);

  const byPage = new Map<number, PlacedToken[]>();
  for (const t of placed) {
    const arr = byPage.get(t.page) ?? [];
    arr.push(t);
    byPage.set(t.page, arr);
  }

  const groups: DocumentGroup[] = [];

  for (const [page, pageTokens] of byPage) {
    const medianHeight = median(pageTokens.map((t) => t.geometry.bbox.height));
    const medianWidth = median(pageTokens.map((t) => t.geometry.bbox.width));

    // LINES
    const lines = buildLines(pageTokens, medianHeight);
    for (const line of lines) {
      groups.push(
        makeGroup("line", line.members, page, rep.coordinateMode, "resolved", "vertical_alignment")
      );
    }

    // BLOCKS
    const blocks = buildBlocks(lines);
    for (const block of blocks) {
      const members = block.flatMap((l) => l.members);
      groups.push(
        makeGroup("block", members, page, rep.coordinateMode, "resolved", "vertical_gap")
      );
    }

    // COLUMNS
    const columns = buildColumns(pageTokens, medianWidth);
    for (const column of columns) {
      groups.push(
        makeGroup(
          "column",
          column,
          page,
          rep.coordinateMode,
          column.length >= 3 ? "resolved" : "ambiguous",
          "x_alignment"
        )
      );
    }

    // TABLE CANDIDATE (light): a block with ≥TABLE_MIN_ROWS lines that overlaps
    // ≥TABLE_MIN_COLUMNS columns. Always ambiguous — it is a candidate.
    for (const block of blocks) {
      if (block.length < TABLE_MIN_ROWS) continue;
      const blockTop = Math.min(...block.map((l) => l.top));
      const blockBottom = Math.max(...block.map((l) => l.bottom));
      const overlappingColumns = columns.filter((c) =>
        c.some((t) => {
          const cy = centerY(t);
          return cy >= blockTop && cy <= blockBottom;
        })
      );
      if (overlappingColumns.length >= TABLE_MIN_COLUMNS) {
        const members = block.flatMap((l) => l.members);
        groups.push(
          makeGroup("tableCandidate", members, page, rep.coordinateMode, "ambiguous", "row_column_grid")
        );
      }
    }
  }

  return { groups, unplacedTokens };
}
