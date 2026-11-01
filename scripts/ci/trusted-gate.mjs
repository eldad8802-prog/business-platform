#!/usr/bin/env node
/**
 * trusted-gate.mjs — run main's static security guards over a PR's tree, without trusting the PR (Stage D,
 * owner 2026-11-01). Called by .github/workflows/security-gate-trusted.yml (pull_request_target).
 *
 * WHY. security/gate runs on `pull_request`: the PR's own workflow and the PR's own guard scripts decide
 * whether the PR passes. A PR that deletes a guard step, rewrites a guard, or adds its own violation to a
 * ratchet still gets a green security/gate. This runner closes that: everything that DECIDES comes from main,
 * the PR contributes only the files being judged.
 *
 * TRUST MODEL
 *   from main (--trusted, a checkout of the commit the workflow itself came from):
 *     - the guard scripts and the list of guards below (this file);
 *     - the guards' POLICY: everything under scripts/ci/ (ratchets, allowlists, manifests), prisma/migrations/
 *       (several guards derive exceptions from the migrations), and tsconfig.json (module resolution);
 *     - node_modules, installed from main's lockfile with --ignore-scripts, and Prisma's types generated from
 *       main's schema (by the workflow, in the trusted checkout).
 *   from the PR (--pr, a checkout of the PR head): the source files the guards judge — as DATA. Nothing in the
 *   PR tree is executed: no npm, no npx, no prisma (a schema's generator is a command), no build, no test; no
 *   PR file is imported or sourced. The guards are run by absolute path from the trusted checkout, with a
 *   cleared environment (no NODE_OPTIONS / BASH_ENV), against a COPY of the PR tree ("scan tree"):
 *     - .git, node_modules and .next are not copied; a symlink anywhere fails the run (fail closed: it
 *       could point the overlay or a guard outside the tree);
 *     - the policy paths above are replaced by main's;
 *     - scan/node_modules points at main's node_modules (type resolution only).
 *
 * VERDICT (per guard, fail closed)
 *   exit 0 → pass. Otherwise the output is read: a finding that is only STALE (a ratchet / debt / allowlist
 *   entry that the PR made unnecessary — RATCHET-STALE, DEBT-STALE, SANCTIONED-STALE, EXEMPT-STALE, STALE
 *   ALLOWLIST ENTRY, an approved writer gone or fewer) is a WARNING here: main's policy cannot know a cleanup
 *   that only the PR contains, and the untrusted security/gate still demands the policy be updated. Any other
 *   finding fails. A non-zero exit with no recognisable finding fails. A guard of the list missing from main
 *   fails, except the ones marked `optional` (a guard not merged yet; it joins by itself once it is in main).
 *   Stale is never a cover: a debt or sanction that no longer matches is not applied, so the violation it
 *   covered is reported as its own (non-stale) failure.
 *
 * WHAT IT IS NOT
 *   - Not a replacement for security/gate: tests, labs and the build run PR code and stay on `pull_request`.
 *   - A guard that only the PR adds or tightens is not run here until it is in main (main decides).
 *   - The check it produces is published by GitHub Actions; a PR workflow could publish a check of the same
 *     name. WP-7 (workflow-policy-guard, run here from main) fails such a PR, but whether GitHub then counts
 *     the lookalike is a ruleset question for the spoof experiment. If it does, the result file (--result)
 *     is what a dedicated GitHub App step would publish as its own check, pinned in the ruleset to that App;
 *     no change to this runner is needed for that.
 *
 * Usage:
 *   node scripts/ci/trusted-gate.mjs --trusted <main checkout> --pr <PR checkout> [--work <dir>] [--result <json>]
 *   node scripts/ci/trusted-gate.mjs --self-test
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** The guards security/gate runs that only READ files (no PR code executed). Order = report order. */
export const GUARDS = [
  { id: "ast-security-guard", run: ["node", "scripts/ci/ast-security-guard.mjs", "{scan}"] },
  { id: "tenant-scoped-access-guard", run: ["node", "scripts/ci/tenant-scoped-access-guard.mjs", "{scan}"] },
  { id: "tenant-context-guard", run: ["bash", "scripts/ci/tenant-context-guard.sh", "{scan}"] },
  { id: "admin-boundary-guard", run: ["bash", "scripts/ci/admin-boundary-guard.sh", "{scan}"] },
  { id: "workflow-policy-guard", run: ["node", "scripts/ci/workflow-policy-guard.mjs", "{scan}"] },
  { id: "evidence-output-guard", run: ["node", "scripts/ci/evidence-output-guard.mjs", "{scan}", "--sql"] },
  // Appointments P0-2 (#906, not in main yet): joins by itself once main has it.
  { id: "appointment-write-guard", run: ["node", "scripts/ci/appointment-write-guard.mjs", "{scan}"], optional: true },
];

