#!/usr/bin/env node
// Phase 4 · Step 2 — Config Registry (keys + scope matrix)
//
// READ-ONLY. This script does NOT call any network/provider itself. It parses
// previously-exported, read-only text dumps of:
//   - `vercel env ls`     (key names + scope; the value column is "Encrypted")
//   - `gh secret list`    (secret NAMES + timestamps; never values)
//   - `gh variable list`  (variable NAMES + timestamps; value column DROPPED)
//
// It emits ONLY: key name, source, scope (Production/Preview/Development),
// exists/missing, and an optional updated timestamp. It NEVER stores or emits
// secret values, DATABASE_URL/DIRECT_URL values, tokens, passwords, or any
// credential. Raw input lines are never copied into the output.
//
// Inputs (optional file paths; if omitted, a template with empty data is written):
//   VERCEL_ENV_TXT   path to `vercel env ls` text
//   GH_SECRET_TXT    path to `gh secret list` text
//   GH_VARIABLE_TXT  path to `gh variable list` text

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const JSON_OUT = 'ops/release/config-registry.json';
const KNOWN_SCOPES = ['Production', 'Preview', 'Development'];

async function readMaybe(path) {
  if (!path) return null;
  try {
    return await readFile(path, 'utf8');
  } catch {
    console.error(`[config-registry] Input not readable: ${path} (skipping).`);
    return null;
  }
}

// First whitespace-delimited token of a line — used as the key/secret/var NAME.
function firstToken(line) {
  const m = line.trim().match(/^(\S+)/);
  return m ? m[1] : null;
}

// Heuristic header/separator detection so we never treat a header as a key.
function isNoise(line) {
  const t = line.trim();
  if (!t) return true;
  if (/^name\b/i.test(t)) return true; // column header
  if (/^vercel cli\b/i.test(t)) return true;
  if (/^(retrieving|fetching|environment variables|>|-|deployments|common next|secrets|variables)\b/i.test(t)) return true;
  if (/^[-=\s]+$/.test(t)) return true;
  return false;
}

function isoTimestamp(line) {
  const m = line.match(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z\b/);
  return m ? m[0] : null;
}

// Parse `vercel env ls`: name + which KNOWN_SCOPES appear on the line.
// Scope detection is applied ONLY here (env output), never on variable values.
function parseVercelEnv(text, registry) {
  if (!text) return;
  for (const line of text.split(/\r?\n/)) {
    if (isNoise(line)) continue;
    const name = firstToken(line);
    if (!name) continue;
    const scopes = KNOWN_SCOPES.filter((s) => new RegExp(`\\b${s}\\b`).test(line));
    if (scopes.length === 0) continue; // a real env row always lists a scope
    const entry = ensure(registry, name);
    entry.sources.add('vercel-env');
    for (const s of scopes) entry.scopes[s.toLowerCase()] = true;
  }
}

// Parse `gh secret list` / `gh variable list`: NAME (first token) only.
// We deliberately DROP every column except the name. No scope is inferred
// (repo-level), and the variable VALUE column is never read.
function parseGhList(text, registry, source) {
  if (!text) return;
  for (const line of text.split(/\r?\n/)) {
    if (isNoise(line)) continue;
    const name = firstToken(line);
    if (!name || !/^[A-Z0-9_]+$/.test(name)) continue;
    const entry = ensure(registry, name);
    entry.sources.add(source);
    const ts = isoTimestamp(line);
    if (ts && !entry.updated) entry.updated = ts;
  }
}

function ensure(registry, name) {
  if (!registry.has(name)) {
    registry.set(name, {
      sources: new Set(),
      scopes: { production: false, preview: false, development: false },
      updated: null,
    });
  }
  return registry.get(name);
}

function toMatrix(registry) {
  return [...registry.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => ({
      key,
      sources: [...v.sources].sort(),
      scopes: v.scopes,
      updated: v.updated,
    }));
}

function findGaps(matrix) {
  // Keys present in Production but absent in Preview (the G5 finding pattern).
  return matrix
    .filter((m) => m.scopes.production && !m.scopes.preview && m.sources.includes('vercel-env'))
    .map((m) => m.key);
}

async function main() {
  const registry = new Map();

  parseVercelEnv(await readMaybe(process.env.VERCEL_ENV_TXT), registry);
  parseGhList(await readMaybe(process.env.GH_SECRET_TXT), registry, 'gh-secret');
  parseGhList(await readMaybe(process.env.GH_VARIABLE_TXT), registry, 'gh-variable');

  const matrix = toMatrix(registry);
  const isTemplate = matrix.length === 0;

  const out = {
    schema: 'dubiz.release.config-registry/v1',
    generated_by: isTemplate
      ? 'TEMPLATE — no input dumps provided'
      : 'build-config-registry (Phase 4 · Step 2) from read-only text dumps',
    note: 'Key NAMES + scope + source only. Contains NO secret values, tokens, or credentials. Variable values are never read.',
    sources: {
      'vercel-env': 'vercel env ls (names + scope; values are Encrypted/ignored)',
      'gh-secret': 'gh secret list (names + timestamps; values never exposed)',
      'gh-variable': 'gh variable list (names only; value column dropped)',
    },
    key_count: matrix.length,
    production_only_keys_missing_in_preview: findGaps(matrix),
    keys: matrix,
  };

  await mkdir(dirname(JSON_OUT), { recursive: true });
  await writeFile(JSON_OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`[config-registry] Wrote ${JSON_OUT} with ${matrix.length} key(s). No values included.`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      '## Config Registry (read-only, names + scope only)',
      '',
      `- Keys catalogued: **${matrix.length}**`,
      `- Production-only (missing in Preview): ${out.production_only_keys_missing_in_preview.length}`,
      '',
      '| key | sources | prod | preview | dev |',
      '| --- | --- | --- | --- | --- |',
      ...matrix.map(
        (m) =>
          `| ${m.key} | ${m.sources.join(', ')} | ${m.scopes.production ? '✓' : ''} | ${m.scopes.preview ? '✓' : ''} | ${m.scopes.development ? '✓' : ''} |`,
      ),
    ];
    await writeFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n', { flag: 'a' });
  }
}

main();
