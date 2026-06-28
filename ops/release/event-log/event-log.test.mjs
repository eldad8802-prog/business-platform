// Release Event Log — foundation tests (node:test, dependency-free)
//
// Run: node --test ops/release/event-log/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, readEvents, verifyChain } from './event-log.mjs';
import { validateEvent, isKnownEventType } from './event-schema.mjs';

async function tempLog() {
  const dir = await mkdtemp(join(tmpdir(), 'evlog-'));
  return { logPath: join(dir, 'events.ndjson'), dir };
}

test('append produces a valid schema + integrity hashes', async () => {
  const { logPath, dir } = await tempLog();
  try {
    const ev = await appendEvent({ type: 'ReleaseCreated', release_id: 'rel-1', producer: 'test', payload: { a: 1 } }, { logPath });
    assert.equal(ev.type, 'ReleaseCreated');
    assert.ok(ev.event_id);
    assert.equal(ev.preceding_event_id, null);
    assert.ok(ev.integrity.content_hash && ev.integrity.chain_hash);
    assert.deepEqual(validateEvent(ev), { valid: true, errors: [] });
    const events = await readEvents(logPath);
    assert.equal(events.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('payload is sanitized (key + connection-string value redacted)', async () => {
  const { logPath, dir } = await tempLog();
  try {
    const ev = await appendEvent(
      { type: 'ProductionDbVerified', producer: 'test', payload: { password: 'hunter2', dsn: 'postgres://u:p@host/db', host: 'ep-x.neon.tech' } },
      { logPath },
    );
    assert.equal(ev.payload.password, '[REDACTED]'); // forbidden key
    assert.equal(ev.payload.dsn, '[REDACTED]'); // connection-string value
    assert.equal(ev.payload.host, 'ep-x.neon.tech'); // host is not a secret
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('append-only: existing first line is byte-for-byte unchanged after a second append', async () => {
  const { logPath, dir } = await tempLog();
  try {
    await appendEvent({ type: 'ReleaseCreated', producer: 'test', payload: {} }, { logPath });
    const firstLineBefore = (await readFile(logPath, 'utf8')).split('\n')[0];
    await appendEvent({ type: 'ArtifactBuilt', producer: 'test', payload: {} }, { logPath });
    const firstLineAfter = (await readFile(logPath, 'utf8')).split('\n')[0];
    assert.equal(firstLineAfter, firstLineBefore);
    const events = await readEvents(logPath);
    assert.equal(events.length, 2);
    assert.equal(events[1].preceding_event_id, events[0].event_id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verifyChain passes on an untampered log', async () => {
  const { logPath, dir } = await tempLog();
  try {
    for (const t of ['ReleaseCreated', 'ArtifactBuilt', 'VerificationPassed']) {
      await appendEvent({ type: t, producer: 'test', payload: {} }, { logPath });
    }
    const res = verifyChain(await readEvents(logPath));
    assert.deepEqual(res, { valid: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verifyChain detects tampering (mutated payload)', async () => {
  const { logPath, dir } = await tempLog();
  try {
    await appendEvent({ type: 'ReleaseCreated', producer: 'test', payload: { v: 'original' } }, { logPath });
    await appendEvent({ type: 'ArtifactBuilt', producer: 'test', payload: {} }, { logPath });
    const events = await readEvents(logPath);
    events[0].payload = { v: 'tampered' }; // mutate stored content, keep old hash
    const res = verifyChain(events);
    assert.equal(res.valid, false);
    assert.equal(res.errorIndex, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('invalid (unknown) event type is rejected and nothing is written', async () => {
  const { logPath, dir } = await tempLog();
  try {
    assert.equal(isKnownEventType('NotARealType'), false);
    await assert.rejects(
      () => appendEvent({ type: 'NotARealType', producer: 'test', payload: {} }, { logPath }),
      /invalid event/,
    );
    const events = await readEvents(logPath);
    assert.equal(events.length, 0); // no write occurred
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
