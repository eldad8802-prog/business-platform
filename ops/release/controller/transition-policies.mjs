// Transition → required Policies (Release State Machine §10) + legal-transition reuse.
//
// Metadata only: maps each target lifecycle state to the Policies the Controller
// must require before deciding the transition. Contains NO policy logic and NO
// decision logic. Pure, dependency-free except the (read-only) legal-transition
// table from the already-merged State Projection layer.

import { ALLOWED_TRANSITIONS } from '../event-log/state-projection.mjs';

// §10: which Policies are required to decide a transition INTO `to_state`.
// (Only Identity is implemented today; the rest resolve to not-implemented in the
// Policy Engine, which the Controller treats as fail-closed deny.)
export const TRANSITION_POLICIES = Object.freeze({
  Prepared: ['Identity'],
  Built: ['Verification', 'Migration', 'Config', 'Identity'],
  Verified: ['Verification', 'Migration', 'Config', 'Identity'],
  Approved: ['Approval'],
  Promoted: ['Promotion'],
  Released: ['Health'],
  Closed: ['Stability'],
  'Rolled-Back': ['Rollback'],
  // Created / Superseded / Failed / Aborted are not policy-gated here.
});

export function requiredPolicies(toState) {
  return TRANSITION_POLICIES[toState] || [];
}

// Read-only reuse of the canonical legal-transition table (single source).
export function isLegalTransition(fromState, toState) {
  const allowed = ALLOWED_TRANSITIONS[fromState] || [];
  return allowed.includes(toState);
}
