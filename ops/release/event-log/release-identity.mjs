// Release Identity — read-model (projection mechanism) over the Event Log
//
// Materializes the stable Release Identity DOMAIN OBJECT from its events.
// Terminology (per Release State Machine Design v1):
//   - Release Identity = the stable Domain Object (release_id + immutable-from-birth
//     fields + write-once bindings). It is NOT a projection.
//   - This module is the Identity READ-MODEL: the projection mechanism that
//     computes/materializes that Domain Object from the Event Log.
//
// It is pure and import-free:
//   - reads events; never writes them,
//   - is NOT a Source of Truth (the Event Log is the Source of History),
//   - has NO persistence / snapshot / cache,
//   - knows NO Controller / Gates / Policies / Registry / Runtime / business logic.
//
// Enforcement is REPORTING-ONLY: write-once and immutable-from-birth violations
// are recorded in `anomalies` — never thrown, never blocked. (Append-time
// enforcement is the future Controller's responsibility, not this layer's.)

// Immutable-from-birth fields, sourced from the ReleaseCreated event payload.
const FROM_BIRTH_EVENT = 'ReleaseCreated';
const FROM_BIRTH_FIELDS = ['target', 'environment', 'intent_ref', 'created_by'];

// Write-once bindings: which event sets which identity fields (from its payload).
export const BINDING_SOURCES = Object.freeze({
  ArtifactBuilt: ['artifact_ref', 'schema_version'],
  RollbackPointCaptured: ['rollback_point_ref'],
});

function emptyIdentity(release_id) {
  return {
    release_id,
    // immutable-from-birth
    target: null,
    environment: null,
    intent_ref: null,
    created_by: null,
    created_at: null,
    // write-once bindings
    artifact_ref: null,
    schema_version: null,
    rollback_point_ref: null,
    anomalies: [],
  };
}

function anomaly(identity, event_id, type, reason) {
  identity.anomalies.push({ event_id: event_id ?? null, type, reason });
}

// Materialize the Release Identity Domain Object for ONE release by folding its
// events (assumed in log order). Pure: returns a new object, mutates nothing external.
export function projectIdentity(events, release_id = null) {
  const rid = release_id ?? (events[0] ? events[0].release_id ?? null : null);
  const identity = emptyIdentity(rid);
  let created = false;

  for (const e of events) {
    const payload = e.payload && typeof e.payload === 'object' ? e.payload : {};

    if (e.type === FROM_BIRTH_EVENT) {
      if (created) {
        // immutable-from-birth: a second creation never rewrites identity.
        anomaly(identity, e.event_id, e.type, 'immutable-from-birth violation: duplicate ReleaseCreated');
        continue;
      }
      created = true;
      identity.created_at = e.timestamp ?? null;
      for (const f of FROM_BIRTH_FIELDS) identity[f] = payload[f] ?? null;
      continue;
    }

    const bindFields = BINDING_SOURCES[e.type];
    if (bindFields) {
      for (const f of bindFields) {
        if (identity[f] === null) {
          identity[f] = payload[f] ?? null;
        } else {
          // write-once: already set → record, keep original, do not overwrite.
          anomaly(identity, e.event_id, e.type, `write-once violation: ${f} already set`);
        }
      }
      continue;
    }
    // Any other event type is irrelevant to identity — ignored entirely.
  }
  return identity;
}

// Materialize identities for ALL releases in a full event log. Groups by
// release_id (first-seen order); events with a null release_id are not
// release-scoped and are skipped. Returns an array of Release Identity objects.
export function projectIdentities(events) {
  const order = [];
  const groups = new Map();
  for (const e of events) {
    const rid = e.release_id ?? null;
    if (rid === null) continue;
    if (!groups.has(rid)) {
      groups.set(rid, []);
      order.push(rid);
    }
    groups.get(rid).push(e);
  }
  return order.map((rid) => projectIdentity(groups.get(rid), rid));
}
