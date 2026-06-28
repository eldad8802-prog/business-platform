// Release Event Log — append-only, tamper-evident core (Source of History)
//
// Dependency-free (node: builtins only). This layer is the foundation that later
// layers (State Projection, Registry, Controller) will read from. It does NOT
// project state, run gates, or touch Production — it only appends, reads, and
// verifies an immutable hash-chained NDJSON log.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { sanitize } from './sanitize.mjs';
import { ALLOWED_TOP_LEVEL, HASHED_FIELDS, validateEvent } from './event-schema.mjs';

export const DEFAULT_LOG = 'ops/release/_events/release-events.ndjson';

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// Deterministic serialization of the hashed fields (stable key order = HASHED_FIELDS).
function canonicalContent(event) {
  const ordered = {};
  for (const k of HASHED_FIELDS) ordered[k] = event[k] ?? null;
  return JSON.stringify(ordered);
}

export function contentHash(event) {
  return sha256(canonicalContent(event));
}

export function chainHash(content_hash, precedingChainHash) {
  return sha256(content_hash + (precedingChainHash || ''));
}

// Read the log into an array of events. Missing file → [].
export async function readEvents(logPath = DEFAULT_LOG) {
  let text;
  try {
    text = await readFile(logPath, 'utf8');
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// Append ONE event. Validates + sanitizes + hash-chains, then appends a single
// NDJSON line. Never rewrites or deletes existing lines. Throws on invalid input
// WITHOUT writing. `opts.idFn`/`opts.nowFn` are injectable for deterministic tests.
export async function appendEvent(input, opts = {}) {
  const logPath = opts.logPath || DEFAULT_LOG;
  const idFn = opts.idFn || randomUUID;
  const nowFn = opts.nowFn || (() => new Date().toISOString());

  const events = await readEvents(logPath);
  const prev = events.length ? events[events.length - 1] : null;

  const event = {
    event_id: idFn(),
    release_id: input.release_id ?? null,
    type: input.type,
    timestamp: nowFn(),
    producer: (input.producer && String(input.producer).trim()) || 'manual',
    preceding_event_id: prev ? prev.event_id : null,
    payload: sanitize(input.payload ?? {}),
  };

  const { valid, errors } = validateEvent(event);
  if (!valid) {
    throw new Error(`[event-log] invalid event — not written: ${errors.join('; ')}`);
  }

  const content_hash = contentHash(event);
  const chain_hash = chainHash(content_hash, prev?.integrity?.chain_hash);
  event.integrity = { content_hash, chain_hash };

  // Emit ONLY allow-listed top-level fields, in canonical order.
  const ordered = {};
  for (const k of ALLOWED_TOP_LEVEL) ordered[k] = event[k];

  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, JSON.stringify(ordered) + '\n', { flag: 'a' });
  return ordered;
}

// Verify the full chain: recompute content hashes from stored fields, confirm
// chain hashes and preceding_event_id links. Returns { valid, errorIndex?, reason? }.
export function verifyChain(events) {
  let prev = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e.integrity || typeof e.integrity.content_hash !== 'string') {
      return { valid: false, errorIndex: i, reason: 'missing integrity block' };
    }
    const recomputed = contentHash(e);
    if (recomputed !== e.integrity.content_hash) {
      return { valid: false, errorIndex: i, reason: 'content hash mismatch (tampered)' };
    }
    const expectedLink = prev ? prev.event_id : null;
    if ((e.preceding_event_id ?? null) !== expectedLink) {
      return { valid: false, errorIndex: i, reason: 'broken preceding_event_id link' };
    }
    const expectedChain = chainHash(e.integrity.content_hash, prev?.integrity?.chain_hash);
    if (expectedChain !== e.integrity.chain_hash) {
      return { valid: false, errorIndex: i, reason: 'chain hash mismatch (tampered)' };
    }
    prev = e;
  }
  return { valid: true };
}