/** Paths whose content is POLICY: always main's, whatever the PR holds there. */
export const POLICY_FROM_MAIN = ["scripts/ci", "prisma/migrations", "tsconfig.json"];
const NOT_COPIED = new Set([".git", "node_modules", ".next"]);

const FINDING = /\[FAIL\]|\bVIOLATION\b|^\s*\[W[1-9]\]\s/;
const STALE = [
  /-STALE\b/,
  /STALE ALLOWLIST ENTRY/,
  /an approved time writer no longer exists/,
];
const isStale = (line) => {
  if (STALE.some((re) => re.test(line))) return true;
  const m = line.match(/approved (\d+) time write\(s\) here, found (\d+)/);
  return !!m && Number(m[2]) < Number(m[1]);
};

/** Copy the PR tree as data: no .git / node_modules / .next; a symlink anywhere refuses the tree. */
function copyTree(from, to, symlinks) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (NOT_COPIED.has(e.name)) continue;
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isSymbolicLink()) { symlinks.push(src); continue; }
    if (e.isDirectory()) copyTree(src, dst, symlinks);
    else if (e.isFile()) fs.copyFileSync(src, dst);
  }
}

/** Build the scan tree: the PR's files, main's policy, main's node_modules. Returns symlinks found. */
export function prepareScan(trusted, pr, scan) {
  fs.rmSync(scan, { recursive: true, force: true });
  const symlinks = [];
  copyTree(pr, scan, symlinks);
  for (const p of POLICY_FROM_MAIN) {
    const dst = path.join(scan, p);
    fs.rmSync(dst, { recursive: true, force: true });
    const src = path.join(trusted, p);
    if (fs.existsSync(src)) fs.cpSync(src, dst, { recursive: true, dereference: false });
  }
  const mods = path.join(trusted, "node_modules");
  if (fs.existsSync(mods)) fs.symlinkSync(mods, path.join(scan, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  return symlinks;
}

function runGuard(trusted, scan, g) {
  const script = path.join(trusted, g.run[1]);
  if (!fs.existsSync(script)) return g.optional ? { id: g.id, verdict: "skipped", reason: "not in main yet" } : { id: g.id, verdict: "fail", reason: "the guard is missing from main" };
  const slash = (p) => p.split(path.sep).join("/");
  const args = g.run.slice(1).map((a) => (a === "{scan}" ? slash(scan) : a === g.run[1] ? slash(script) : a));
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? os.homedir(), SystemRoot: process.env.SystemRoot ?? "", TEMP: os.tmpdir(), TMP: os.tmpdir(), TMPDIR: os.tmpdir(), CI: "true" };
  const r = spawnSync(g.run[0], args, { cwd: scan, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.error || r.signal) return { id: g.id, verdict: "fail", reason: `did not finish (${r.error?.message ?? r.signal})`, out };
  if (r.status === 0) return { id: g.id, verdict: "pass", out };
  const findings = out.split(/\r?\n/).filter((l) => FINDING.test(l));
  const real = findings.filter((l) => !isStale(l));
  if (findings.length === 0) return { id: g.id, verdict: "fail", reason: `exited ${r.status} with no recognisable finding — failing closed`, out };
  if (real.length > 0) return { id: g.id, verdict: "fail", reason: `${real.length} finding(s)`, findings: real, warnings: findings.filter(isStale), out };
  return { id: g.id, verdict: "pass-with-warnings", warnings: findings, out };
}

export function trustedGate({ trusted, pr, work, guards = GUARDS, log = console.log }) {
  trusted = path.resolve(trusted); pr = path.resolve(pr);
  const scan = path.join(path.resolve(work), "scan");
  const symlinks = prepareScan(trusted, pr, scan);
  const results = [];
  if (symlinks.length) results.push({ id: "scan-tree", verdict: "fail", reason: `the PR tree holds ${symlinks.length} symlink(s) (${symlinks.slice(0, 3).map((s) => path.relative(pr, s)).join(", ")}) — refused` });
  else for (const g of guards) results.push(runGuard(trusted, scan, g));
  for (const r of results) {
    log(`${r.verdict === "fail" ? "FAIL" : r.verdict === "skipped" ? "SKIP" : r.verdict === "pass-with-warnings" ? "WARN" : "PASS"}  ${r.id}${r.reason ? ` — ${r.reason}` : ""}`);
    for (const f of r.findings ?? []) log(`        ${f.trim()}`);
    for (const w of r.warnings ?? []) log(`        warning (stale under main's policy): ${w.trim()}`);
    if (r.verdict === "fail" && !r.findings && r.out) log(r.out.split(/\r?\n/).slice(-15).map((l) => `        | ${l}`).join("\n"));
  }
  const ok = results.every((r) => r.verdict !== "fail");
  log(`TRUSTED-GATE: ${ok ? "PASS" : "FAIL"} — guards and policy from main, the PR's files as data`);
  return { ok, results: results.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "out"))) };
}

