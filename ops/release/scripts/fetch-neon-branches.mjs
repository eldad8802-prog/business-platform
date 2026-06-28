#!/usr/bin/env node
// Phase 4 · Step 1 — Infrastructure Registry (Neon DB Identity)
//
// READ-ONLY. Calls exactly ONE Neon endpoint with GET:
//   GET https://console.neon.tech/api/v2/projects/{project_id}/branches
//
// It emits an allow-listed projection of branch metadata (ids/names/flags/
// timestamps) to ops/release/infra-registry.json. It NEVER reads, requests,
// or writes connection strings, passwords, DATABASE_URL, DIRECT_URL, or any
// credential/secret value. The bearer token is only ever sent in the request
// Authorization header — it is never logged or written to output.
//
// Required environment (provided by the workflow, not hard-coded):
//   NEON_API_KEY    — GitHub secret  (bearer token)
//   NEON_PROJECT_ID — GitHub variable (project id)

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const NEON_API_BASE = 'https://console.neon.tech/api/v2';
const OUTPUT_PATH = 'ops/release/infra-registry.json';

// Only these fields are ever copied into the output. Anything else returned by
// the API is discarded, so the projection cannot accidentally leak a field.
const BRANCH_ALLOW_LIST = [
  'id',
  'name',
  'default',
  'primary',
  'protected',
  'parent_id',
  'created_at',
  'updated_at',
  // S6 discriminating activity metrics (non-sensitive: sizes, durations, counts).
  // These distinguish a live production workload from idle snapshots/backups.
  'logical_size',
  'last_reset_at',
  'cpu_used_sec',
  'compute_time_seconds',
  'active_time_seconds',
  'written_data_bytes',
  'data_transfer_bytes',
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`[infra-registry] Missing required env: ${name}. Stopping (no API call made).`);
    process.exit(2);
  }
  return value.trim();
}

function projectBranch(branch) {
  const out = {};
  for (const key of BRANCH_ALLOW_LIST) {
    if (Object.prototype.hasOwnProperty.call(branch, key)) {
      out[key] = branch[key];
    }
  }
  // Defensive: a small, derived current_state string if Neon provides it as an
  // object/enum. Never include endpoints/hosts/connection info.
  if (typeof branch.current_state === 'string') {
    out.current_state = branch.current_state;
  }
  return out;
}

async function main() {
  const apiKey = requireEnv('NEON_API_KEY');
  const projectId = requireEnv('NEON_PROJECT_ID');

  const url = `${NEON_API_BASE}/projects/${encodeURIComponent(projectId)}/branches`;

  let res;
  try {
    res = await fetch(url, {
      method: 'GET', // read-only — the ONLY method this script ever uses
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    });
  } catch (err) {
    console.error(`[infra-registry] Network error calling Neon API: ${err.message}. Stopping.`);
    process.exit(1);
  }

  if (!res.ok) {
    // Do not echo response body blindly (could contain request echoes). Status only.
    console.error(`[infra-registry] Neon API returned HTTP ${res.status}. Stopping (no output written).`);
    process.exit(1);
  }

  const body = await res.json();
  const branches = Array.isArray(body.branches) ? body.branches : [];

  if (branches.length === 0) {
    console.error('[infra-registry] No branches returned. Marking UNKNOWN; writing empty registry.');
  }

  const projected = branches.map(projectBranch);

  // env -> DB identity mapping is left as UNKNOWN here: this script reports the
  // raw branch inventory only. Human/Controller maps env->branch in a later,
  // separately-approved step. We surface the likely default/primary as a hint.
  const defaultBranch = projected.find((b) => b.default === true || b.primary === true);

  const registry = {
    schema: 'dubiz.release.infra-registry/v1',
    generated_by: 'release-infra-registry workflow (Phase 4 · Step 1)',
    source: {
      provider: 'neon',
      api: `${NEON_API_BASE}/projects/{project_id}/branches`,
      method: 'GET',
      project_id: projectId, // a non-secret identifier (GitHub variable)
    },
    note: 'Branch inventory only. Contains NO connection strings or credentials. env->branch binding is UNKNOWN until separately approved.',
    branch_count: projected.length,
    default_or_primary_branch_hint: defaultBranch ? { id: defaultBranch.id, name: defaultBranch.name } : null,
    env_to_branch_identity: {
      production: 'UNKNOWN',
      preview: 'UNKNOWN',
      development: 'UNKNOWN',
    },
    branches: projected,
  };

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(registry, null, 2) + '\n', 'utf8');

  console.log(`[infra-registry] Wrote ${OUTPUT_PATH} with ${projected.length} branch record(s). No credentials included.`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      '## Neon Infrastructure Registry (read-only)',
      '',
      `- Project: \`${projectId}\``,
      `- Branches found: **${projected.length}**`,
      defaultBranch ? `- Default/primary hint: \`${defaultBranch.name}\` (\`${defaultBranch.id}\`)` : '- Default/primary hint: _none reported_',
      '',
      '| id | name | default | protected | created_at |',
      '| --- | --- | --- | --- | --- |',
      ...projected.map(
        (b) => `| ${b.id ?? ''} | ${b.name ?? ''} | ${b.default ?? ''} | ${b.protected ?? ''} | ${b.created_at ?? ''} |`,
      ),
      '',
      '_No connection strings or credentials are collected. env→branch binding remains UNKNOWN._',
    ];
    await writeFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n', { flag: 'a' });
  }
}

main();
