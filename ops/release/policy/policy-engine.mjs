// Policy Engine — runs registered Policy Implementations and returns
// EvaluationResults (Release State Machine §2a).
//
// It returns Verdicts ONLY (wrapped in EvaluationResult). It is NOT a Controller
// (does not collect verdicts to decide), NOT a Gate (does not enforce/block),
// does not perform Migration/Verification, does not mutate the Registry, and does
// not write Events. Pure and side-effect-free: facts are supplied by the caller.
//
// Boundary: only the Identity Policy has an implementation in this layer. Every
// other registered policy resolves to `not-implemented` (no evaluation logic runs
// for it — no false impression of implementation). Unregistered names resolve to
// `unknown-policy`.

import { isRegistered, isImplemented } from './policy-registry.mjs';
import { evaluated, notImplemented, unknownPolicy, isPass } from './evaluation-result.mjs';
import * as identityPolicy from './policies/identity-policy.mjs';

// The wired Policy Implementations (only those with implemented: true in the Registry).
const IMPLEMENTATIONS = Object.freeze({
  Identity: identityPolicy.evaluate,
});

// Evaluate one policy by name. Returns an EvaluationResult.
export function evaluateOne(name, facts = {}, context = {}) {
  if (!isRegistered(name)) return unknownPolicy(name);
  if (!isImplemented(name) || !IMPLEMENTATIONS[name]) return notImplemented(name);
  const verdict = IMPLEMENTATIONS[name](facts, context);
  return evaluated(name, verdict);
}

// Evaluate several policies. Returns an array of EvaluationResults (Verdicts only,
// wrapped). No decision, no enforcement.
export function evaluate(names, facts = {}, context = {}) {
  const list = Array.isArray(names) ? names : [names];
  return list.map((name) => evaluateOne(name, facts, context));
}

// Descriptive summary for the caller (e.g. a future Controller). NOT a decision
// and NOT an authorization: it merely describes the evaluation results. Anything
// that is not an evaluated `pass` counts as non-pass (fail-closed reading).
export function summarize(results) {
  const blockingResults = results.filter(
    (r) => r.status !== 'evaluated' || r.verdict?.enforcement_level === 'block',
  );
  return {
    total: results.length,
    evaluated: results.filter((r) => r.status === 'evaluated').length,
    not_implemented: results.filter((r) => r.status === 'not-implemented').length,
    unknown: results.filter((r) => r.status === 'unknown-policy').length,
    // descriptive only — all block-level evaluations passed AND nothing is non-pass:
    all_block_level_passed: blockingResults.every((r) => isPass(r)),
  };
}
