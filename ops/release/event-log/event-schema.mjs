// Release Event Log — event schema + canonical event types + validation
//
// Pure, dependency-free. Defines the immutable event shape and the canonical
// event-type vocabulary derived from the ratified Release State Machine and
// Event Model. This is the schema layer ONLY — no projection, no state, no gates.

// Top-level fields allowed on a stored event, in canonical order.
// `integrity` carries the tamper-evident hash chain (added by the event-log core).
export const ALLOWED_TOP_LEVEL = [
  'event_id',
  'release_id',
  'type',
  'timestamp',
  'producer',
  'preceding_event_id',
  'payload',
  'integrity',
];

// Fields hashed for content integrity (everything except the integrity block).
export const HASHED_FIELDS = ALLOWED_TOP_LEVEL.filter((f) => f !== 'integrity');

// Canonical event-type vocabulary (from the ratified Release State Machine /
// Event Model). Adding a new type here is an additive change.
export const CANONICAL_EVENT_TYPES = Object.freeze([
  // Intent / source
  'ReleaseCreated',
  'ChangeAttached',
  // Preparation / build (Execution facts recorded as Decision inputs)
  'ReleasePrepared',
  'ArtifactBuilt',
  // Verification (policy verdicts)
  'VerificationStarted',
  'VerificationPassed',
  'VerificationFailed',
  // Approval (human intent)
  'ApprovalGranted',
  'ApprovalRejected',
  // Promotion boundary
  'PromotionRequested',
  'PromotionStarted',
  'RollbackPointCaptured',
  // Deployment (Execution facts)
  'DeploymentStarted',
  'DeploymentSucceeded',
  'DeploymentFailed',
  // Live as Role
  'Released',
  'LiveAssigned',
  'Superseded',
  // Rollback
  'RollbackStarted',
  'RollbackCompleted',
  'RolledBack',
  // Terminal
  'ReleaseClosed',
  'ReleaseFailed',
  'ReleaseAborted',
  // Cleanup
  'CleanupScheduled',
  'CleanupCompleted',
  // DB identity (registry provenance; e.g. from B-2)
  'ProductionDbVerified',
]);

const EVENT_TYPE_SET = new Set(CANONICAL_EVENT_TYPES);

export function isKnownEventType(type) {
  return typeof type === 'string' && EVENT_TYPE_SET.has(type);
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Validate a fully-assembled event (pre-write). Returns { valid, errors }.
// Rejects unknown types and malformed fields so nothing invalid is ever stored.
export function validateEvent(event) {
  const errors = [];
  if (!event || typeof event !== 'object') {
    return { valid: false, errors: ['event must be an object'] };
  }
  if (!isKnownEventType(event.type)) {
    errors.push(`unknown or missing event type: ${JSON.stringify(event.type)}`);
  }
  if (!UUID_RE.test(event.event_id || '')) {
    errors.push('event_id must be a UUID');
  }
  if (!ISO_RE.test(event.timestamp || '')) {
    errors.push('timestamp must be ISO-8601 (…Z)');
  }
  if (event.release_id !== null && typeof event.release_id !== 'string') {
    errors.push('release_id must be a string or null');
  }
  if (typeof event.producer !== 'string' || !event.producer.trim()) {
    errors.push('producer must be a non-empty string');
  }
  if (event.preceding_event_id !== null && !UUID_RE.test(event.preceding_event_id || '')) {
    errors.push('preceding_event_id must be a UUID or null');
  }
  if (event.payload == null || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    errors.push('payload must be an object');
  }
  return { valid: errors.length === 0, errors };
}
