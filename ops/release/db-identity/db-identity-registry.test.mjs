// DB Identity Registry Domain Kernel — tests (node:test, dependency-free)
//
// Run: node --test ops/release/db-identity/db-identity-registry.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRegistry,
  getRecord,
  applyTransition,
  identityPreconditionCleared,
  isFailClosed,
} from './db-identity-registry.mjs';

const PROV = (over = {}) => ({ source: 'build-host-probe', method: 'b2', actor: 'controller', decided_at: '2026-06-28T00:00:00.000Z', ...over });

function toInferred(reg, env = 'production') {
  return applyTransition(reg, env, {
    to_status: 'INFERRED',
    confidence: 'medium',
    evidence_refs: ['s6-metrics-1'],
    provenance: PROV({ source: 'activity-metrics', method: 's6' }),
    binding: { branch_ref: 'br-soft-sky', branch_label: 'production-NEW', endpoint_token: 'ep-frosty-pine' },
  });
}
function toVerified(reg, env = 'production') {
  return applyTransition(reg, env, {
    to_status: 'VERIFIED',
    evidence_refs: ['host:ep-frosty-pine'],
    provenance: PROV(),
    independent_verification: true,
    four_conditions_met: true,
    binding: { branch_ref: 'br-soft-sky', branch_label: 'production-NEW', endpoint_token: 'ep-frosty-pine' },
  });
}

test('createRegistry: every environment starts UNKNOWN with null binding', () => {
  const reg = createRegistry();
  for (const env of ['production', 'preview', 'development', 'staging']) {
    const r = getRecord(reg, env);
    assert.equal(r.status, 'UNKNOWN');
    assert.equal(r.binding.branch_ref, null);
    assert.equal(r.provenance, null);
  }
});

test('UNKNOWN -> INFERRED: applied, provenance emitted, version++', () => {
  const res = toInferred(createRegistry());
  assert.equal(res.ok, true);
  assert.equal(res.record.status, 'INFERRED');
  assert.equal(res.record.confidence, 'medium');
  assert.equal(res.provenance.prior_status, 'UNKNOWN');
  assert.equal(res.provenance.registry_version, 1);
});

test('INFERRED -> VERIFIED with direct evidence + 4 conditions: applied, last_verified_at set', () => {
  const inf = toInferred(createRegistry());
  const res = toVerified(inf.registry);
  assert.equal(res.ok, true);
  assert.equal(res.record.status, 'VERIFIED');
  assert.equal(res.record.last_verified_at, '2026-06-28T00:00:00.000Z');
  assert.equal(res.provenance.prior_status, 'INFERRED');
  assert.equal(res.provenance.registry_version, 2);
});

test('-> VERIFIED rejected without direct source / evidence / conditions (record unchanged)', () => {
  const reg = createRegistry();
  // indirect source
  let r = applyTransition(reg, 'production', { to_status: 'VERIFIED', evidence_refs: ['x'], independent_verification: true, four_conditions_met: true, provenance: PROV({ source: 'activity-metrics' }) });
  assert.equal(r.ok, false);
  // missing evidence
  r = applyTransition(reg, 'production', { to_status: 'VERIFIED', evidence_refs: [], independent_verification: true, four_conditions_met: true, provenance: PROV() });
  assert.equal(r.ok, false);
  // missing 4-conditions
  r = applyTransition(reg, 'production', { to_status: 'VERIFIED', evidence_refs: ['x'], independent_verification: true, four_conditions_met: false, provenance: PROV() });
  assert.equal(r.ok, false);
  assert.equal(getRecord(reg, 'production').status, 'UNKNOWN'); // unchanged
});

test('illegal status transition is rejected', () => {
  const reg = createRegistry();
  const r = applyTransition(reg, 'production', { to_status: 'SUSPECT', drift: { drift_signal: 'confirmed' }, provenance: PROV() });
  assert.equal(r.ok, false);
  assert.match(r.reason, /illegal transition UNKNOWN -> SUSPECT/);
});

test('VERIFIED -> SUSPECT on drift: applied, drift recorded, prior_status VERIFIED', () => {
  const ver = toVerified(toInferred(createRegistry()).registry);
  const res = applyTransition(ver.registry, 'production', {
    to_status: 'SUSPECT',
    drift: { drift_signal: 'confirmed', drift_reason: 'endpoint remap', last_checked_at: '2026-06-28T01:00:00.000Z' },
    provenance: PROV({ source: 'external-attestation', method: 'drift-check' }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.record.status, 'SUSPECT');
  assert.equal(res.record.drift.drift_signal, 'confirmed');
  assert.equal(res.provenance.prior_status, 'VERIFIED');
});

test('fail-closed: identityPreconditionCleared true only for VERIFIED', () => {
  let reg = createRegistry();
  assert.equal(identityPreconditionCleared(reg, 'production'), false); // UNKNOWN
  assert.equal(isFailClosed(reg, 'production'), true);
  reg = toInferred(reg).registry;
  assert.equal(identityPreconditionCleared(reg, 'production'), false); // INFERRED
  reg = toVerified(reg).registry;
  assert.equal(identityPreconditionCleared(reg, 'production'), true); // VERIFIED
  assert.equal(isFailClosed(reg, 'production'), false);
});

test('no-secret invariant: binding with a connection string is rejected', () => {
  const reg = createRegistry();
  const r = applyTransition(reg, 'production', {
    to_status: 'INFERRED',
    confidence: 'low',
    evidence_refs: ['x'],
    provenance: PROV({ source: 'activity-metrics' }),
    binding: { branch_ref: 'br-x', branch_label: 'l', endpoint_token: 'postgres://u:p@host/db' },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /secret|connection string/i);
});

test('preview must not be bound to the production identity', () => {
  // production VERIFIED with a known binding
  const prodVer = toVerified(toInferred(createRegistry()).registry);
  // attempt to bind preview to the same branch_ref
  const r = applyTransition(prodVer.registry, 'preview', {
    to_status: 'INFERRED',
    confidence: 'low',
    evidence_refs: ['x'],
    provenance: PROV({ source: 'activity-metrics' }),
    binding: { branch_ref: 'br-soft-sky', branch_label: 'production-NEW', endpoint_token: 'ep-frosty-pine' },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /preview must not be bound to the production/i);
});

test('immutability: applyTransition returns a new registry; input is unchanged', () => {
  const reg = createRegistry();
  const res = toInferred(reg);
  assert.notEqual(res.registry, reg);
  assert.equal(getRecord(reg, 'production').status, 'UNKNOWN'); // original untouched
  assert.equal(getRecord(res.registry, 'production').status, 'INFERRED');
});

test('provenance is required for every transition', () => {
  const reg = createRegistry();
  const r = applyTransition(reg, 'production', { to_status: 'INFERRED', confidence: 'low', evidence_refs: ['x'] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /provenance is required/i);
});

test('Current vs History: record holds only the last provenance (no history array)', () => {
  const inf = toInferred(createRegistry());
  const ver = toVerified(inf.registry);
  const rec = getRecord(ver.registry, 'production');
  // record carries a single (last) provenance reference, not a chain
  assert.equal(Array.isArray(rec.provenance), false);
  assert.equal(rec.provenance.registry_version, 2);
  assert.equal('history' in rec, false);
});
