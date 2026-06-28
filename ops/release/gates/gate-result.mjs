// GateResult — the output of an Enforcement Boundary (Gate).
//
// A Gate enforces a boundary based on the Controller's Decision; it does NOT
// decide, re-interpret policies, or execute anything. GateResult is two-valued
// (allowed | blocked), explainable, and provenance-aware. Pure, dependency-free.

export const GATE_RESULTS = Object.freeze(['allowed', 'blocked']);
export const ENFORCEMENT_LEVELS = Object.freeze(['report', 'warn', 'block']);

export function makeGateResult({
  gate,
  boundary,
  result,
  reasons,
  decision_ref = null,
  evidence_refs = [],
  enforcement_level = 'block',
  evaluated_at = null,
}) {
  if (typeof gate !== 'string' || !gate.trim()) {
    throw new Error('[gate-result] gate must be a non-empty string');
  }
  if (!GATE_RESULTS.includes(result)) {
    throw new Error(`[gate-result] result must be one of ${GATE_RESULTS.join('|')}`);
  }
  if (!ENFORCEMENT_LEVELS.includes(enforcement_level)) {
    throw new Error(`[gate-result] enforcement_level must be one of ${ENFORCEMENT_LEVELS.join('|')}`);
  }
  if (!Array.isArray(reasons) || reasons.length === 0) {
    throw new Error('[gate-result] reasons is required (explainable)');
  }
  return {
    gate,
    boundary: boundary ?? null,
    result,
    reasons,
    decision_ref: decision_ref ?? null,
    evidence_refs: Array.isArray(evidence_refs) ? evidence_refs : [],
    enforcement_level,
    evaluated_at: evaluated_at ?? null,
  };
}

export const allowed = (gate, boundary, reasons, opts = {}) =>
  makeGateResult({ gate, boundary, result: 'allowed', reasons, ...opts });

export const blocked = (gate, boundary, reasons, opts = {}) =>
  makeGateResult({ gate, boundary, result: 'blocked', reasons, ...opts });
