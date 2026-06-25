/**
 * T5 — Role: Amount Role Slice (IN-MEMORY ONLY).
 *
 * Consumes T4's arithmetic relations and decides, using ONLY structure, which
 * value plays which role:
 *   - total_candidate : the terminal result of the closure graph
 *                       (a result that is never itself an operand)
 *   - line_item       : operands of a geometric column sum (lineSum)
 *   - intermediate    : subtotals (result AND operand) + summary operands (e.g. VAT)
 *   - summary_area     : the total + the non-line-item operands that produce it
 *
 * Decision basis: closure graph (in/out degree), geometric column membership
 * (already encoded in T4 lineSum closures), and structural position. It NEVER
 * reads token meaning, uses NO keywords, NO label scoring, NO hardcoded
 * confidence, NO blocklists, and NEVER fabricates a value.
 *
 * If two closures yield two competing terminal results → ambiguous (do not pick).
 * If there is no closure / no terminal → unresolved. Additive: no DB, no Role
 * for Vendor/Date/Direction/DocType, no Assertion, no Field Readout.
 */

import type {
  Provenance,
  ResolutionState,
  Strength,
} from "./document-representation";
import { unestablishedStrength } from "./document-representation";
import type { DocumentGrouping } from "./document-grouping";
import type { AmountClosure, AmountRelation, NumericRef } from "./document-amount-relations";

export type AmountRoleKind =
  | "total_candidate"
  | "line_item"
  | "intermediate"
  | "summary_area";

export type AmountRole = {
  kind: AmountRoleKind;
  refs: NumericRef[];
  closures: AmountClosure[];
  resolutionState: ResolutionState;
  strength: Strength;
  provenance: Provenance;
};

export type AmountRoleResult = {
  totalCandidate: AmountRole | null;
  lineItems: AmountRole | null;
  intermediates: AmountRole | null;
  summaryArea: AmountRole | null;
  /** Resolution of the TOTAL decision: resolved / ambiguous / unresolved. */
  resolutionState: ResolutionState;
  strength: Strength;
  provenance: Provenance;
  /** Competing terminals when ambiguous (transparency only; never auto-picked). */
  competingTerminals: NumericRef[];
};

function geomKey(ref: NumericRef): string {
  const b = ref.token.geometry.bbox;
  return b ? `p${ref.token.page}:${b.x},${b.y}` : `p${ref.token.page}:#${ref.id}`;
}

/** Two refs are the same monetary fact when magnitude (to cents) and unit match. */
function equivKey(ref: NumericRef): string {
  const v = Math.round(ref.value * 100) / 100;
  return `${v}|${ref.commensurabilityKey ?? "unknown"}`;
}

function structuralSupport(unit: string): Provenance {
  return { source: "structure", unit, derivedFrom: [] };
}

function makeRole(
  kind: AmountRoleKind,
  refs: NumericRef[],
  closures: AmountClosure[],
  resolutionState: ResolutionState,
  supportUnits: string[]
): AmountRole {
  return {
    kind,
    refs,
    closures,
    resolutionState,
    strength: { basis: "structural", supports: supportUnits.map(structuralSupport) },
    provenance: {
      source: "role",
      unit: kind,
      derivedFrom: refs.map(geomKey),
    },
  };
}

function uniqueById(refs: NumericRef[]): NumericRef[] {
  const seen = new Map<number, NumericRef>();
  for (const r of refs) if (!seen.has(r.id)) seen.set(r.id, r);
  return [...seen.values()];
}

