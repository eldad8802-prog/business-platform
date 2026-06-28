// Release Controller — tests (node:test, dependency-free)
//
// Run: node --test ops/release/controller/release-controller.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from './release-controller.mjs';
import { makeDecision, buildDecisionEvent } from './decision.mjs';
import { requiredPolicies, isLegalTransition } from './transition-policies.mjs';

const CTX = { decided_at: '2026-06-28T00:00:00.000Z' };

test('legal transition + all required policies pass -> allow + DecisionEvent object', () => {
  // Created -> Prepared requires Identity; provide VERIFIED.
  const d = decide({ release_id: 'r1', from_state: 'Created', to_state: 'Prepared', facts: { dbIdentityStatus: 'VERIFIED' }, context: CTX });
  assert.equal(d.result, 'allow');
  assert.equal(d.deciding_authority, 'controller');
  assert.ok(d.decision_event);
  assert.equal(d.decision_event.type, 'Prepared');
  assert.equal(d.decision_event.from_state, 'Created');
  assert.equal(d.decision_event.to_state, 'Prepared');
  assert.equal(d.decision_event.timestamp, CTX.decided_at);
});

test('illegal transition -> deny, no policies run, no event', () => {
  const d = decide({ release_id: 'r1', from_state: 'Created', to_state: 'Released', facts: {}, context: CTX });
  assert.equal(d.result, 'deny');
  assert.equal(d.decision_event, null);
  assert.match(d.reasons[0], /illegal transition Created -> Released/);
  assert.deepEqual(d.policy_results, []); // policies not consulted
});

test('policy fail (Identity not VERIFIED) -> deny', () => {
  const d = decide({ release_id: 'r1', from_state: 'Created', to_state: 'Prepared', facts: { dbIdentityStatus: 'INFERRED' }, context: CTX });
  assert.equal(d.result, 'deny');
  assert.equal(d.decision_event, null);
  assert.ok(d.reasons.some((x) => /Identity/.test(x)));
});

test('not-implemented policy -> deny (fail-closed)', () => {
  // Built -> Verified requires Verification/Migration/Config/Identity; only Identity is implemented.
  const d = decide({ release_id: 'r1', from_state: 'Built', to_state: 'Verified', facts: { dbIdentityStatus: 'VERIFIED' }, context: CTX });
  assert.equal(d.result, 'deny');
  assert.ok(d.reasons.some((x) => /not-implemented/.test(x)));
});

test('missing facts -> deny (fail-closed, no throw)', () => {
  const d = decide({ release_id: 'r1', from_state: 'Created', to_state: 'Prepared', facts: {}, context: CTX });
  assert.equal(d.result, 'deny');
  assert.ok(d.reasons.some((x) => /missing/i.test(x)));
});

test('necessary-not-sufficient: Identity pass alone is not enough when other policies are required', () => {
  // Built -> Verified: Identity VERIFIED but Verification/Migration/Config not implemented -> deny.
  const d = decide({ release_id: 'r1', from_state: 'Built', to_state: 'Verified', facts: { dbIdentityStatus: 'VERIFIED' }, context: CTX });
  assert.equal(d.result, 'deny');
});

test('Decision is explainable & provenance-aware', () => {
  const d = decide({ release_id: 'r1', from_state: 'Created', to_state: 'Prepared', facts: { dbIdentityStatus: 'VERIFIED', evidence_refs: ['ev-1'] }, context: CTX });
  assert.ok(d.reasons.length > 0);
  assert.ok(Array.isArray(d.policy_results) && d.policy_results.length === 1);
  assert.deepEqual(d.evidence_refs, ['ev-1']);
  assert.deepEqual(d.decision_event.evidence_refs, ['ev-1']);
});

test('Controller performs no Execution: injected engine is read-only; no append/mutation side-effect', () => {
  let evaluated = 0;
  const spyEngine = {
    evaluate: (names, facts) => {
      evaluated += 1;
      // emulate the real engine shape for an Identity pass
      return [{ policy: 'Identity', status: 'evaluated', verdict: { policy: 'Identity', result: 'pass', enforcement_level: 'block', reason: 'ok', evidence_refs: [], facts_ref: null } }];
    },
  };
  const facts = { dbIdentityStatus: 'VERIFIED' };
  const before = JSON.stringify(facts);
  const d = decide({ release_id: 'r1', from_state: 'Created', to_state: 'Prepared', facts, context: CTX }, { policyEngine: spyEngine });
  assert.equal(d.result, 'allow');
  assert.equal(evaluated, 1); // engine consulted, read-only
  assert.equal(JSON.stringify(facts), before); // facts not mutated
  // DecisionEvent is an object only (no event_id assigned here -> append is elsewhere)
  assert.equal('event_id' in d.decision_event, false);
});

test('ordering: DecisionEvent for an execution-dependent transition only when the fact is present', () => {
  // Promoted -> Released requires Health; with no Health policy implemented -> deny (cannot decide without the fact/verdict).
  const d = decide({ release_id: 'r1', from_state: 'Promoted', to_state: 'Released', facts: {}, context: CTX });
  assert.equal(d.result, 'deny'); // Controller does not fabricate the transition without the supporting fact/verdict
  assert.equal(d.decision_event, null);
});

test('determinism: same input -> same Decision', () => {
  const input = { release_id: 'r1', from_state: 'Created', to_state: 'Prepared', facts: { dbIdentityStatus: 'VERIFIED' }, context: CTX };
  assert.deepEqual(decide(input), decide(input));
});

test('transition-policies mapping reflects §10 and legal transitions', () => {
  assert.deepEqual(requiredPolicies('Built'), ['Verification', 'Migration', 'Config', 'Identity']);
  assert.deepEqual(requiredPolicies('Prepared'), ['Identity']);
  assert.equal(isLegalTransition('Created', 'Prepared'), true);
  assert.equal(isLegalTransition('Created', 'Released'), false);
});

test('decision/event model validation', () => {
  assert.throws(() => makeDecision({ release_id: 'r', from_state: 'a', to_state: 'b', result: 'maybe', reasons: ['x'] }), /result must be one of/);
  assert.throws(() => makeDecision({ release_id: 'r', from_state: 'a', to_state: 'b', result: 'allow', reasons: [] }), /reasons is required/);
  const ev = buildDecisionEvent({ release_id: 'r', from_state: 'Created', to_state: 'Prepared', decided_at: CTX.decided_at });
  assert.equal(ev.type, 'Prepared');
  assert.equal('event_id' in ev, false); // assigned at append-time, not by the Controller
});
