// Release Controller — the Single Authority / Decision Engine (Design v1 §3/§9).
//
// It DECIDES only. It collects supplied facts + EvaluationResults, validates the
// transition's legality against the current state, and produces a Decision
// (allow | deny) plus, on allow, a DecisionEvent OBJECT (§14). It performs NO
// Execution: no Event append, no Registry mutation, no Migration/Verification/
// Promotion, no Gate enforcement, no runtime, no provider access.
//
// Pure & deterministic: all inputs (facts, identity, state, context, the Policy
// Engine via deps) are supplied by the caller. The Controller never collects
// facts itself and never performs an Execution-fact's work.
//
// Ordering invariant (per ratification): a DecisionEvent for an execution-
// dependent transition can be created ONLY WHEN the corresponding Execution-fact
// already exists and is supplied as input. The Controller acts on existing facts;
// it neither performs nor waits for Execution.

import { isLegalTransition, requiredPolicies } from './transition-policies.mjs';
import { makeDecision, buildDecisionEvent } from './decision.mjs';
import * as defaultPolicyEngine from '../policy/policy-engine.mjs';
import { isPass } from '../policy/evaluation-result.mjs';

// Decide a single requested transition. `deps.policyEngine` is injectable.
export function decide(input, deps = {}) {
  const policyEngine = deps.policyEngine || defaultPolicyEngine;
  const {
    release_id = null,
    from_state = null,
    to_state = null,
    facts = {},
    context = {},
    deciding_authority = 'controller',
    preceding_event_id = null,
    approval_ref = null,
  } = input || {};

  const decided_at = context.decided_at ?? null;
  const base = { release_id, from_state, to_state, deciding_authority, decided_at };

  // 1) Legality first (§3): an illegal transition is denied without running policies.
  if (!isLegalTransition(from_state, to_state)) {
    return makeDecision({ ...base, result: 'deny', reasons: [`illegal transition ${from_state} -> ${to_state}`] });
  }

  // 2) Run the required Policies via the Policy Engine (Controller holds no policy logic).
  const required = requiredPolicies(to_state);
  const policy_results = policyEngine.evaluate(required, facts, context);
  const evidence_refs = policy_results.flatMap((r) => r.verdict?.evidence_refs || []);

  // 3) Fail-closed decision: allow ONLY if every required policy is evaluated-pass.
  const failing = policy_results.filter((r) => !isPass(r));
  if (failing.length > 0) {
    const reasons = failing.map((r) =>
      r.status === 'evaluated'
        ? `${r.policy}: ${r.verdict.reason}`
        : `${r.policy}: ${r.status}`,
    );
    return makeDecision({ ...base, result: 'deny', reasons, policy_results, evidence_refs });
  }

  // 4) allow → build (NOT append) the DecisionEvent object (§14).
  const decision_event = buildDecisionEvent({
    release_id,
    from_state,
    to_state,
    deciding_authority,
    policy_results,
    evidence_refs,
    decided_at,
    preceding_event_id,
    approval_ref,
  });

  const reasons = required.length
    ? [`all required policies passed for ${from_state} -> ${to_state}`]
    : [`transition ${from_state} -> ${to_state} requires no policies`];

  return makeDecision({ ...base, result: 'allow', reasons, policy_results, evidence_refs, decision_event });
}
