// Verdict — the result of a Policy that was EVALUATED (Release State Machine §2a)
//
// A Verdict is ALWAYS the outcome of a policy that actually ran, and is therefore
// strictly two-valued: pass | fail. "Policy not implemented" or "unknown policy"
// are NOT verdicts — they are represented separately by EvaluationResult.
//
// Pure, dependency-free, deterministic: timestamps/refs come from inputs.

export const VERDICT_RESULTS = Object.freeze(['pass', 'fail']);
export const ENFORCEMENT_LEVELS = Object.freeze(['report', 'warn', 'block']);

// Construct a validated Verdict. Throws on a malformed verdict so an invalid
// verdict can never be produced. (This is construction-time validation of OUR
// own output, not policy/business blocking.)
export function makeVerdict({ policy, result, enforcement_level = 'block', reason, evidence_refs = [], facts_ref = null }) {
  if (typeof policy !== 'string' || !policy.trim()) {
    throw new Error('[verdict] policy must be a non-empty string');
  }
  if (!VERDICT_RESULTS.includes(result)) {
    throw new Error(`[verdict] result must be one of ${VERDICT_RESULTS.join('|')} (got ${JSON.stringify(result)})`);
  }
  if (!ENFORCEMENT_LEVELS.includes(enforcement_level)) {
    throw new Error(`[verdict] enforcement_level must be one of ${ENFORCEMENT_LEVELS.join('|')}`);
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new Error('[verdict] reason is required (explainable)'); // explainable invariant
  }
  return {
    policy,
    result,
    enforcement_level,
    reason,
    evidence_refs: Array.isArray(evidence_refs) ? evidence_refs : [],
    facts_ref: facts_ref ?? null,
  };
}

export const pass = (policy, reason, opts = {}) => makeVerdict({ policy, result: 'pass', reason, ...opts });
export const fail = (policy, reason, opts = {}) => makeVerdict({ policy, result: 'fail', reason, ...opts });

// fail-closed helper: when a policy cannot reach a confident pass (e.g. missing
// facts), it returns a fail verdict — never pass-on-doubt. (block by default.)
export const failClosed = (policy, reason, opts = {}) =>
  makeVerdict({ policy, result: 'fail', enforcement_level: 'block', reason, ...opts });
