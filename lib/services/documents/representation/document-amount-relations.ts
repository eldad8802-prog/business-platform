/**
 * T4 — Relation: Arithmetic Amount Relations (IN-MEMORY ONLY).
 *
 * Finds arithmetic closures among MONEY-SHAPED tokens:
 *   - pairwise: a + b = c   (covers subtotal + VAT = total)
 *   - lineSum:  Σ(column) = c
 * and reports ambiguous (≥2 competing result candidates) or unresolved (none).
 *
 * Strictly geometry/arithmetic only. It NEVER reads a token's textual meaning:
 *   - no label scoring, no keywords ("סהכ"/"total"/"לתשלום"), no literals
 *   - no calibrated weights, no value-fabricating fallback
 *   - tokens are selected by NUMERIC SHAPE; closures by arithmetic; line sums by
 *     geometric column membership; strength by closure structure.
 *
 * This layer does NOT decide which value is "the total" and does NOT emit a final
 * Amount — that is Role / Field Readout (later). Additive: no DB, no production.
 */

import type {
  DocumentToken,
  Provenance,
  ResolutionState,
  Strength,
} from "./document-representation";
import { unestablishedStrength } from "./document-representation";
import type { DocumentGrouping } from "./document-grouping";

/** One cent — money's intrinsic granularity (allows half-cent rounding). Not a tuned threshold. */
const CENT = 0.01;
/** Performance guard for the pairwise search (documents never have this many clean money tokens). */
const MAX_NUMERICS_FOR_PAIRWISE = 120;

export type NumericRef = {
  id: number;
  value: number;
  exactText: string;
  token: DocumentToken;
  /** Set only on the MoneyAmount path: amounts sharing this key are commensurable. */
  commensurabilityKey?: string;
};

export type AmountClosure = {
  /**
   * pairwise: a + b = c.
   * lineSum: Σ(column) = c, where c is OUTSIDE the column.
   * inColumnTotal: c = Σ(other members of c's own column), where c is a value
   *   that REPEATS inside the column (subtotal=total=payment). Same closure
   *   form (result = Σ operands), different derivation rule.
   */
  kind: "pairwise" | "lineSum" | "inColumnTotal";
  operands: NumericRef[];
  resultCandidate: NumericRef;
  /** true when round-to-cents is exact; false when it closed within one cent. */
  exact: boolean;
};

export type AmountRelationType =
  | "arithmeticClosure"
  | "lineSum"
  | "ambiguousClosure"
  | "equivalentRepeat"
  | "unresolved";

/** A monetary value stated more than once (same magnitude + commensurability). */
export type EquivalenceGroup = {
  value: number;
  key: string;
  count: number;
  tokens: DocumentToken[];
};

export type AmountRelation = {
  relationType: AmountRelationType;
  /** Operands of the single resolved closure; empty when ambiguous/unresolved. */
  operands: NumericRef[];
  resultCandidate: NumericRef | null;
  /** Every closure found (for transparency / ambiguity). */
  closures: AmountClosure[];
  involvedTokens: DocumentToken[];
  resolutionState: ResolutionState;
  strength: Strength;
  provenance: Provenance;
  /** Set on the MoneyAmount path: repeated equivalent monetary facts. */
  equivalentGroups?: EquivalenceGroup[];
};

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Parse a token to a number by SHAPE only (no currency words, no labels).
 * Comma role is decided by shape:
 *   - comma followed by groups of exactly 3 digits → thousands separator (1,500)
 *   - a single comma followed by 1–2 digits at the end → decimal comma (8,60 → 8.60)
 */
export function parseMoneyShape(value: string): number | null {
  let v = String(value ?? "").trim();
  // strip currency SYMBOLS only (not words) and spaces
  v = v.replace(/[₪$€£]/g, "").replace(/\s+/g, "");
  if (v === "" || v === "-") return null;
  // only digits, commas and a decimal point may remain
  if (/[^\d.,-]/.test(v)) return null;

  const thousands = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/; // 1,500 / 1,500.00 / 12,345
  const plain = /^-?\d+(\.\d+)?$/; // 117 / 21.90
  const commaDecimal = /^-?\d+,\d{1,2}$/; // 8,60 / 12,5 (comma as decimal)

  if (thousands.test(v)) return Number(v.replace(/,/g, ""));
  if (plain.test(v)) return Number(v);
  if (commaDecimal.test(v)) return Number(v.replace(",", "."));
  return null;
}

