// Release Identity read-model — tests (node:test, dependency-free)
//
// Run: node --test ops/release/event-log/release-identity.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectIdentity, projectIdentities } from './release-identity.mjs';

let seq = 0;
function ev(type, release_id = 'rel-1', payload = {}, ts) {
  seq += 1;
  return {
    event_id: `ev-${String(seq).padStart(4, '0')}`,
    release_id,
    type,
    timestamp: ts || `2026-06-28T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    payload,
  };
}

test('ReleaseCreated populates immutable-from-birth fields; bindings are null', () => {
  const created = ev('ReleaseCreated', 'rel-1', {
    target: 'prod',
    environment: 'production',
    intent_ref: 'cs-123',
    created_by: 'owner@dubiz',
  });
  const id = projectIdentity([created], 'rel-1');
  assert.equal(id.release_id, 'rel-1');
  assert.equal(id.target, 'prod');
  assert.equal(id.environment, 'production');
  assert.equal(id.intent_ref, 'cs-123');
  assert.equal(id.created_by, 'owner@dubiz');
  assert.equal(id.created_at, created.timestamp);
  assert.equal(id.artifact_ref, null);
  assert.equal(id.schema_version, null);
  assert.equal(id.rollback_point_ref, null);
  assert.deepEqual(id.anomalies, []);
});

test('ArtifactBuilt sets artifact_ref + schema_version (write-once)', () => {
  const id = projectIdentity(
    [ev('ReleaseCreated'), ev('ArtifactBuilt', 'rel-1', { artifact_ref: 'art-9', schema_version: 'sv-7' })],
    'rel-1',
  );
  assert.equal(id.artifact_ref, 'art-9');
  assert.equal(id.schema_version, 'sv-7');
  assert.deepEqual(id.anomalies, []);
});

test('RollbackPointCaptured sets rollback_point_ref', () => {
  const id = projectIdentity(
    [ev('ReleaseCreated'), ev('RollbackPointCaptured', 'rel-1', { rollback_point_ref: 'rp-3' })],
    'rel-1',
  );
  assert.equal(id.rollback_point_ref, 'rp-3');
  assert.deepEqual(id.anomalies, []);
});

test('write-once violation: second ArtifactBuilt is anomaly; original kept', () => {
  const id = projectIdentity(
    [
      ev('ReleaseCreated'),
      ev('ArtifactBuilt', 'rel-1', { artifact_ref: 'art-1', schema_version: 'sv-1' }),
      ev('ArtifactBuilt', 'rel-1', { artifact_ref: 'art-2', schema_version: 'sv-2' }),
    ],
    'rel-1',
  );
  assert.equal(id.artifact_ref, 'art-1'); // original preserved
  assert.equal(id.schema_version, 'sv-1');
  assert.equal(id.anomalies.length, 2); // artifact_ref + schema_version
  assert.ok(id.anomalies.every((a) => /write-once violation/.test(a.reason)));
});

test('immutable-from-birth: second ReleaseCreated is anomaly; from-birth unchanged', () => {
  const id = projectIdentity(
    [
      ev('ReleaseCreated', 'rel-1', { target: 'prod', environment: 'production', intent_ref: 'cs-1', created_by: 'a' }),
      ev('ReleaseCreated', 'rel-1', { target: 'OTHER', environment: 'preview', intent_ref: 'cs-2', created_by: 'b' }),
    ],
    'rel-1',
  );
  assert.equal(id.target, 'prod'); // unchanged
  assert.equal(id.environment, 'production');
  assert.equal(id.intent_ref, 'cs-1');
  assert.equal(id.created_by, 'a');
  assert.equal(id.anomalies.length, 1);
  assert.match(id.anomalies[0].reason, /immutable-from-birth violation/);
});

test('identity is independent of lifecycle state (state events do not affect it)', () => {
  const id = projectIdentity(
    [
      ev('ReleaseCreated', 'rel-1', { target: 'prod', environment: 'production', intent_ref: 'cs-1', created_by: 'a' }),
      ev('ReleasePrepared'),
      ev('VerificationPassed'),
      ev('Released'),
      ev('ReleaseClosed'),
    ],
    'rel-1',
  );
  assert.equal(id.target, 'prod'); // from-birth intact
  assert.equal(id.artifact_ref, null); // no ArtifactBuilt → still null
  assert.equal('current_state' in id, false); // identity carries NO state
  assert.deepEqual(id.anomalies, []);
});

test('multiple releases are grouped by release_id', () => {
  const all = projectIdentities([
    ev('ReleaseCreated', 'rel-A', { target: 'a' }),
    ev('ReleaseCreated', 'rel-B', { target: 'b' }),
    ev('ArtifactBuilt', 'rel-A', { artifact_ref: 'artA', schema_version: 'svA' }),
  ]);
  assert.equal(all.length, 2);
  const a = all.find((x) => x.release_id === 'rel-A');
  const b = all.find((x) => x.release_id === 'rel-B');
  assert.equal(a.artifact_ref, 'artA');
  assert.equal(b.artifact_ref, null);
  assert.equal(b.target, 'b');
});

test('binding before ReleaseCreated: from-birth stay null; binding still applies write-once', () => {
  const id = projectIdentity(
    [ev('ArtifactBuilt', 'rel-1', { artifact_ref: 'art-early', schema_version: 'sv-early' }), ev('ReleaseCreated', 'rel-1', { target: 'prod' })],
    'rel-1',
  );
  assert.equal(id.artifact_ref, 'art-early'); // binding applied
  assert.equal(id.target, 'prod'); // creation still populates from-birth
  assert.equal(id.created_at !== null, true);
  assert.deepEqual(id.anomalies, []);
});

test('empty log yields an empty identity set', () => {
  assert.deepEqual(projectIdentities([]), []);
  const id = projectIdentity([], 'rel-x');
  assert.equal(id.release_id, 'rel-x');
  assert.equal(id.target, null);
  assert.equal(id.created_at, null);
  assert.deepEqual(id.anomalies, []);
});

test('deterministic: same events produce identical identity', () => {
  const events = [
    ev('ReleaseCreated', 'rel-1', { target: 'prod', environment: 'production', intent_ref: 'cs-1', created_by: 'a' }),
    ev('ArtifactBuilt', 'rel-1', { artifact_ref: 'art-1', schema_version: 'sv-1' }),
  ];
  assert.deepEqual(projectIdentity(events, 'rel-1'), projectIdentity(events, 'rel-1'));
});
