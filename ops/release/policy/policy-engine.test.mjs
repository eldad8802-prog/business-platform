// Policy Engine + Verdict/EvaluationResult — tests (node:test, dependency-free)
//
// Run: node --test ops/release/policy/policy-engine.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeVerdict, pass, fail, failClosed } from './verdict.mjs';
import { evaluated, notImplemented, unknownPolicy, isPass } from './evaluation-result.mjs';
import { POLICY_REGISTRY, isImplemented, isRegistered } from './policy-registry.mjs';
import { evaluateOne, evaluate, summarize } from './policy-engine.mjs';

test('Verdict is two-valued: pass/fail only; invalid result rejected', () => {
  assert.equal(pass('Identity', 'ok').result, 'pass');
  assert.equal(fail('Identity', 'no').result, 'fail');
  assert.throws(() => makeVerdict({ policy: 'X', result: 'unavailable', reason: 'r' }), /result must be one of pass\|fail/);
});

test('Verdict requires a reason (explainable) and valid enforcement_level', () => {
  assert.throws(() => makeVerdict({ policy: 'X', result: 'pass', reason: '' }), /reason is required/);
  assert.throws(() => makeVerdict({ policy: 'X', result: 'pass', reason: 'r', enforcement_level: 'nope' }), /enforcement_level/);
});

test('Verdict is provenance-aware: evidence_refs + facts_ref carried through', () => {
  const v = pass('Identity', 'ok', { evidence_refs: ['e1'], facts_ref: 'f1' });
  assert.deepEqual(v.evidence_refs, ['e1']);
  assert.equal(v.facts_ref, 'f1');
});

test('Identity Policy: VERIFIED -> pass; INFERRED/UNKNOWN/SUSPECT -> fail', () => {
  const r = evaluateOne('Identity', { dbIdentityStatus: 'VERIFIED' });
  assert.equal(r.status, 'evaluated');
  assert.equal(r.verdict.result, 'pass');
  for (const s of ['INFERRED', 'UNKNOWN', 'SUSPECT']) {
    const f = evaluateOne('Identity', { dbIdentityStatus: s });
    assert.equal(f.verdict.result, 'fail');
  }
});

test('Identity Policy fail-closed on missing facts (fail verdict — NOT not-implemented)', () => {
  const r = evaluateOne('Identity', {}); // no dbIdentityStatus
  assert.equal(r.status, 'evaluated'); // it ran
  assert.equal(r.verdict.result, 'fail'); // and failed closed
  assert.match(r.verdict.reason, /missing/i);
});

test('registered-but-not-implemented policy -> not-implemented, verdict null, no logic run', () => {
  assert.equal(isRegistered('Verification'), true);
  assert.equal(isImplemented('Verification'), false);
  const r = evaluateOne('Verification', { anything: true });
  assert.equal(r.status, 'not-implemented');
  assert.equal(r.verdict, null);
});

test('unregistered policy -> unknown-policy, verdict null', () => {
  const r = evaluateOne('NotAPolicy', {});
  assert.equal(r.status, 'unknown-policy');
  assert.equal(r.verdict, null);
});

test('evaluate(): returns one EvaluationResult per requested policy', () => {
  const results = evaluate(['Identity', 'Verification', 'Ghost'], { dbIdentityStatus: 'VERIFIED' });
  assert.equal(results.length, 3);
  assert.equal(results[0].status, 'evaluated');
  assert.equal(results[1].status, 'not-implemented');
  assert.equal(results[2].status, 'unknown-policy');
});

test('Policy Registry: 9 canonical policies; only Identity implemented', () => {
  assert.equal(POLICY_REGISTRY.length, 9);
  const impl = POLICY_REGISTRY.filter((p) => p.implemented).map((p) => p.name);
  assert.deepEqual(impl, ['Identity']);
});

test('summarize() is descriptive: not-implemented / fail counts as non-pass (fail-closed reading)', () => {
  const passOnly = evaluate(['Identity'], { dbIdentityStatus: 'VERIFIED' });
  assert.equal(summarize(passOnly).all_block_level_passed, true);

  const withFail = evaluate(['Identity'], { dbIdentityStatus: 'UNKNOWN' });
  assert.equal(summarize(withFail).all_block_level_passed, false);

  const withNotImpl = evaluate(['Identity', 'Migration'], { dbIdentityStatus: 'VERIFIED' });
  const s = summarize(withNotImpl);
  assert.equal(s.not_implemented, 1);
  assert.equal(s.all_block_level_passed, false); // not-implemented is non-pass
});

test('isPass helper: only an evaluated pass verdict is a pass', () => {
  assert.equal(isPass(evaluated('Identity', pass('Identity', 'ok'))), true);
  assert.equal(isPass(evaluated('Identity', fail('Identity', 'no'))), false);
  assert.equal(isPass(notImplemented('Migration')), false);
  assert.equal(isPass(unknownPolicy('Ghost')), false);
});

test('engine purity: facts input is not mutated', () => {
  const facts = { dbIdentityStatus: 'VERIFIED', evidence_refs: ['e1'] };
  const snapshot = JSON.stringify(facts);
  evaluate(['Identity', 'Verification'], facts);
  assert.equal(JSON.stringify(facts), snapshot);
});
