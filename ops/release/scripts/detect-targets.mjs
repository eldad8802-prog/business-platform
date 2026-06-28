#!/usr/bin/env node
// Phase 4 · Step 5 — Single Target Detection (report-only)
//
// READ-ONLY. This script makes NO provider calls and performs NO mutation.
// It parses previously-captured, read-only text output of:
//   - `vercel projects ls`            (project name + latest production URL/domain)
//   - `vercel ls <project> --prod`    (production deployment URLs)
//   - `vercel inspect <url>`          (aliases incl. `*-git-<branch>-*` evidence)
//
// It reports which Vercel projects produce a Production deployment from `main`,
// marks the canonical one (the project carrying the canonical custom domain),
// and flags any non-canonical duplicate Production target (the E1 finding).
//
// It NEVER deploys, removes, promotes, links, or changes any project setting,
// and emits NO tokens, secrets, or raw env values. Deployment URLs are public.
//
// Inputs (optional file paths; if omitted, a template report is written):
//   VERCEL_PROJECTS_TXT   path to `vercel projects ls` text
//   VERCEL_PROD_TXT       path to concatenated `vercel ls <project> --prod` text
//   VERCEL_INSPECT_TXT    path to concatenated `vercel inspect <url>` text
//   CANONICAL_PROJECT     canonical project name (default: business-platform)
//   CANONICAL_DOMAIN      canonical custom domain (default: promaxgroup.co.il)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const REPORT_OUT = 'ops/release/single-target-report.md';
const CANONICAL_PROJECT = (process.env.CANONICAL_PROJECT || 'business-platform').trim();
const CANONICAL_DOMAIN = (process.env.CANONICAL_DOMAIN || 'promaxgroup.co.il').trim();

async function readMaybe(path) {
  if (!path) return null;
  try {
    return await readFile(path, 'utf8');
  } catch {
    console.error(`[detect-targets] Input not readable: ${path} (skipping).`);
    return null;
  }
}