function tokenKey(token: DocumentToken, fallbackId: number): string {
  const b = token.geometry.bbox;
  return b ? `p${token.page}:${b.x},${b.y}` : `p${token.page}:#${fallbackId}`;
}

export function collectNumericRefs(tokens: DocumentToken[]): NumericRef[] {
  const refs: NumericRef[] = [];
  let id = 0;
  for (const token of tokens) {
    const value = parseMoneyShape(token.value);
    if (value === null) continue;
    refs.push({ id: id++, value, exactText: token.value, token });
  }
  return refs;
}

function closes(sum: number, c: number): { ok: boolean; exact: boolean } {
  const rs = round2(sum);
  const rc = round2(c);
  return { ok: Math.abs(rs - rc) <= CENT + 1e-9, exact: rs === rc };
}

function closureKey(c: AmountClosure): string {
  const ops = c.operands
    .map((o) => o.id)
    .sort((a, b) => a - b)
    .join("+");
  return `${c.kind}:${ops}=${c.resultCandidate.id}`;
}

function findPairwiseClosures(refs: NumericRef[]): AmountClosure[] {
  const out: AmountClosure[] = [];
  if (refs.length > MAX_NUMERICS_FOR_PAIRWISE) return out;

  for (let i = 0; i < refs.length; i++) {
    for (let j = i + 1; j < refs.length; j++) {
      const sum = refs[i].value + refs[j].value;
      for (let k = 0; k < refs.length; k++) {
        if (k === i || k === j) continue;
        const r = closes(sum, refs[k].value);
        if (r.ok) {
          out.push({
            kind: "pairwise",
            operands: [refs[i], refs[j]],
            resultCandidate: refs[k],
            exact: r.exact,
          });
        }
      }
    }
  }
  return out;
}

function findLineSumClosures(
  refs: NumericRef[],
  grouping: DocumentGrouping
): AmountClosure[] {
  const out: AmountClosure[] = [];
  const byToken = new Map<DocumentToken, NumericRef>();
  for (const r of refs) byToken.set(r.token, r);

  for (const group of grouping.groups) {
    if (group.groupType !== "column") continue;

    const columnRefs = group.tokens
      .map((t) => byToken.get(t))
      .filter((r): r is NumericRef => r !== undefined);

    if (columnRefs.length < 2) continue;

    const columnIds = new Set(columnRefs.map((r) => r.id));
    const sum = columnRefs.reduce((s, r) => s + r.value, 0);

    for (const candidate of refs) {
      if (columnIds.has(candidate.id)) continue;
      const r = closes(sum, candidate.value);
      if (r.ok) {
        out.push({
          kind: "lineSum",
          operands: columnRefs,
          resultCandidate: candidate,
          exact: r.exact,
        });
      }
    }
  }
  return out;
}

function dedupeClosures(closures: AmountClosure[]): AmountClosure[] {
  const seen = new Map<string, AmountClosure>();
  for (const c of closures) {
    const key = closureKey(c);
    if (!seen.has(key)) seen.set(key, c);
  }
  return [...seen.values()];
}

function involvedTokensOf(closures: AmountClosure[]): DocumentToken[] {
  const set = new Set<DocumentToken>();
  for (const c of closures) {
    for (const o of c.operands) set.add(o.token);
    set.add(c.resultCandidate.token);
  }
  return [...set];
}

function structuralSupports(
  closures: AmountClosure[],
  uniqueResult: boolean
): Provenance[] {
  const supports: Provenance[] = [];
  supports.push({
    source: "arithmetic",
    unit: uniqueResult ? "unique_result" : "multiple_results",
    derivedFrom: [],
  });
  const allExact = closures.every((c) => c.exact);
  supports.push({
    source: "arithmetic",
    unit: allExact ? "exact_closure" : "tolerant_closure",
    derivedFrom: [],
  });
  supports.push({
    source: "arithmetic",
    unit: closures.length >= 2 ? "corroborated_closures" : "single_closure",
    derivedFrom: [],
  });
  const allPlaced = closures.every(
    (c) =>
      c.resultCandidate.token.geometry.bbox !== null &&
      c.operands.every((o) => o.token.geometry.bbox !== null)
  );
  supports.push({
    source: "geometry",
    unit: allPlaced ? "operands_geometrically_placed" : "operands_partially_placed",
    derivedFrom: [],
  });
  return supports;
}

