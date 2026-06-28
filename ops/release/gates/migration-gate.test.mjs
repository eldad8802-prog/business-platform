// Migration Gate — tests (node:test, dependency-free)
//
// Run: node --test ops/release/gates/migration-gate.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMigrationGate } from './migration-gate.mjs';
import { makeGateResult } from './gate-result.mjs';

const CTX = { evaluated_at: '2026-06-28T00:00:00.000Z' };

// Minimal Decision shape (as produced by the Release Controller).
function decision(result, from_state = 'Built', to_state = 'Verified', evidence_refs = []) {
  return { result, requested_transition: { from_state, to_state }, evidence_refs };
}

test('Decision allow + migration boundary-match -> allowed (object, not execution)', () => {
  const r = evaluateMigrationGate({ decision: decision('allow', 'Built', 'Verified', ['ev-1']), context: CTX });
  assert.equal(r.result, 'allowed');
  assert.equal(r.gate, 'Migration');
  assert.equal(r.boundary, 'migration');
  assert.equal(r.decision_ref.to_state, 'Verified');
  assert.deepEqual(r.evidence_refs, ['ev-1']);
  assert.match(r.reasons[0], /not executed/); // makes clear allowed != run
});

test('Decision deny -> blocked (Gate enforces; it does NOT re-interpret why)', () => {
  const r = evaluateMigrationGate({ decision: decision('deny'), context: CTX });
  assert.equal(r.result, 'blocked');
  assert.match(r.reasons[0], /not allow/);
});

test('Decision missing -> blocked (fail-closed)', () => {
  assert.equal(evaluateMigrationGate({ context: CTX }).result, 'blocked');
  assert.equal(evaluateMigrationGate({ decision: null }).result, 'blocked');
});

test('Decision for a non-migration transition -> blocked', () => {
  const r = evaluateMigrationGate({ decision: decision('allow', 'Created', 'Prepared'), context: CTX });
  assert.equal(r.result, 'blocked');
  assert.match(r.reasons[0], /not the migration boundary/);
});

test('not-implemented Migration Policy is NOT checked by the Gate; it blocks only via Decision=deny', () => {
  // The Controller would deny Built->Verified today (Migration Policy not-implemented).
  // The Gate sees only the Decision; it blocks because result=deny, not because it
  // inspected any policy.
  const denyDecision = decision('deny', 'Built', 'Verified');
  const r = evaluateMigrationGate({ decision: denyDecision, context: CTX });
  assert.equal(r.result, 'blocked');
  // The Gate never reads policy_results / EvaluationResults:
  assert.equal('policy_results' in r, false);
  assert.match(r.reasons[0], /not allow/);
});

test('Gate does not re-interpret policies: an allow Decision is honored as-is', () => {
  // Even if (hypothetically) policy details existed, the Gate only checks result+boundary.
  const d = { result: 'allow', requested_transition: { from_state: 'Built', to_state: 'Verified' }, evidence_refs: ['e'], policy_results: [{ policy: 'Migration', status: 'evaluated', verdict: { result: 'pass' } }] };
  const r = evaluateMigrationGate({ decision: d, context: CTX });
  assert.equal(r.result, 'allowed'); // honored via result, not via re-reading policy_results
});

test('explainability & provenance: reasons + decision_ref + evidence_refs carried', () => {
  const r = evaluateMigrationGate({ decision: decision('allow', 'Built', 'Verified', ['ev-9']), context: CTX });
  assert.ok(r.reasons.length > 0);
  assert.deepEqual(r.decision_ref, { from_state: 'Built', to_state: 'Verified', result: 'allow' });
  assert.deepEqual(r.evidence_refs, ['ev-9']);
  assert.equal(r.evaluated_at, CTX.evaluated_at);
});

test('no side effects / purity: input not mutated; allowed does not execute anything', () => {
  const d = decision('allow', 'Built', 'Verified', ['x']);
  const before = JSON.stringify(d);
  evaluateMigrationGate({ decision: d, context: CTX });
  assert.equal(JSON.stringify(d), before);
});

test('GateResult is two-valued; invalid result rejected', () => {
  assert.throws(() => makeGateResult({ gate: 'Migration', result: 'maybe', reasons: ['r'] }), /result must be one of allowed\|blocked/);
  assert.throws(() => makeGateResult({ gate: 'Migration', result: 'allowed', reasons: [] }), /reasons is required/);
});

test('determinism: same input -> same GateResult', () => {
  const input = { decision: decision('allow', 'Built', 'Verified', ['e']), context: CTX };
  assert.deepEqual(evaluateMigrationGate(input), evaluateMigrationGate(input));
});