// ── self-test: planted PR trees against a planted "main", fake guards (fast, no network) ─────────

function selfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trusted-gate-"));
  const write = (root, rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  // A fake guard in "main": fails on a planted `BAD(` in lib/, unless its ratchet (scripts/ci/fake.ratchet.json,
  // read from the SCANNED root, as ast-security-guard reads its own) allows that file; a ratchet entry with no
  // site left is RATCHET-STALE.
  const FAKE = `import fs from "node:fs"; import path from "node:path";
const root = process.argv[2];
const ratchet = JSON.parse(fs.readFileSync(path.join(root, "scripts/ci/fake.ratchet.json"), "utf8"));
const lib = path.join(root, "lib"); const bad = fs.existsSync(lib) ? fs.readdirSync(lib).filter((f) => fs.readFileSync(path.join(lib, f), "utf8").includes("BAD(")) : [];
let fail = 0;
for (const f of bad) if (!ratchet.includes(f)) { console.log("[FAIL] NEW-SITE lib/" + f); fail++; }
for (const f of ratchet) if (!bad.includes(f)) { console.log("[FAIL] RATCHET-STALE lib/" + f); fail++; }
process.exit(fail ? 1 : 0);`;
  const main = path.join(tmp, "main");
  write(main, "scripts/ci/fake-guard.mjs", FAKE);
  write(main, "scripts/ci/fake.ratchet.json", JSON.stringify(["old.ts"]));
  write(main, "lib/old.ts", "BAD(1)");
  write(main, "tsconfig.json", '{"compilerOptions":{"paths":{"@/*":["./*"]}}}');
  write(main, "prisma/migrations/1_init/migration.sql", "-- main");
  write(main, "node_modules/marker-main/index.js", "");
  write(main, "scripts/ci/crash-guard.mjs", "process.exit(3);");
  const fake = [{ id: "fake-guard", run: ["node", "scripts/ci/fake-guard.mjs", "{scan}"] }];
  const pwned = path.join(tmp, "PWNED");
  const poison = `require("fs").writeFileSync(${JSON.stringify(pwned)}, "x")`;

  const cases = [
    { name: "a clean PR passes", pr: {}, ok: true },
    { name: "a planted violation fails", pr: { "lib/new.ts": "BAD(2)" }, ok: false, expect: "NEW-SITE lib/new.ts" },
    { name: "the PR neuters its own copy of the guard: main's runs, still fails", pr: { "lib/new.ts": "BAD(2)", "scripts/ci/fake-guard.mjs": `${poison}; process.exit(0);` }, ok: false, expect: "NEW-SITE lib/new.ts", notPwned: true },
    { name: "the PR adds its violation to its ratchet: main's ratchet decides, still fails", pr: { "lib/new.ts": "BAD(2)", "scripts/ci/fake.ratchet.json": JSON.stringify(["old.ts", "new.ts"]) }, ok: false, expect: "NEW-SITE lib/new.ts" },
    { name: "the PR cleans up a ratchet site: stale under main's policy is a warning, not a failure", pr: { "lib/old.ts": "fine()", "scripts/ci/fake.ratchet.json": "[]" }, ok: true, warn: "RATCHET-STALE lib/old.ts" },
    { name: "a cleanup plus a new violation still fails", pr: { "lib/old.ts": "fine()", "lib/new.ts": "BAD(3)" }, ok: false, expect: "NEW-SITE lib/new.ts" },
    { name: "nothing in the PR runs: postinstall, a prisma generator, a node_modules shim", pr: { "package.json": JSON.stringify({ scripts: { postinstall: `node -e '${poison}'` } }), "prisma/schema.prisma": `generator x { provider = "node -e '${poison}'" }`, "node_modules/typescript/index.js": poison, ".bashrc": poison }, ok: true, notPwned: true },
    { name: "the PR's tsconfig / migrations are replaced by main's in the scan tree", pr: { "tsconfig.json": '{"compilerOptions":{"paths":{}}}', "prisma/migrations/1_init/migration.sql": "-- pr", "prisma/migrations/2_open/migration.sql": "-- pr" }, ok: true, scanIs: { "tsconfig.json": '{"compilerOptions":{"paths":{"@/*":["./*"]}}}', "prisma/migrations/1_init/migration.sql": "-- main", "prisma/migrations/2_open/migration.sql": null, "node_modules/marker-main/index.js": "" } },
    { name: "a guard that exits non-zero with no finding fails closed", pr: {}, ok: false, guards: [{ id: "crash", run: ["node", "scripts/ci/crash-guard.mjs", "{scan}"] }], expect: "no recognisable finding" },
    { name: "a listed guard missing from main fails", pr: {}, ok: false, guards: [{ id: "gone", run: ["node", "scripts/ci/gone.mjs", "{scan}"] }], expect: "missing from main" },
    { name: "an optional guard not in main yet is skipped", pr: {}, ok: true, guards: [{ id: "later", run: ["node", "scripts/ci/later.mjs", "{scan}"], optional: true }] },
    { name: "a symlink in the PR tree refuses the run", pr: {}, symlink: true, ok: false, expect: "symlink" },
  ];
  let failed = 0;
  cases.forEach((c, i) => {
    const pr = path.join(tmp, `pr${i}`);
    copyTree(main, pr, []);
    for (const [rel, text] of Object.entries(c.pr)) write(pr, rel, text);
    if (c.symlink) { try { fs.symlinkSync(path.join(main, "lib"), path.join(pr, "linked"), process.platform === "win32" ? "junction" : "dir"); } catch { /* no symlink support: case is vacuous */ } }
    fs.rmSync(pwned, { force: true });
    const lines = [];
    const r = trustedGate({ trusted: main, pr, work: path.join(tmp, `work${i}`), guards: c.guards ?? fake, log: (l) => lines.push(l) });
    const text = lines.join("\n");
    const scan = path.join(tmp, `work${i}`, "scan");
    const checks = [
      r.ok === c.ok,
      !c.expect || text.includes(c.expect),
      !c.warn || text.includes(`warning (stale under main's policy): [FAIL] ${c.warn}`),
      !c.notPwned || !fs.existsSync(pwned),
      !c.scanIs || Object.entries(c.scanIs).every(([rel, want]) => (want === null ? !fs.existsSync(path.join(scan, rel)) : fs.existsSync(path.join(scan, rel)) && fs.readFileSync(path.join(scan, rel), "utf8") === want)),
    ];
    const ok = checks.every(Boolean);
    if (!ok) failed++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${c.name}${ok ? "" : `\n${text.split("\n").map((l) => `       ${l}`).join("\n")}`}`);
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`trusted-gate self-test: ${cases.length - failed} passed, ${failed} failed`);
  return failed === 0;
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
if (argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
else {
  const trusted = opt("--trusted"), pr = opt("--pr");
  if (!trusted || !pr) { console.error("usage: trusted-gate.mjs --trusted <main checkout> --pr <PR checkout> [--work <dir>] [--result <json>]"); process.exit(2); }
  const work = opt("--work") ?? fs.mkdtempSync(path.join(os.tmpdir(), "trusted-gate-run-"));
  const { ok, results } = trustedGate({ trusted, pr, work });
  const result = opt("--result");
  if (result) fs.writeFileSync(result, JSON.stringify({ ok, results }, null, 2));
  process.exit(ok ? 0 : 1);
}
