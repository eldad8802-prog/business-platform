// Release State Projection — pure, read-only projection over the Event Log
//
// Computes the current lifecycle state of a Release by folding its events.
// This is a PROJECTION ONLY:
//   - reads events; never writes them,
//   - is NOT a Source of Truth (the Event Log is the Source of History),
//   - has NO persistence / snapshot / cache,
//   - knows NO Controller / Gates / Policies / Registry / business logic.
//
// Dependency-free and import-free: it operates only on plain event objects
// ({ event_id, release_id, type, timestamp, ... }).

// State-bearing events: the ONLY events that advance current_state.
export const STATE_BEARING = Object.freeze({
  ReleaseCreated: 'Created',
  ReleasePrepared: 'Prepared',
  ArtifactBuilt: 'Built',
  VerificationPassed: 'Verified',
  ApprovalGranted: 'Approved',
  PromotionStarted: 'Promoted',
  Released: 'Released',
  ReleaseClosed: 'Closed',
  Superseded: 'Superseded',
  RolledBack: 'Rolled-Back',
  ReleaseFailed: 'Failed',
  ReleaseAborted: 'Aborted',
  ApprovalRejected: 'Failed',
});

const INITIAL_STATE = 'Unknown';
const FAILURE_STATES = ['Failed', 'Aborted'];

// Legal forward transitions. From any active (non-terminal) state a Release may
// also move to Failed/Aborted. Terminal states have no outgoing transitions.
export const ALLOWED_TRANSITIONS = Object.freeze({
  Unknown: ['Created'],
  Created: ['Prepared', ...FAILURE_STATES],
  Prepared: ['Built', ...FAILURE_STATES],
  Built: ['Verified', ...FAILURE_STATES],
  Verified: ['Approved', ...FAILURE_STATES],
  Approved: ['Promoted', ...FAILURE_STATES],
  Promoted: ['Released', ...FAILURE_STATES],
  Released: ['Closed', 'Superseded', 'Rolled-Back'],
  // terminal — no outgoing transitions
  Closed: [],
  Superseded: [],
  'Rolled-Back': [],
  Failed: [],
  Aborted: [],
});

function isLegalTransition(from, to) {
  const allowed = ALLOWED_TRANSITIONS[from] || [];
  return allowed.includes(to);
}

function emptyProjection(release_id) {
  return {
    release_id,
    current_state: INITIAL_STATE,
    last_event_id: null,
    last_event_type: null,
    created_at: null,
    updated_at: null,
    event_count: 0,
    anomalies: [],
  };
}

// Fold an ordered list of events (already belonging to ONE release) into a
// projection. Events are assumed to be in log order.
export function projectRelease(events, release_id = null) {
  const proj = emptyProjection(release_id ?? (events[0] ? events[0].release_id ?? null : null));

  for (const e of events) {
    proj.event_count += 1;
    proj.last_event_id = e.event_id ?? null;
    proj.last_event_type = e.type ?? null;
    proj.updated_at = e.timestamp ?? proj.updated_at;

    const target = STATE_BEARING[e.type];
    if (target === undefined) {
      // Informational event: affects history/counters only, never current_state.
      continue;
    }
    if (isLegalTransition(proj.current_state, target)) {
      proj.current_state = target;
      if (e.type === 'ReleaseCreated') proj.created_at = e.timestamp ?? null;
    } else {
      // Invalid transition: record, do NOT advance, do NOT throw, do NOT block.
      proj.anomalies.push({
        event_id: e.event_id ?? null,
        type: e.type,
        reason: `illegal transition ${proj.current_state} -> ${target}`,
      });
    }
  }
  return proj;
}

// Project ALL releases from a full event log. Groups by release_id (preserving
// first-seen order); events with a null release_id are not release-scoped and
// are skipped. Returns an array of projections.
export function projectReleases(events) {
  const order = [];
  const groups = new Map();
  for (const e of events) {
    const rid = e.release_id ?? null;
    if (rid === null) continue; // not release-scoped
    if (!groups.has(rid)) {
      groups.set(rid, []);
      order.push(rid);
    }
    groups.get(rid).push(e);
  }
  return order.map((rid) => projectRelease(groups.get(rid), rid));
}
