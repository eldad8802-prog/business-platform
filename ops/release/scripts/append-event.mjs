#!/usr/bin/env node
// Phase 4 · Step 3 — Event Log Skeleton (report-only, append-only NDJSON)
//
// Appends ONE sanitized event to an append-only NDJSON log file. It:
//   - makes NO provider/network calls,
//   - enforces NO state and is NOT a gate,
//   - never writes to git (no commit/push); the workflow uploads the log as an
//     artifact only,
//   - sanitizes the payload so credentials/tokens/connection strings can never
//     be persisted.
//
// Inputs (from the workflow_dispatch inputs, via env):
//   EVENT_TYPE           required — e.g. ReleaseCreated, ArtifactBuilt, ...
//   EVENT_RELEASE_ID     optional — the Release this event belongs to
//   EVENT_PRODUCER       optional — who emitted it (defaults to "manual")
//   EVENT_PAYLOAD        optional — JSON string; deeply sanitized before storage
//   EVENT_LOG_PATH       optional — output path (default below)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_LOG = 'ops/release/_events/release-events.ndjson';

// Exactly the fields allowed at the top level of an event.
const ALLOWED_TOP_LEVEL = [
  'event_id',
  'release_id',
  'type',
  'timestamp',
  'producer',
  'preceding_event_id',
  'payload',
];

// Key substrings that must never appear in a stored payload (redacted).
const FORBIDDEN_KEY = /(secret|token|password|passwd|api[_-]?key|authorization|auth[_-]?token|credential|database_url|direct_url|conn(ection)?[_-]?string|bearer|private[_-]?key)/i;

// Value shapes that look like credentials/connection strings (redacted wholesale).
const FORBIDDEN_VALUE = /(postgres(ql)?:\/\/|mysql:\/\/|mongodb(\+srv)?:\/\/|redis:\/\/|:\/\/[^\s/]*:[^\s/]*@|Bearer\s+\S+|sk-[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]{10,})/;

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 6;
const MAX_STRING = 2048;

function sanitize(value, depth = 0) {
  if (depth > MAX_DEPTH) return REDACTED;
  if (value === null) return null;
  const t = typeof value;
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'string') {
    if (FORBIDDEN_VALUE.test(value)) return REDACTED;
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…[truncated]' : value;
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  if (t === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = FORBIDDEN_KEY.test(k) ? REDACTED : sanitize(v, depth + 1);
    }
    return out;
  }
  // functions/symbols/bigints/undefined are not serialized
  return undefined;
}

function parsePayload(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return sanitize(parsed);
    return { value: sanitize(parsed) };
  } catch {
    // Treat non-JSON as an opaque (sanitized) note rather than failing.
    return { note: sanitize(String(raw)) };
  }
}

async function lastEventId(logPath) {
  try {
    const text = await readFile(logPath, 'utf8');
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length === 0) return null;
    const last = JSON.parse(lines[lines.length - 1]);
    return last.event_id ?? null;
  } catch {
    return null; // no prior log → first event in the chain
  }
}

async function main() {
  const type = (process.env.EVENT_TYPE || '').trim();
  if (!type) {
    console.error('[event-log] EVENT_TYPE is required. Stopping (nothing written).');
    process.exit(2);
  }

  const logPath = (process.env.EVENT_LOG_PATH || DEFAULT_LOG).trim();
  const preceding = await lastEventId(logPath);

  const event = {
    event_id: randomUUID(),
    release_id: (process.env.EVENT_RELEASE_ID || '').trim() || null,
    type,
    timestamp: new Date().toISOString(),
    producer: (process.env.EVENT_PRODUCER || 'manual').trim(),
    preceding_event_id: preceding,
    payload: parsePayload(process.env.EVENT_PAYLOAD),
  };

  // Defensive: emit ONLY allow-listed top-level fields, in order.
  const ordered = {};
  for (const k of ALLOWED_TOP_LEVEL) ordered[k] = event[k];

  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, JSON.stringify(ordered) + '\n', { flag: 'a' });

  console.log(`[event-log] Appended ${type} (${ordered.event_id}) -> ${logPath}. Payload sanitized; no secrets stored.`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = [
      '## Release Event appended (report-only)',
      '',
      `- type: \`${type}\``,
      `- event_id: \`${ordered.event_id}\``,
      `- release_id: \`${ordered.release_id ?? ''}\``,
      `- preceding_event_id: \`${ordered.preceding_event_id ?? '(none — first)'}\``,
      '',
      '_Append-only NDJSON, uploaded as an artifact. No state enforced; payload sanitized._',
    ];
    await writeFile(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n', { flag: 'a' });
  }
}

main();
