// Release State Projection — tests (node:test, dependency-free)
//
// Run: node --test ops/release/event-log/state-projection.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectRelease, projectReleases } from './state-projection.mjs';

// Build a minimal plain event. Projection only reads type/release_id/event_id/timestamp.
let seq = 0;
function ev(type, release_id = 'rel-1', ts) {
  seq += 1;
  return {
    event_id: `ev-${String(seq).padStart(4, '0')}`,
    release_id,
    type,
    timestamp: ts || `2026-06-28T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
  };
}

test('full forward path projects Created -> Closed', () => {
  const events = [
    ev('ReleaseCreated'),
    ev('ReleasePrepared'),
    ev('ArtifactBuilt'),
    ev('VerificationPassed'),
    ev('ApprovalGranted'),
    ev('PromotionStarted'),
    ev('Released'),
    ev('ReleaseClosed'),
  ];
  const p = projectRelease(events, 'rel-1');
  assert.equal(p.current_state, 'Closed');
  assert.equal(p.event_count, 8);
  assert.equal(p.last_event_type, 'ReleaseClosed');
  assert.equal(p.last_event_id, events[events.length - 1].event_id);
  assert.equal(p.created_at, events[0].timestamp);
  assert.equal(p.updated_at, events[events.length - 1].timestamp);
  assert.deepEqual(p.anomalies, []);
});

test('multiple releases in one log are grouped by release_id', () => {
  const events = [
    ev('ReleaseCreated', 'rel-A'),
    ev('ReleaseCreated', 'rel-B'),
    ev('ReleasePrepared', 'rel-A'),
    ev('ReleasePrepared', 'rel-B'),
    ev('ArtifactBuilt', 'rel-B'), // legal path: Created -> Prepared -> Built
  ];
  const all = projectReleases(events);
  assert.equal(all.length, 2);
  const a = all.find((x) => x.release_id === 'rel-A');
  const b = all.find((x) => x.release_id === 'rel-B');
  assert.equal(a.current_state, 'Prepared');
  assert.equal(b.current_state, 'Built');
});

test('terminal states: Rolled-Back and Failed', () => {
  const rolled = projectRelease(
    [ev('ReleaseCreated'), ev('ReleasePrepared'), ev('ArtifactBuilt'), ev('VerificationPassed'), ev('ApprovalGranted'), ev('PromotionStarted'), ev('Released'), ev('RolledBack')],
    'rel-1',
  );
  assert.equal(rolled.current_state, 'Rolled-Back');

  const failed = projectRelease([ev('ReleaseCreated', 'rel-2'), ev('ReleasePrepared', 'rel-2'), ev('ReleaseFailed', 'rel-2')], 'rel-2');
  assert.equal(failed.current_state, 'Failed');

  const rejected = projectRelease(
    [ev('ReleaseCreated', 'rel-3'), ev('ReleasePrepared', 'rel-3'), ev('ArtifactBuilt', 'rel-3'), ev('VerificationPassed', 'rel-3'), ev('ApprovalRejected', 'rel-3')],
    'rel-3',
  );
  assert.equal(rejected.current_state, 'Failed');
});

test('invalid transition is recorded in anomalies and does NOT advance state (no throw)', () => {
  const events = [ev('ReleaseCreated'), ev('Released')]; // Created -> Released is illegal
  const p = projectRelease(events, 'rel-1');
  assert.equal(p.current_state, 'Created'); // not advanced
  assert.equal(p.anomalies.length, 1);
  assert.equal(p.anomalies[0].type, 'Released');
  assert.match(p.anomalies[0].reason, /illegal transition Created -> Released/);
  assert.equal(p.event_count, 2); // still counted in history
});

test('empty log yields an empty projection', () => {
  assert.deepEqual(projectReleases([]), []);
  const p = projectRelease([], 'rel-x');
  assert.equal(p.current_state, 'Unknown');
  assert.equal(p.event_count, 0);
  assert.equal(p.last_event_id, null);
});

test('counters and timestamps are accurate', () => {
  const e1 = ev('ReleaseCreated');
  const e2 = ev('ReleasePrepared');
  const p = projectRelease([e1, e2], 'rel-1');
  assert.equal(p.event_count, 2);
  assert.equal(p.created_at, e1.timestamp);
  assert.equal(p.updated_at, e2.timestamp);
  assert.equal(p.last_event_id, e2.event_id);
  assert.equal(p.last_event_type, 'ReleasePrepared');
});

test('informational events are counted but do NOT change current_state', () => {
  const events = [
    ev('ReleaseCreated'),
    ev('ChangeAttached'),
    ev('VerificationStarted'),
    ev('DeploymentSucceeded'),
    ev('ProductionDbVerified'),
    ev('LiveAssigned'),
  ];
  const p = projectRelease(events, 'rel-1');
  assert.equal(p.current_state, 'Created'); // unchanged by informational events
  assert.equal(p.event_count, 6);
  assert.equal(p.last_event_type, 'LiveAssigned');
  assert.deepEqual(p.anomalies, []);
});