// `vercel projects ls`: collect { project, domain } pairs.
function parseProjects(text) {
  const rows = [];
  if (!text) return rows;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /project name/i.test(t) || /vercel cli/i.test(t) || /projects found/i.test(t)) continue;
    const name = (t.match(/^(\S+)/) || [])[1];
    const url = (t.match(/https?:\/\/([^\s]+)/) || [])[0];
    if (name && url) rows.push({ project: name, productionUrl: url, domain: url.replace(/^https?:\/\//, '') });
  }
  return rows;
}

// `vercel ls <project> --prod`: collect Production deployment URLs (+ project basename).
function parseProdDeployments(text) {
  const rows = [];
  if (!text) return rows;
  for (const line of text.split(/\r?\n/)) {
    if (!/\bProduction\b/.test(line)) continue;
    const url = (line.match(/https?:\/\/[^\s]+/) || [])[0];
    const proj = (line.match(/[\w-]+\/([\w-]+)\s+https?:\/\//) || [])[1];
    if (url) rows.push({ project: proj || null, url, environment: 'Production' });
  }
  return rows;
}

// `vercel inspect`: find `<projectPrefix>-git-<branch>-<hash>.vercel.app` aliases.
// Non-greedy prefix stops at the literal `-git-`, so it captures the full project.
function parseGitAliases(text) {
  const found = new Map(); // key: `${project}::${branch}` -> evidence url
  if (!text) return found;
  const re = /\b([a-z0-9-]+?)-git-([a-z0-9-]+)-[a-z0-9]+\.vercel\.app/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const project = m[1];
    const branch = m[2];
    const key = `${project}::${branch}`;
    if (!found.has(key)) found.set(key, m[0]);
  }
  return found;
}

function md(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|');
}

async function main() {
  const projectsText = await readMaybe(process.env.VERCEL_PROJECTS_TXT);
  const prodText = await readMaybe(process.env.VERCEL_PROD_TXT);
  const inspectText = await readMaybe(process.env.VERCEL_INSPECT_TXT);

  const projects = parseProjects(projectsText);
  const prodDeployments = parseProdDeployments(prodText);
  const gitAliases = parseGitAliases(inspectText);

  const isTemplate = projects.length === 0 && prodDeployments.length === 0 && gitAliases.size === 0;

  // Which projects produce Production from `main`?
  const prodFromMain = [...gitAliases.entries()]
    .filter(([key]) => key.endsWith('::main'))
    .map(([key, evidence]) => ({ project: key.split('::')[0], branch: 'main', evidence }));

  // Canonical = the project carrying the canonical domain (fallback: configured name).
  const canonicalByDomain = projects.find((p) => p.domain.includes(CANONICAL_DOMAIN));
  const canonicalProject = canonicalByDomain ? canonicalByDomain.project : CANONICAL_PROJECT;

  const targets = prodFromMain.map((t) => ({
    ...t,
    canonical: t.project === canonicalProject,
  }));

  const nonCanonical = targets.filter((t) => !t.canonical);
  const duplicateProductionFromMain = targets.length > 1;

  const lines = [];
  lines.push('# Single Target Detection — Report (Phase 4 · Step 5)');
  lines.push('');
  if (isTemplate) {
    lines.push('> **Status: TEMPLATE.** No captured Vercel output was supplied. Run the read-only');
    lines.push('> captures and pass them via `VERCEL_PROJECTS_TXT`, `VERCEL_PROD_TXT`, `VERCEL_INSPECT_TXT`.');
    lines.push('');
  } else {
    lines.push(`> Generated from read-only captures. Canonical project: \`${canonicalProject}\`` +
      (canonicalByDomain ? ` (carries \`${CANONICAL_DOMAIN}\`).` : ` (configured default).`));
    lines.push('');
  }

  lines.push('## Projects observed');
  lines.push('');
  lines.push('| project | production URL / domain |');
  lines.push('| --- | --- |');
  for (const p of projects) lines.push(`| ${md(p.project)} | ${md(p.domain)} |`);
  if (projects.length === 0) lines.push('| _(none — template)_ | |');
  lines.push('');

  lines.push('## Production-from-main targets');
  lines.push('');
  lines.push('| project | branch | canonical? | alias evidence |');
  lines.push('| --- | --- | :---: | --- |');
  for (const t of targets) {
    lines.push(`| ${md(t.project)} | ${md(t.branch)} | ${t.canonical ? '✓ canonical' : '✗ NON-CANONICAL'} | ${md(t.evidence)} |`);
  }
  if (targets.length === 0) lines.push('| _(none — template)_ | | | |');
  lines.push('');

  lines.push('## Finding');
  lines.push('');
  if (isTemplate) {
    lines.push('- _Pending capture._');
  } else if (duplicateProductionFromMain) {
    lines.push(`- **RISK (E1): duplicate Production target.** ${targets.length} projects deploy Production from \`main\`.`);
    lines.push(`  - Canonical: \`${canonicalProject}\``);
    for (const t of nonCanonical) lines.push(`  - Non-canonical duplicate: \`${t.project}\` (evidence: \`${t.evidence}\`)`);
    lines.push('  - **Report only.** No project is changed or neutralized by this step. A Single Production Target *Gate* (enforcement) is out of scope here.');
  } else if (targets.length === 1) {
    lines.push(`- Single Production-from-main target detected: \`${targets[0].project}\` (canonical: ${targets[0].canonical}). No duplicate found.`);
  } else {
    lines.push('- No Production-from-main target detected in the supplied captures.');
  }
  lines.push('');
  lines.push('## Production deployments observed (evidence)');
  lines.push('');
  lines.push('| project | url | environment |');
  lines.push('| --- | --- | --- |');
  for (const d of prodDeployments) lines.push(`| ${md(d.project)} | ${md(d.url)} | ${md(d.environment)} |`);
  if (prodDeployments.length === 0) lines.push('| _(none — template)_ | | |');
  lines.push('');
  lines.push('_Read-only. Deployment URLs are public. No tokens, secrets, or env values are included._');

  await mkdir(dirname(REPORT_OUT), { recursive: true });
  await writeFile(REPORT_OUT, lines.join('\n') + '\n', 'utf8');
  console.log(`[detect-targets] Wrote ${REPORT_OUT}. Targets-from-main: ${targets.length}. Duplicate: ${duplicateProductionFromMain}.`);
}

main();