export function deriveAmountRoles(
  relation: AmountRelation,
  _grouping: DocumentGrouping
): AmountRoleResult {
  const closures = relation.closures;

  const emptyProvenance: Provenance = {
    source: "role",
    unit: "amount_total",
    derivedFrom: [],
  };

  // No arithmetic structure → cannot establish a total structurally.
  if (closures.length === 0) {
    return {
      totalCandidate: null,
      lineItems: null,
      intermediates: null,
      summaryArea: null,
      resolutionState: "unresolved",
      strength: unestablishedStrength(),
      provenance: emptyProvenance,
      competingTerminals: [],
    };
  }

  // Build the closure graph.
  const nodes = new Map<number, NumericRef>();
  const inDeg = new Map<number, number>();
  const outDeg = new Map<number, number>();

  const touch = (r: NumericRef) => {
    nodes.set(r.id, r);
    if (!inDeg.has(r.id)) inDeg.set(r.id, 0);
    if (!outDeg.has(r.id)) outDeg.set(r.id, 0);
  };

  for (const c of closures) {
    touch(c.resultCandidate);
    inDeg.set(c.resultCandidate.id, (inDeg.get(c.resultCandidate.id) ?? 0) + 1);
    for (const o of c.operands) {
      touch(o);
      outDeg.set(o.id, (outDeg.get(o.id) ?? 0) + 1);
    }
  }

  // Terminal result(s): a result that is never used as an operand.
  const terminals = [...nodes.values()].filter(
    (r) => (inDeg.get(r.id) ?? 0) >= 1 && (outDeg.get(r.id) ?? 0) === 0
  );

  // Equivalent terminals (same magnitude + commensurability) are the SAME fact,
  // not competing — collapse them by equivalence key.
  const terminalsByKey = new Map<string, NumericRef[]>();
  for (const t of terminals) {
    const k = equivKey(t);
    const arr = terminalsByKey.get(k) ?? [];
    arr.push(t);
    terminalsByKey.set(k, arr);
  }
  const distinctTerminals = [...terminalsByKey.values()].map((g) => g[0]);

  // Line-item ids = operands of geometric column sums (outside-column or in-column).
  const lineItemIds = new Set<number>();
  for (const c of closures) {
    if (c.kind === "lineSum" || c.kind === "inColumnTotal") {
      for (const o of c.operands) lineItemIds.add(o.id);
    }
  }

  const provenanceAll: Provenance = {
    source: "role",
    unit: "amount_total",
    derivedFrom: [...nodes.values()].map(geomKey),
  };

  // Two or more DISTINCT terminals → genuinely competing → do not pick.
  if (distinctTerminals.length >= 2) {
    return {
      totalCandidate: null,
      lineItems: null,
      intermediates: null,
      summaryArea: null,
      resolutionState: "ambiguous",
      strength: { basis: "structural", supports: [structuralSupport("multiple_terminal_results")] },
      provenance: provenanceAll,
      competingTerminals: distinctTerminals,
    };
  }

  if (terminals.length === 0) {
    // closures form a cycle (arithmetically degenerate) — no sink to call total.
    return {
      totalCandidate: null,
      lineItems: null,
      intermediates: null,
      summaryArea: null,
      resolutionState: "unresolved",
      strength: unestablishedStrength(),
      provenance: provenanceAll,
      competingTerminals: [],
    };
  }

  // Exactly one terminal — the structural total candidate.
  const total = terminals[0];
  const totalProducing = closures.filter((c) => c.resultCandidate.id === total.id);
  const hasLineSum = closures.some((c) => c.kind === "lineSum");
  const corroborated = totalProducing.length >= 2;

  const lineItemRefs = [...nodes.values()].filter(
    (r) => lineItemIds.has(r.id) && r.id !== total.id
  );
  const intermediateRefs = [...nodes.values()].filter(
    (r) => r.id !== total.id && !lineItemIds.has(r.id)
  );
  const summaryRefs = uniqueById([
    total,
    ...totalProducing.flatMap((c) => c.operands).filter((o) => !lineItemIds.has(o.id)),
  ]);

  const totalSupports = [
    "graph_terminal_unique",
    hasLineSum ? "backed_by_line_item_sum" : "backed_by_pairwise_summary",
    corroborated ? "corroborated_closures" : "single_closure",
    total.token.geometry.bbox ? "total_geometrically_placed" : "total_geometry_missing",
  ];

  return {
    totalCandidate: makeRole("total_candidate", [total], totalProducing, "resolved", totalSupports),
    lineItems:
      lineItemRefs.length > 0
        ? makeRole(
            "line_item",
            lineItemRefs,
            closures.filter((c) => c.kind === "lineSum"),
            "resolved",
            ["geometric_column_sum"]
          )
        : null,
    intermediates:
      intermediateRefs.length > 0
        ? makeRole("intermediate", intermediateRefs, [], "resolved", ["non_terminal_summary_value"])
        : null,
    summaryArea: makeRole("summary_area", summaryRefs, totalProducing, "resolved", [
      "contains_total_and_summary_operands",
    ]),
    resolutionState: "resolved",
    strength: { basis: "structural", supports: totalSupports.map(structuralSupport) },
    provenance: provenanceAll,
    competingTerminals: [],
  };
}