export function findAmountRelations(
  tokens: DocumentToken[],
  grouping: DocumentGrouping
): AmountRelation {
  const refs = collectNumericRefs(tokens);

  const closures = dedupeClosures([
    ...findPairwiseClosures(refs),
    ...findLineSumClosures(refs, grouping),
  ]);

  const involved = involvedTokensOf(closures);
  const provenance: Provenance = {
    source: "relation",
    unit: "arithmetic_amount",
    derivedFrom: involved.map((t, idx) => tokenKey(t, idx)),
  };

  if (closures.length === 0) {
    return {
      relationType: "unresolved",
      operands: [],
      resultCandidate: null,
      closures: [],
      involvedTokens: [],
      resolutionState: "unresolved",
      strength: unestablishedStrength(),
      provenance,
    };
  }

  const distinctResults = new Set(closures.map((c) => c.resultCandidate.id));

  if (distinctResults.size >= 2) {
    return {
      relationType: "ambiguousClosure",
      operands: [],
      resultCandidate: null,
      closures,
      involvedTokens: involved,
      resolutionState: "ambiguous",
      strength: { basis: "structural", supports: structuralSupports(closures, false) },
      provenance,
    };
  }

  // Exactly one distinct result candidate — corroborating closures strengthen it.
  const primary = closures[0];
  const hasLineSum = closures.some((c) => c.kind === "lineSum");

  return {
    relationType: hasLineSum ? "lineSum" : "arithmeticClosure",
    operands: primary.operands,
    resultCandidate: primary.resultCandidate,
    closures,
    involvedTokens: involved,
    resolutionState: "resolved",
    strength: { basis: "structural", supports: structuralSupports(closures, true) },
    provenance,
  };
}

// ===========================================================================
// MA-T2 — relations over MoneyAmounts only (+ value-equivalence).
//
// Structural input (so this module does not import document-money-amount and
// no import cycle is created). A MoneyAmount satisfies this shape.
// ===========================================================================

export type MoneyAmountLike = {
  magnitude: number;
  commensurabilityKey: string;
  publishable: boolean;
  sourceTokens: DocumentToken[];
};

function moneyEquivKey(ref: NumericRef): string {
  return `${round2(ref.value)}|${ref.commensurabilityKey ?? "unknown"}`;
}

function refsFromMoneyAmounts(amounts: MoneyAmountLike[]): NumericRef[] {
  const refs: NumericRef[] = [];
  let id = 0;
  for (const a of amounts) {
    if (!a.publishable) continue; // 0 / negative never enters the graph
    const token = a.sourceTokens[a.sourceTokens.length - 1] ?? a.sourceTokens[0];
    if (!token) continue;
    refs.push({
      id: id++,
      value: round2(a.magnitude),
      exactText: token.value,
      token,
      commensurabilityKey: a.commensurabilityKey,
    });
  }
  return refs;
}

function equivalenceGroupsOf(refs: NumericRef[]): EquivalenceGroup[] {
  const byKey = new Map<string, NumericRef[]>();
  for (const r of refs) {
    const k = moneyEquivKey(r);
    const arr = byKey.get(k) ?? [];
    arr.push(r);
    byKey.set(k, arr);
  }
  const groups: EquivalenceGroup[] = [];
  for (const members of byKey.values()) {
    if (members.length >= 2) {
      groups.push({
        value: members[0].value,
        key: members[0].commensurabilityKey ?? "unknown",
        count: members.length,
        tokens: members.map((m) => m.token),
      });
    }
  }
  return groups;
}

/**
 * In-column total: within a monetary column, a value that REPEATS (equivalence
 * group, count >= 2) and equals the sum of the OTHER members of the same column.
 * Same closure form (result = Σ operands); the result lives INSIDE its column.
 * Geometry/arithmetic only — no labels, no scoring. If two distinct values each
 * satisfy this, both closures are emitted and the relation stays ambiguous.
 */
