// Migration Gate — a pure Enforcement Boundary (Release State Machine §2a).
//
// It enforces the migration boundary based ONLY on the Release Controller's
// Decision, plus dedicated boundary checks. It deliberately does NOT:
//   - re-interpret EvaluationResults / policies (the Controller already did),
//   - read the DB Identity Registry,
//   - evaluate Identity / Migration / drift / schema itself,
//   - execute any migration,
//   - append events, mutate the Registry, or touch runtime/providers.
//
// `allowed` means ONLY: it is permitted to cross the migration boundary. It does
// NOT run a migration. Pure, dependency-free except the GateResult model.

import { allowed, blocked } from './gate-result.mjs';

const GATE = 'Migration';
const BOUNDARY = 'migration';

// The lifecycle transition(s) at which the migration boundary is enforced.
// (Migration is gated at the Built -> Verified transition; §10.)
const MIGRATION_TRANSITIONS = Object.freeze([{ from_state: 'Built', to_state: 'Verified' }]);

function isMigrationTransition(t) {
  return MIGRATION_TRANSITIONS.some((m) => m.from_state === t?.from_state && m.to_state === t?.to_state);
}

// Enforce the migration boundary. `input.decision` is the Controller's Decision.
// `input.context` may carry the boundary/transition being enforced + evaluated_at.
export function evaluateMigrationGate(input = {}) {
  const decision = input.decision || null;
  const context = input.context || {};
  const evaluated_at = context.evaluated_at ?? null;
  const opts = { evaluated_at };

  // Boundary check 1: a Decision must exist. (fail-closed)
  if (!decision || typeof decision !== 'object') {
    return blocked(GATE, BOUNDARY, ['no Decision supplied — migration boundary closed'], opts);
  }

  const transition = decision.requested_transition || null;
  const decision_ref = transition
    ? { from_state: transition.from_state, to_state: transition.to_state, result: decision.result }
    : { result: decision.result };

  // Boundary check 2: the Decision must pertain to the migration boundary/transition.
  if (!isMigrationTransition(transition)) {
    return blocked(
      GATE,
      BOUNDARY,
      [`Decision transition ${transition?.from_state} -> ${transition?.to_state} is not the migration boundary`],
      { ...opts, decision_ref },
    );
  }

  // Boundary check 3: the Decision must be `allow`. (Anything else → blocked.)
  // NOTE: when the Decision is `deny`, the Gate blocks because the Controller
  // already denied — the Gate does NOT re-interpret why (e.g. a not-implemented
  // Migration Policy is the Controller's concern, surfaced via the Decision).
  if (decision.result !== 'allow') {
    return blocked(GATE, BOUNDARY, ['Decision is not allow — migration boundary closed'], {
      ...opts,
      decision_ref,
      evidence_refs: Array.isArray(decision.evidence_refs) ? decision.evidence_refs : [],
    });
  }

  // All boundary checks passed → permitted to cross (does NOT run a migration).
  return allowed(GATE, BOUNDARY, ['Decision allows the migration transition — boundary open (crossing permitted, not executed)'], {
    ...opts,
    decision_ref,
    evidence_refs: Array.isArray(decision.evidence_refs) ? decision.evidence_refs : [],
  });
}
