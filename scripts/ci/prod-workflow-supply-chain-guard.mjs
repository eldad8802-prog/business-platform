#!/usr/bin/env node
/**
 * PROD-SUPPLY-CHAIN guard — a workflow that holds Production database
 * credentials must never fetch code from a registry at execution time.
 *
 *   node scripts/ci/prod-workflow-supply-chain-guard.mjs              # check the repo
 *   node scripts/ci/prod-workflow-supply-chain-guard.mjs --self-test  # prove the guard
 *
 * A workflow is CREDENTIAL-BEARING if it binds the `production-db` environment or
 * reads secrets.DIRECT_URL / secrets.DATABASE_URL / secrets.RUNTIME_DATABASE_URL.
 * In such a workflow (comments ignored):
 *
 *   PSC-1  no install-on-demand runner: npx, npm exec, pnpm dlx, yarn dlx, bunx.
 *          `npx tsx …` resolves a missing package by DOWNLOADING it — with the
 *          Production credentials already in the job's environment.
 *   PSC-2  no `npm install` / `npm i`: dependencies come from the lockfile only (`npm ci`).
 *   PSC-3  every node_modules/.bin/<tool> call comes after an `npm ci` step.
 *
 * And for the repository:
 *   PSC-4  tsx is an EXACT devDependency (no ^ ~ * x ranges), locked in
 *          package-lock.json at the same version with an integrity hash.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const CREDENTIAL = /environment:\s*production-db\b|secrets\.(DIRECT_URL|DATABASE_URL|RUNTIME_DATABASE_URL)\b/;
const ON_DEMAND = /\bnpx\b|\bnpm\s+exec\b|\bpnpm\s+dlx\b|\byarn\s+dlx\b|\bbunx\b/;
const NPM_INSTALL = /\bnpm\s+(install|i)\b/;
const NPM_CI = /\bnpm\s+ci\b/;
const LOCAL_BIN = /node_modules\/\.bin\//;

export function checkWorkflow(name, text) {
  if (!CREDENTIAL.test(text)) return { credentialBearing: false, violations: [] };
  const violations = [];
  let sawCi = false;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, "");
    if (!line.trim()) return;
    if (NPM_CI.test(line)) sawCi = true;
    if (ON_DEMAND.test(line)) violations.push(`${name}:${i + 1} PSC-1 install-on-demand runner: ${raw.trim()}`);
    if (NPM_INSTALL.test(line)) violations.push(`${name}:${i + 1} PSC-2 npm install (use npm ci): ${raw.trim()}`);
    if (LOCAL_BIN.test(line) && !sawCi) violations.push(`${name}:${i + 1} PSC-3 local binary before npm ci: ${raw.trim()}`);
  });
  return { credentialBearing: true, violations };
}

export function checkTsxPin(pkg, lock) {
  const v = pkg.devDependencies?.tsx ?? pkg.dependencies?.tsx;
  const out = [];
  if (!v) out.push("PSC-4 tsx is not a declared dependency");
  else if (!/^\d+\.\d+\.\d+$/.test(v)) out.push(`PSC-4 tsx is not pinned exactly (${v})`);
  const locked = lock.packages?.["node_modules/tsx"];
  if (!locked) out.push("PSC-4 tsx is not in package-lock.json");
  else {
    if (v && locked.version !== v) out.push(`PSC-4 lockfile tsx ${locked.version} ≠ package.json ${v}`);
    if (!locked.integrity) out.push("PSC-4 lockfile tsx has no integrity hash");
  }
  return out;
}

function selfTest() {
  let fails = 0;
  const is = (label, cond) => {
    if (!cond) fails += 1;
    console.log(`  [${cond ? "PASS" : "FAIL"}] ${label}`);
  };
  const prod = (body) => `jobs:\n  j:\n    environment: production-db\n    steps:\n      - run: npm ci\n${body}`;
  is("prod + npx tsx → violation", checkWorkflow("a", prod("      - run: npx tsx x.ts\n")).violations.length === 1);
  is("prod + npx prisma → violation", checkWorkflow("a", prod("      - run: npx prisma migrate deploy\n")).violations.length === 1);
  is("prod + npm exec → violation", checkWorkflow("a", prod("      - run: npm exec tsx x.ts\n")).violations.length === 1);
  is("prod + pnpm dlx / yarn dlx / bunx → violations", checkWorkflow("a", prod("      - run: pnpm dlx a\n      - run: yarn dlx b\n      - run: bunx c\n")).violations.length === 3);
  is("prod + npm install → violation", checkWorkflow("a", prod("      - run: npm install\n")).violations.length === 1);
  is("prod + local binary after npm ci → clean", checkWorkflow("a", prod("      - run: node_modules/.bin/tsx x.ts\n")).violations.length === 0);
  is("prod + local binary BEFORE npm ci → violation",
    checkWorkflow("a", "jobs:\n  j:\n    environment: production-db\n    steps:\n      - run: node_modules/.bin/tsx x.ts\n      - run: npm ci\n").violations.length === 1);
  is("secrets.DIRECT_URL without the environment is still credential-bearing",
    checkWorkflow("a", "steps:\n  - env:\n      D: ${{ secrets.DIRECT_URL }}\n    run: npx tsx x.ts\n").violations.length === 1);
  is("a comment mentioning npx is ignored", checkWorkflow("a", prod("      # npx tsx is forbidden here\n      - run: node_modules/.bin/tsx x.ts\n")).violations.length === 0);
  is("a non-credential workflow may use npx", checkWorkflow("a", "jobs:\n  j:\n    steps:\n      - run: npx tsx x.ts\n").credentialBearing === false);
  is("tsx pinned + locked → clean", checkTsxPin({ devDependencies: { tsx: "4.23.15" } }, { packages: { "node_modules/tsx": { version: "4.23.15", integrity: "sha512-x" } } }).length === 0);
  is("tsx with a caret range → 'not pinned exactly' violation",
    checkTsxPin({ devDependencies: { tsx: "^4.23.15" } }, { packages: { "node_modules/tsx": { version: "4.23.15", integrity: "sha512-x" } } })
      .some((v) => v.includes("not pinned exactly")));
  is("tsx missing from the lockfile → violation", checkTsxPin({ devDependencies: { tsx: "4.23.15" } }, { packages: {} }).length === 1);
  is("tsx lock/package mismatch → violation", checkTsxPin({ devDependencies: { tsx: "4.23.15" } }, { packages: { "node_modules/tsx": { version: "4.20.0", integrity: "sha512-x" } } }).length === 1);
  console.log(fails === 0 ? "prod-workflow-supply-chain-guard self-test: PASS" : `self-test: ${fails} FAIL`);
  process.exit(fails === 0 ? 0 : 1);
}

function main() {
  const root = process.cwd();
  const dir = path.join(root, ".github", "workflows");
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  const violations = [];
  const credentialBearing = [];
  for (const f of files) {
    const r = checkWorkflow(`.github/workflows/${f}`, readFileSync(path.join(dir, f), "utf8"));
    if (r.credentialBearing) credentialBearing.push(f);
    violations.push(...r.violations);
  }
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  violations.push(...checkTsxPin(pkg, lock));
  console.log(`credential-bearing workflows: ${credentialBearing.length}`);
  for (const f of credentialBearing) console.log(`  - ${f}`);
  if (violations.length > 0) {
    console.error(`\nPROD-SUPPLY-CHAIN GUARD: FAIL (${violations.length})`);
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
  console.log(`tsx pinned: ${pkg.devDependencies?.tsx ?? pkg.dependencies?.tsx} (locked, integrity present)`);
  console.log("PROD-SUPPLY-CHAIN GUARD: PASS");
}

if (process.argv.includes("--self-test")) selfTest();
else main();
