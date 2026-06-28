// EvaluationResult — the outcome of asking the Policy Engine to evaluate a policy.
//
// Distinct from Verdict (which is ALWAYS a pass/fail of a policy that ran).
// EvaluationResult also represents the cases where no evaluation happened:
//   - evaluated        → the policy ran; `verdict` holds its pass/fail Verdict.
//   - not-implemented  → the policy is in the Policy Registry but has no
//                        implementation yet; `verdict` is null.
//   - unknown-policy   → the requested name is not in the Policy Registry;
//                        `verdict` is null.
//
// This keeps "Policy exists" vs "Policy implemented" vs "Policy evaluated" as
// three separate, single-meaning concepts. Pure, dependency-free.

export const EVALUATION_STATUSES = Object.freeze(['evaluated', 'not-implemented', 'unknown-policy']);

function make(policy, status, verdict) {
  return { policy, status, verdict: verdict ?? null };
}

export function evaluated(policy, verdict) {
  if (!verdict || typeof verdict !== 'object') {
    throw new Error('[evaluation-result] evaluated requires a Verdict');
  }
  return make(policy, 'evaluated', verdict);
}

export const notImplemented = (policy) => make(policy, 'not-implemented', null);
export const unknownPolicy = (policy) => make(policy, 'unknown-policy', null);

// Read helper (descriptive, NOT an authorization): did this evaluation reach a
// passing verdict? not-implemented / unknown-policy / fail are all non-pass
// (fail-closed). The Controller (future) decides what to do with this.
export function isPass(result) {
  return result.status === 'evaluated' && result.verdict?.result === 'pass';
}