function findInColumnTotalClosures(
  refs: NumericRef[],
  grouping: DocumentGrouping
): AmountClosure[] {
  const out: AmountClosure[] = [];
  const byToken = new Map<DocumentToken, NumericRef>();
  for (const r of refs) byToken.set(r.token, r);

  for (const group of grouping.groups) {
    if (group.groupType !== "column") continue;

    const colRefs = group.tokens
      .map((t) => byToken.get(t))
      .filter((r): r is NumericRef => r !== undefined);
    if (colRefs.length < 3) continue;

    const byKey = new Map<string, NumericRef[]>();
    for (const r of colRefs) {
      const k = moneyEquivKey(r);
      const arr = byKey.get(k) ?? [];
      arr.push(r);
      byKey.set(k, arr);
    }

    for (const copies of byKey.values()) {
      if (copies.length < 2) continue; // value must repeat inside the column
      const v = round2(copies[0].value);
      const operands = colRefs.filter((r) => round2(r.value) !== v);
      if (operands.length < 2) continue;
      const sum = operands.reduce((acc, r) => acc + r.value, 0);
      const c = closes(sum, copies[0].value);
      if (c.ok) {
        out.push({
          kind: "inColumnTotal",
          operands,
          resultCandidate: copies[0],
          exact: c.exact,
        });
      }
    }
  }
  return out;
}

/**
 * Arithmetic relations over MoneyAmounts only. Phones/ids/years/barcodes are
 * already absent (they never became MoneyAmounts). Equivalent results (same
 * magnitude + commensurability) are NOT competitors. If there is no closure but
 * a value repeats, a `equivalentRepeat` relation is returned — WITHOUT selecting
 * it as the final amount.
 */
export function findAmountRelationsFromMoneyAmounts(
  amounts: MoneyAmountLike[],
  grouping: DocumentGrouping
): AmountRelation {
  const refs = refsFromMoneyAmounts(amounts);
  const eqGroups = equivalenceGroupsOf(refs);

  const closures = dedupeClosures([
    ...findPairwiseClosures(refs),
    ...findLineSumClosures(refs, grouping),
    ...findInColumnTotalClosures(refs, grouping),
  ]);
  const involved = involvedTokensOf(closures);
  const provenance: Provenance = {
    source: "relation",
    unit: "arithmetic_money_amount",
    derivedFrom: involved.map((t, idx) => tokenKey(t, idx)),
  };

  if (closures.length === 0) {
    if (eqGroups.length > 0) {
      return {
        relationType: "equivalentRepeat",
        operands: [],
        resultCandidate: null,
        closures: [],
        involvedTokens: eqGroups.flatMap((g) => g.tokens),
        resolutionState: "unresolved", // recognised, but NOT selected as final
        strength: {
          basis: "structural",
          supports: [{ source: "money", unit: "repeated_equivalent_fact", derivedFrom: [] }],
        },
        provenance: {
          source: "relation",
          unit: "arithmetic_money_amount",
          derivedFrom: eqGroups.flatMap((g) => g.tokens).map((t, idx) => tokenKey(t, idx)),
        },
        equivalentGroups: eqGroups,
      };
    }
    return {
      relationType: "unresolved",
      operands: [],
      resultCandidate: null,
      closures: [],
      involvedTokens: [],
      resolutionState: "unresolved",
      strength: unestablishedStrength(),
      provenance,
      equivalentGroups: [],
    };
  }

  // Equivalent results are the same fact, not competing terminals.
  const distinctResultKeys = new Set(closures.map((c) => moneyEquivKey(c.resultCandidate)));

  if (distinctResultKeys.size >= 2) {
    return {
      relationType: "ambiguousClosure",
      operands: [],
      resultCandidate: null,
      closures,
      involvedTokens: involved,
      resolutionState: "ambiguous",
      strength: { basis: "structural", supports: structuralSupports(closures, false) },
      provenance,
      equivalentGroups: eqGroups,
    };
  }

  const primary = closures[0];
  const hasSum = closures.some(
    (c) => c.kind === "lineSum" || c.kind === "inColumnTotal"
  );
  return {
    relationType: hasSum ? "lineSum" : "arithmeticClosure",
    operands: primary.operands,
    resultCandidate: primary.resultCandidate,
    closures,
    involvedTokens: involved,
    resolutionState: "resolved",
    strength: { basis: "structural", supports: structuralSupports(closures, true) },
    provenance,
    equivalentGroups: eqGroups,
  };
}
