#!/usr/bin/env node
// Phase 4.3 · Step B — Production host-only probe (GUARDED, read-only)
//
// Prints ONLY the hostname of DATABASE_URL — nothing else. A hostname
// (ep-*.neon.tech) is NOT a credential. This script is the second half of
// host correlation: match this host against ops/release/infra-endpoints.json
// to identify which Neon branch the environment's DATABASE_URL points to.
//
// HARD SAFETY GUARANTEES:
//   - It NEVER prints the URL, username, password, database name, port, search
//     params, or any other component — only `url.hostname`.
//   - It does NOT connect to the database, run SQL, or run migrations.
//   - It does NOT write the value anywhere.
//   - It refuses to run unless explicitly unlocked with HOST_PROBE_CONFIRM=yes,
//     so it cannot execute by accident.
//
// Usage (only in an environment that legitimately holds DATABASE_URL, after the
// environment has been explicitly confirmed safe):
//   HOST_PROBE_CONFIRM=yes node ops/release/scripts/host-probe.mjs

function fail(msg) {
  console.error(`[host-probe] ${msg}`);
  process.exit(2);
}

if (process.env.HOST_PROBE_CONFIRM !== 'yes') {
  fail('Refusing to run: set HOST_PROBE_CONFIRM=yes to confirm a safe environment. Nothing printed.');
}

const raw = process.env.DATABASE_URL;
if (!raw || !raw.trim()) {
  fail('DATABASE_URL is not set in this environment. Nothing to probe.');
}

let host;
try {
  // Parse and immediately discard everything except hostname. The full value is
  // never assigned to a logged variable.
  host = new URL(raw).hostname;
} catch {
  fail('DATABASE_URL is not a parseable URL. Nothing printed.');
}

// Defensive: a Neon host looks like ep-*.<region>.aws.neon.tech. We print only
// the hostname, regardless. No other URL part is ever referenced again.
if (!host) fail('No hostname component found. Nothing printed.');

// The ONLY line of output: the bare hostname.
console.log(host);
