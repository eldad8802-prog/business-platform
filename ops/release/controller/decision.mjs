// Decision + DecisionEvent models (Release State Machine §3/§14).
//
// A Decision is the Controller's authoritative output: allow | deny, explainable,
// provenance-aware. A DecisionEvent is the immutable record of a DECIDED
// transition (NOT a raw Execution-fact). The Controller BUILDS a DecisionEvent
// object only — appending it to the Event Log (History) is a separate
// orchestration/Execution step, out of scope for this layer.
//
// Pure, dependency-free, deterministic (timestamps come from inputs).

export const DECISION_RESULTS = Object.freeze(['allow', 'deny']);
export const DECIDING_AUTHORITIES = Object.freeze(['controller', 'owner']);

export function makeDecision({
  release_id,
  from_state,
  to_state,
  result,
  deciding_authority = 'controller',
  reasons,
  policy_results = [],
  evidence_refs = [],
  decided_at = null,
  decision_event = null,
}) {
  if (!DECISION_RESULTS.includes(result)) {
    throw new Error(`[decision] result must be one of ${DECISION_RESULTS.join('|')}`);
  }
  if (!DECIDING_AUTHORITIES.includes(deciding_authority)) {
    throw new Error(`[decision] deciding_authority must be one of ${DECIDING_AUTHORITIES.join('|')}`);
  }
  if (!Array.isArray(reasons) || reasons.length === 0) {
    throw new Error('[decision] reasons is required (explainable)');
  }
  return {
    release_id: release_id ?? null,
    requested_transition: { from_state: from_state ?? null, to_state: to_state ?? null },
    result,
    deciding_authority,
    reasons,
    policy_results,
    evidence_refs: Array.isArray(evidence_refs) ? evidence_refs : [],
    decided_at,
    decision_event: decision_event ?? null,
  };
}

// Build a DecisionEvent object (§14 shape). NOT appended here — returned only.
export function buildDecisionEvent({
  release_id,
  to_state,
  from_state,
  deciding_authority = 'controller',
  policy_results = [],
  evidence_refs = [],
  decided_at = null,
  preceding_event_id = null,
  approval_ref = null,
}) {
  return {
    // event_id is assigned at append-time by the Event Log layer (not here).
    release_id: release_id ?? null,
    type: to_state, // the decided transition milestone
    timestamp: decided_at,
    from_state: from_state ?? null,
    to_state: to_state ?? null,
    deciding_authority,
    policy_verdicts: policy_results,
    evidence_refs: Array.isArray(evidence_refs) ? evidence_refs : [],
    approval_ref: approval_ref ?? null,
    preceding_event_id: preceding_event_id ?? null,
  };
}
