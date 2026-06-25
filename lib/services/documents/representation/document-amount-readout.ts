/**
 * T6 — Amount Readout (IN-MEMORY ONLY).
 *
 * Turns the T5 role decision into a single AmountReadout, without ANY keyword.
 * After MA-T2/RC5 it consumes the NEW representation only:
 *   - Class A — Arithmetic Total: a resolved total_candidate from the closure
 *     graph (Roles).
 *   - Ambiguous — competing terminals: the MoneyAmount currency-symbol marker may
 *     break a tie ONLY if exactly one terminal carries it; otherwise abstain.
 *   - Class B — Single Amount: read from MoneyAmount[] by structural UNIQUENESS
 *     over DISTINCT publishable values (equivalent repeats collapse → one fact).
 *
 * It no longer recomputes money from token markers. Never reads token meaning,
 * never keywords, never picks among competing distinct values, never fabricates.
 * Additive: Amount only, no DB, no production.
 */

import type {
  DocumentToken,
  Provenance,
  ResolutionState,
  Strength,
} from "./document-representation";
import { unestablishedStrength } from "./document-representation";
import type { NumericRef } from "./document-amount-relations";
import type { AmountRoleResult } from "./document-amount-roles";
import type { MoneyAmount } from "./document-money-amount";

export type AmountReadoutBasis =
  | "arithmetic_total"
  | "structural_uniqueness"
  | "equivalent_repeat"
  | "marker_corroborated_terminal"
  | null;

export type AmountReadout = {
  value: number | null;
  provenance: Provenance;
  resolutionState: ResolutionState;
  strength: Strength;
  /** How the value was obtained (transparency). */
  basis: AmountReadoutBasis;
};

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function refKey(ref: NumericRef): string {
  const b = ref.token.geometry.bbox;
  return b ? `p${ref.token.page}:${b.x},${b.y}` : `p${ref.token.page}:#${ref.id}`;
}

function tokenKey(token: DocumentToken): string {
  const b = token.geometry.bbox;
  return b ? `p${token.page}:${b.x},${b.y}` : `p${token.page}:nobox`;
}

function support(unit: string): Provenance {
  return { source: "structure", unit, derivedFrom: [] };
}

/** An amount is only meaningful when strictly positive. 0 / negative is not a value. */
function isPositiveAmount(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** Strong marker = an explicit currency symbol on the MoneyAmount. */
function hasStrongEvidence(ma: MoneyAmount | undefined): boolean {
  return Boolean(
    ma && (ma.moneyEvidence.includes("currency_symbol") || ma.moneyEvidence.includes("adjacent_symbol"))
  );
}

export function readAmount(
  roleResult: AmountRoleResult,
  moneyAmounts: MoneyAmount[]
): AmountReadout {
  // numeric source token → MoneyAmount (for terminal strong-marker lookup).
  const byToken = new Map<DocumentToken, MoneyAmount>();
  for (const ma of moneyAmounts) {
    const numericToken = ma.sourceTokens[ma.sourceTokens.length - 1];
    if (numericToken) byToken.set(numericToken, ma);
  }

  // Class A — arithmetic total from a resolved closure graph.
  if (
    roleResult.resolutionState === "resolved" &&
    roleResult.totalCandidate &&
    isPositiveAmount(roleResult.totalCandidate.refs[0].value)
  ) {
    const ref = roleResult.totalCandidate.refs[0];
    return {
      value: ref.value,
      resolutionState: "resolved",
      basis: "arithmetic_total",
      strength: {
        basis: "structural",
        supports: [support("arithmetic_total"), ...roleResult.totalCandidate.strength.supports],
      },
      provenance: { source: "readout", unit: "amount", derivedFrom: [refKey(ref)] },
    };
  }

  // Competing terminals — a currency-symbol marker may break the tie ONLY if
  // exactly one terminal carries it. It never picks when several compete.
  if (roleResult.resolutionState === "ambiguous") {
    const marked = roleResult.competingTerminals.filter(
      (t) => hasStrongEvidence(byToken.get(t.token)) && isPositiveAmount(t.value)
    );
    if (marked.length === 1) {
      const ref = marked[0];
      return {
        value: ref.value,
        resolutionState: "resolved",
        basis: "marker_corroborated_terminal",
        strength: {
          basis: "structural",
          supports: [support("terminal_result"), support("currency_symbol_marker")],
        },
        provenance: { source: "readout", unit: "amount", derivedFrom: [refKey(ref)] },
      };
    }
    return {
      value: null,
      resolutionState: "ambiguous",
      basis: null,
      strength: { basis: "structural", supports: [support("competing_totals")] },
      provenance: {
        source: "readout",
        unit: "amount",
        derivedFrom: roleResult.competingTerminals.map(refKey),
      },
    };
  }

  // Class B — no closure. Read from MoneyAmount[] by DISTINCT publishable value.
  // Equivalent repeats (same magnitude + commensurability) collapse to one fact.
  const byValue = new Map<string, MoneyAmount[]>();
  for (const ma of moneyAmounts) {
    if (!ma.publishable) continue;
    const k = `${round2(ma.magnitude)}|${ma.commensurabilityKey}`;
    const arr = byValue.get(k) ?? [];
    arr.push(ma);
    byValue.set(k, arr);
  }

  if (byValue.size === 1) {
    const group = [...byValue.values()][0];
    const value = round2(group[0].magnitude);
    const repeated = group.length >= 2;
    return {
      value,
      resolutionState: "resolved",
      basis: repeated ? "equivalent_repeat" : "structural_uniqueness",
      strength: {
        basis: "structural",
        supports: [support(repeated ? "repeated_equivalent_fact" : "sole_money_amount")],
      },
      provenance: {
        source: "readout",
        unit: "amount",
        derivedFrom: group.flatMap((ma) => ma.sourceTokens).map(tokenKey),
      },
    };
  }

  if (byValue.size >= 2) {
    return {
      value: null,
      resolutionState: "ambiguous",
      basis: null,
      strength: { basis: "structural", supports: [support("multiple_distinct_amounts")] },
      provenance: {
        source: "readout",
        unit: "amount",
        derivedFrom: [...byValue.values()].flatMap((g) => g.flatMap((ma) => ma.sourceTokens)).map(tokenKey),
      },
    };
  }

  // No publishable money amount and no closure → unresolved.
  return {
    value: null,
    resolutionState: "unresolved",
    basis: null,
    strength: unestablishedStrength(),
    provenance: { source: "readout", unit: "amount", derivedFrom: [] },
  };
}
