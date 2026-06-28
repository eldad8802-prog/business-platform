#!/usr/bin/env node
// Phase 4.3 · Step A — Neon Endpoints Registry (read-only, host correlation)
//
// READ-ONLY. Calls exactly ONE Neon endpoint with GET:
//   GET https://console.neon.tech/api/v2/projects/{project_id}/endpoints
//
// It emits an allow-listed projection: endpoint id, host, linked branch
// id/name, type, region, state. It NEVER reads, requests, or writes
// connection strings, credentials, usernames, passwords, or database names.
// A Neon endpoint host (ep-*.neon.tech) is NOT a credential — it is the
// piece needed to correlate the Vercel Production host to a branch.
//
// The bearer token is only ever sent in the Authorization header; it is never
// logged or written to output.
//
// Required environment (provided by the workflow, not hard-coded):
//   NEON_API_KEY    — GitHub secret  (bearer token)
//   NEON_PROJECT_ID — GitHub variable (project id)
//   NEON_BRANCHES_JSON — optional path to infra-registry.json (to resolve branch names)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const NEON_API_BASE = 'https://console.neon.tech/api/v2';
const OUTPUT_PATH = 'ops/release/infra-endpoints.json';

// Only these fields are ever copied from an endpoint object. Anything else
// returned by the API (including any connection_uri/host_tls/proxy secrets) is
// discarded by omission.
const ENDPOINT_ALLOW_LIST = [
  'id',
  'host',
  'branch_id',
  'type',
  'region_id',
  'current_state',
  'created_at',
  // S6 discriminating recency metrics (non-sensitive: timestamps/flags/state).
  'last_active',
  'updated_at',
  'pooler_enabled',
  'pending_state',
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`[infra-endpoints] Missing required env: ${name}. Stopping (no API call made).`);
    process.exit(2);
  }
  return value.trim();
}

function projectEndpoint(ep) {
  const out = {};
  for (const key of ENDPOINT_ALLOW_LIST) {
    if (Object.prototype.hasOwnProperty.call(ep, key)) out[key] = ep[key];
  }
  return out;
}

async function loadBranchNames() {
  const path = process.env.NEON_BRANCHES_JSON;
  if (!path) return new Map();
  try {
    const reg = JSON.parse(await readFile(path, 'utf8'));
    const map = new Map();
    for (const b of reg.branches || []) map.set(b.id, b.name);
    return map;
  } catch {
    return new Map();
  }
}

async function main() {
  const apiKey = requireEnv('NEON_API_KEY');
  const projectId = requireEnv('NEON_PROJECT_ID');
  const branchNames = await loadBranchNames();

  const url = `${NEON_API_BASE}/projects/${encodeURIComponent(projectId)}/endpoints`;

  let res;
  try {
    res = await fetch(url, {
      method: 'GET', // read-only — the ONLY method this script ever uses
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    console.error(`[infra-endpoints] Network error calling Neon API: ${err.message}. Stopping.`);
    process.exit(1);
  }

  if (!res.ok) {
    console.error(`[infra-endpoints] Neon API returned HTTP ${res.status}. Stopping (no output written).`);
    process.exit(1);
  }

  const body = await res.json();
  const endpoints = Array.isArray(body.endpoints) ? body.endpoints : [];
  const projected = endpoints.map((ep) => {
    const p = projectEndpoint(ep);
    p.branch_name = branchNames.get(p.branch_id) || null;
    return p;
  });

  const registry = {
    schema: 'dubiz.release.infra-endpoints/v1',
    generated_by: 'release-infra-registry workflow (Phase 4.3 · Step A)',
    source: {
      provider: 'neon',
      api: `${NEON_API_BASE}/projects/{project_id}/endpoints`,
      method: 'GET',
      project_id: projectId,
    },
    note: 'Endpoint host <-> branch map for host correlation. Contains NO connection strings, credentials, usernames, passwords, or database names. A host (ep-*.neon.tech) is not a credential.',
    endpoint_count: projected.length,
    host_to_branch: projected.map((p) => ({ host: p.host, branch_id: p.branch_id, branch_name: p.branch_name, type: p.type, last_active: p.last_active ?? null })),
    endpoints: projected,
  };

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  console.log(`[infra-endpoints] Wrote ${OUTPUT_PATH} with ${projected.length} endpoint(s). No credentials included.`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      '## Neon Endpoints (read-only, host correlation)',
      '',
      `- Endpoints found: **${projected.length}**`,
      '',
      '| host | branch | type | state | last_active |',
      '| --- | --- | --- | --- | --- |',
      ...projected.map((p) => `| ${p.host ?? ''} | ${p.branch_name ?? p.branch_id ?? ''} | ${p.type ?? ''} | ${p.current_state ?? ''} | ${p.last_active ?? ''} |`),
      '',
      '_Hosts are not credentials. No connection strings collected._',
    ];
    await writeFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n', { flag: 'a' });
  }
}

main();
