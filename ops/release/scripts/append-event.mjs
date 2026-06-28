#!/usr/bin/env node
// Phase 4 · Step 3 — Event Log CLI (report-only, append-only NDJSON)
//
// Thin CLI wrapper over the single-source-of-truth event-log core
// (ops/release/event-log/). It:
//   - makes NO provider/network calls,
//   - enforces NO state and is NOT a gate,
//   - never writes to git (no commit/push); the workflow uploads the log as an
//     artifact only,
//   - sanitizes the payload so credentials can never be persisted,
//   - hash-chains each event for tamper-evidence.
//
// Inputs (from the workflow_dispatch inputs, via env) — unchanged external contract:
//   EVENT_TYPE           required — e.g. ReleaseCreated, ArtifactBuilt, ...
//   EVENT_RELEASE_ID     optional — the Release this event belongs to
//   EVENT_PRODUCER       optional — who emitted it (defaults to "manual")
//   EVENT_PAYLOAD        optional — JSON string; deeply sanitized before storage
//   EVENT_LOG_PATH       optional — output path (default below)

import { writeFile } from 'node:fs/promises';
import { appendEvent, DEFAULT_LOG } from '../event-log/event-log.mjs';
import { parsePayload } from '../event-log/sanitize.mjs';

async function main() {
  const type = (process.env.EVENT_TYPE || '').trim();
  if (!type) {
    console.error('[event-log] EVENT_TYPE is required. Stopping (nothing written).');
    process.exit(2);
  }

  const logPath = (process.env.EVENT_LOG_PATH || DEFAULT_LOG).trim();

  let ordered;
  try {
    ordered = await appendEvent(
      {
        type,
        release_id: (process.env.EVENT_RELEASE_ID || '').trim() || null,
        producer: (process.env.EVENT_PRODUCER || 'manual').trim(),
        payload: parsePayload(process.env.EVENT_PAYLOAD),
      },
      { logPath },
    );
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

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
