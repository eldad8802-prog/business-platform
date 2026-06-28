// Policy Registry — the canonical list of which Policies EXIST in the system.
//
// This is metadata only (Release State Machine §2a). It records, per policy:
//   - name        : canonical policy name
//   - determines  : what the policy decides
//   - required_at : the transition where it is consumed
//   - implemented : whether a Policy Implementation exists yet
//
// "Policy exists in the Registry" is NOT "Policy is implemented". The Registry
// carries NO evaluation logic. Only `implemented: true` policies have a wired
// implementation (see policy-engine). Pure, dependency-free.

export const POLICY_REGISTRY = Object.freeze([
  { name: 'Identity', determines: 'DB Identity sufficient (Registry = VERIFIED)', required_at: 'Created->Prepared', implemented: true },
  { name: 'Verification', determines: 'build/lint/typecheck/tests criteria', required_at: 'Built->Verified', implemented: false },
  { name: 'Migration', determines: 'no-drift, schema match, no irreversible without approval', required_at: 'Built->Verified / Promotion', implemented: false },
  { name: 'Config', determines: 'required keys per scope', required_at: 'Built->Verified', implemented: false },
  { name: 'Approval', determines: 'who may approve and what a valid approval is', required_at: 'Verified->Approved', implemented: false },
  { name: 'Promotion', determines: 'Single-Target, Rollback Point required, preconditions', required_at: 'Approved->Promoted', implemented: false },
  { name: 'Health', determines: 'what a healthy Live is', required_at: 'Promoted->Released', implemented: false },
  { name: 'Rollback', determines: 'when to roll back (auto/human), Rollback Point validity', required_at: 'Released->Rolled-Back', implemented: false },
  { name: 'Stability', determines: 'what stability for closing is', required_at: 'Released->Closed', implemented: false },
]);

const BY_NAME = new Map(POLICY_REGISTRY.map((p) => [p.name, p]));

export function getPolicyRecord(name) {
  return BY_NAME.get(name) || null;
}

export function isRegistered(name) {
  return BY_NAME.has(name);
}

export function isImplemented(name) {
  return BY_NAME.get(name)?.implemented === true;
}
