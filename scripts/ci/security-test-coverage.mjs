#!/usr/bin/env node
/**
 * security-test-coverage.mjs — M-16 F-9: no security test may silently stop running.
 *
 * The audit found 206 of 312 test files that no workflow ran, including tenant-isolation,
 * RLS-contract, webhook-signature and token-revocation suites. This script makes the set
 * of test files a CLASSIFIED, CHECKED inventory:
 *
 *   CHECK (default)
 *     C1  every tracked *.test.{ts,tsx,mts,mjs,js,cjs} file is classified exactly once
 *         (a new unclassified test FAILS; a manifest entry for a deleted file FAILS);
 *     C2  every classification carries a reason; the class is one of CLASSES;
 *     C3  a file whose path LOOKS security-relevant (SECURITY_HEURISTIC) may only be
 *         classified non-security with an explicit `notSecurityBecause`;
 *     C4  every SECURITY_REQUIRED file is INVOKED by CI:
 *           lab pure | test-db | owner-lab  -> security-gate.yml runs `--run --lab <lab>`,
 *                                              which executes every entry of that lab;
 *           lab workflow                    -> the named workflow has a pull_request
 *                                              trigger and a run step naming the file.
 *
 *   RUN  (--run --lab <lab>): execute every SECURITY_REQUIRED entry of that lab with tsx,
 *     require exit 0 AND a non-vacuous result (at least one assertion marker, no
 *     "0 passed"/"0 checks"), and require that the number executed equals the number the
 *     manifest declares — so an entry can never be skipped quietly.
 *
 * MANIFEST: every scripts/ci/test-coverage/*.json fragment is merged, so a workstream adds
 * its own fragment file instead of editing a shared line. A test referenced by a
 * `.github/workflows/sec-*-ci.yml` run step and absent from every fragment is accepted as
 * SECURITY_REQUIRED (lab workflow) automatically — the reference IS the classification.
 *
 * Usage:
 *   node scripts/ci/security-test-coverage.mjs                 check
 *   node scripts/ci/security-test-coverage.mjs --run --lab pure
 *   node scripts/ci/security-test-coverage.mjs --stats
 *   node scripts/ci/security-test-coverage.mjs --self-test
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CLASSES = ["SECURITY_REQUIRED", "PRODUCT_REQUIRED", "OBSOLETE", "DUPLICATE", "LOCAL_ONLY", "INTEGRATION_EXTERNAL"];
export const LABS = ["pure", "test-db", "rls-db", "owner-lab", "workflow"];
export const TEST_FILE = /\.test\.(ts|tsx|mts|mjs|js|cjs)$/;
export const SECURITY_HEURISTIC =
  /auth|tenant|rls|webhook|erasure|csrf|signature|privilege|isolation|token|payment-authori[sz]ation|grant|session|secret|crypto|signed|permission|revoc|signup|mfa|step-up|quarantine|ownership|boundary|hardening|sender|callback|security|rate-limit|signing|admin/i;
const GATE = ".github/workflows/security-gate.yml";
const MANIFEST_DIR = "scripts/ci/test-coverage";

function trackedTests(root) {
  let out;
  try {
    out = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
  } catch {
    out = "";
  }
  return out.split("\n").filter((f) => TEST_FILE.test(f)).sort();
}

export function loadManifest(root) {
  const dir = path.join(root, MANIFEST_DIR);
  const entries = new Map();
  const problems = [];
  if (!fs.existsSync(dir)) return { entries, problems: [`[FAIL] C1 manifest directory ${MANIFEST_DIR} is missing`] };
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch (e) {
      problems.push(`[FAIL] C1 ${MANIFEST_DIR}/${f} is not valid JSON: ${e.message}`);
      continue;
    }
    for (const [p, e] of Object.entries(doc.tests ?? {})) {
      if (entries.has(p)) problems.push(`[FAIL] C1 ${p} is classified twice (${entries.get(p).fragment} and ${f})`);
      else entries.set(p, { ...e, fragment: f });
    }
  }
  return { entries, problems };
}

/** Workflow texts with comment lines removed. */
function workflows(root) {
  const dir = path.join(root, ".github/workflows");
  if (!fs.existsSync(dir)) return new Map();
  return new Map(
    fs
      .readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => [f, expandNpmRun(root, fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n"))])
  );
}

/** Append the package.json script bodies that `npm run X` invokes (recursively), so a test run
 *  through a script counts as invoked by that workflow. */
function expandNpmRun(root, text) {
  let scripts = {};
  try { scripts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts ?? {}; } catch { /* no package.json */ }
  const seen = new Set();
  const go = (t) => {
    let out = t;
    for (const m of t.matchAll(/npm run ([\w:.-]+)/g)) {
      if (seen.has(m[1]) || !scripts[m[1]]) continue;
      seen.add(m[1]);
      out += `\n${go(scripts[m[1]])}`;
    }
    return out;
  };
  return go(text);
}

/** A workflow names a test file literally, or through a shell glob (`ls lib/x/*.test.ts`,
 *  `for f in lib/x/*.test.ts`) or a `find DIR -name PATTERN` loop. */
export function mentions(text, file) {
  if (text.includes(file)) return true;
  const globRe = (g) =>
    new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(?:.*/)?").replace(/\*/g, "[^/]*") + "$");
  for (const m of text.matchAll(/([\w./-]*\*[\w.*/-]*\.test\.[cm]?[jt]sx?)/g)) if (globRe(m[1]).test(file)) return true;
  for (const m of text.matchAll(/find\s+(\S+)\s+-name\s+["']([^"']+)["']/g)) {
    const dir = m[1].replace(/\/$/, "");
    if (file.startsWith(dir + "/") && globRe(m[2]).test(file.split("/").pop())) return true;
  }
  return false;
}

function hasPullRequestTrigger(text) {
  return /^on:\s*\[?[^\n]*pull_request/m.test(text) || /^\s{2}pull_request:/m.test(text);
}

export function check(root, { log = console.log } = {}) {
  const files = trackedTests(root);
  const { entries, problems } = loadManifest(root);
  const wf = workflows(root);
  const secWorkflows = [...wf].filter(([f]) => /^sec-.*-ci\.ya?ml$/.test(f));

  // Implicit SECURITY_REQUIRED for tests a sec-*-ci.yml workflow runs.
  for (const f of files) {
    if (entries.has(f)) continue;
    const by = secWorkflows.find(([, t]) => mentions(t, f));
    if (by) entries.set(f, { class: "SECURITY_REQUIRED", lab: "workflow", workflow: by[0], reason: `run by ${by[0]} (implicit)`, fragment: "<implicit>" });
  }

  const fileSet = new Set(files);
  for (const f of files) if (!entries.has(f)) problems.push(`[FAIL] C1 UNCLASSIFIED ${f} — add it to a ${MANIFEST_DIR}/*.json fragment`);
  for (const [p, e] of entries) {
    if (!fileSet.has(p)) problems.push(`[FAIL] C1 STALE ${p} is classified (${e.fragment}) but is not a tracked test file`);
    if (!CLASSES.includes(e.class)) problems.push(`[FAIL] C2 ${p} has unknown class ${e.class}`);
    if (!e.reason || String(e.reason).trim().length < 8) problems.push(`[FAIL] C2 ${p} has no reason`);
    if (SECURITY_HEURISTIC.test(p) && e.class !== "SECURITY_REQUIRED" && !(e.notSecurityBecause && e.notSecurityBecause.trim().length >= 12))
      problems.push(`[FAIL] C3 ${p} looks security-relevant but is ${e.class} without notSecurityBecause`);
    if (e.class === "SECURITY_REQUIRED") {
      if (!LABS.includes(e.lab)) problems.push(`[FAIL] C4 ${p} SECURITY_REQUIRED without a valid lab (${e.lab})`);
      else if (e.lab === "workflow") {
        const t = wf.get(e.workflow ?? "");
        if (!t) problems.push(`[FAIL] C4 ${p} names workflow ${e.workflow} which does not exist`);
        else if (!hasPullRequestTrigger(t)) problems.push(`[FAIL] C4 ${p} is run by ${e.workflow}, which has no pull_request trigger`);
        else if (!mentions(t, p)) problems.push(`[FAIL] C4 NOT-INVOKED ${p} — ${e.workflow} has no run step naming it`);
      } else {
        const gate = wf.get(path.basename(GATE));
        const re = new RegExp(`security-test-coverage\\.mjs --run --lab ${e.lab}\\b`);
        if (!gate || !re.test(gate) || !hasPullRequestTrigger(gate)) problems.push(`[FAIL] C4 NOT-INVOKED ${p} — ${GATE} does not run lab ${e.lab} on pull_request`);
      }
    }
  }
  const counts = Object.fromEntries(CLASSES.map((c) => [c, 0]));
  for (const [p, e] of entries) if (fileSet.has(p)) counts[e.class] = (counts[e.class] ?? 0) + 1;
  log(`security-test-coverage: ${files.length} test files; ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  for (const p of problems) log(p);
  log(problems.length ? `SECURITY-TEST-COVERAGE: FAIL (${problems.length})` : "SECURITY-TEST-COVERAGE: PASS");
  return problems.length === 0;
}

const ASSERTION_MARKER = /(^|\s)(ok|OK|PASS|PASSED|passed|✓|✔)\b|\b\d+\s+(checks?|assertions?|tests?)\s+passed|\bpassed\b/;
const VACUOUS = /\b0\s+(checks?|assertions?|tests?)\s+(passed|run)\b|\bran 0\b|\b0 passed\b/i;

/**
 * Per-test database isolation. Every DB-lab test gets a FRESH database:
 *   test-db    clone of GATE_PG_TEMPLATE (schema built once), connected as the lab owner.
 *              These are APP-LAYER proofs (the owner bypasses RLS) and are labelled so.
 *   rls-db     clone of the template, DATABASE_URL = GATE_RLS_ROLE (NOSUPERUSER NOBYPASSRLS
 *              login role), RLS_ADMIN_URL/ADMIN_URL = owner. The runner REFUSES to start the
 *              test if that role is rolsuper or rolbypassrls (F-5).
 *   owner-lab  EMPTY database (template0), OWNER_URL = owner; the test builds its own roles
 *              and policies from the shipped migration.
 * Env: GATE_PG_URL (owner URL of any database on the lab server), GATE_PG_TEMPLATE,
 *      GATE_RLS_ROLE, GATE_RLS_PASSWORD, PSQL (optional psql path).
 */
function labEnv(lab, testPath) {
  const base = { ...process.env, AUTH_TOKEN_SECRET: process.env.AUTH_TOKEN_SECRET ?? "security_gate_synthetic_auth_secret_0123456789" };
  if (lab === "pure") {
    for (const k of ["DATABASE_URL", "DIRECT_URL", "TEST_DATABASE_URL", "OWNER_URL", "RLS_ADMIN_URL", "ADMIN_URL"]) delete base[k];
    return { env: base, dropDb: null };
  }
  const admin = process.env.GATE_PG_URL;
  if (!admin) throw new Error("GATE_PG_URL is not set — a DB lab cannot run without its own server");
  const u = new URL(admin);
  if (!/^(localhost|127\.0\.0\.1|postgres)$/.test(u.hostname)) throw new Error(`refusing a non-local lab server (${u.hostname})`);
  const psql = process.env.PSQL ?? "psql";
  const q = (sql, url = admin) => {
    const r = spawnSync(psql, [url, "-v", "ON_ERROR_STOP=1", "-qtAc", sql], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`psql: ${(r.stderr || r.error || "").toString().trim()}`);
    return r.stdout.trim();
  };
  const db = `gate_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;
  const template = lab === "owner-lab" ? "template0" : process.env.GATE_PG_TEMPLATE;
  if (!template) throw new Error("GATE_PG_TEMPLATE is not set");
  q(`CREATE DATABASE ${db} TEMPLATE ${template}`);
  const dropDb = () => { try { q(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`); } catch { /* best effort */ } };
  const owner = new URL(admin);
  owner.pathname = `/${db}`;
  const ownerUrl = owner.toString();
  try {
    if (lab === "test-db") return { env: { ...base, DATABASE_URL: ownerUrl, DIRECT_URL: ownerUrl, TEST_DATABASE_URL: ownerUrl }, dropDb };
    if (lab === "owner-lab") return { env: { ...base, OWNER_URL: ownerUrl, DATABASE_URL: ownerUrl, DIRECT_URL: ownerUrl }, dropDb };
    if (lab === "rls-db") {
      const role = process.env.GATE_RLS_ROLE;
      const pw = process.env.GATE_RLS_PASSWORD;
      if (!role || !pw) throw new Error("GATE_RLS_ROLE / GATE_RLS_PASSWORD are not set");
      const rt = new URL(ownerUrl);
      rt.username = role;
      rt.password = pw;
      const posture = q("SELECT rolsuper::text || ',' || rolbypassrls::text FROM pg_roles WHERE rolname = current_user", rt.toString());
      if (posture !== "false,false") throw new Error(`the rls-db runtime role must be NOSUPERUSER NOBYPASSRLS (got super,bypass=${posture}) — refusing to run a DB-isolation proof that cannot fail`);
      return { env: { ...base, DATABASE_URL: rt.toString(), DIRECT_URL: rt.toString(), RLS_ADMIN_URL: ownerUrl, ADMIN_URL: ownerUrl }, dropDb };
    }
  } catch (e) {
    dropDb();
    throw e;
  }
  dropDb();
  throw new Error(`unknown lab ${lab} for ${testPath}`);
}

export function runLab(root, lab, { tsx, log = console.log } = {}) {
  const { entries } = loadManifest(root);
  const todo = [...entries].filter(([, e]) => e.class === "SECURITY_REQUIRED" && e.lab === lab).map(([p]) => p).sort();
  const tsxCmd = tsx ?? process.env.TSX_CLI ?? null;
  let passed = 0;
  const failures = [];
  for (const p of todo) {
    const t0 = Date.now();
    let env;
    let dropDb = null;
    let why = null;
    try {
      ({ env, dropDb } = labEnv(lab, p));
    } catch (e) {
      why = `lab setup failed: ${e.message}`;
    }
    const r = why
      ? { status: 1, stdout: "", stderr: "" }
      : tsxCmd
        ? spawnSync(process.execPath, [tsxCmd, p], { cwd: root, encoding: "utf8", timeout: 300000, maxBuffer: 256 << 20, env })
        : spawnSync("npx", ["--no-install", "tsx", p], { cwd: root, encoding: "utf8", timeout: 300000, maxBuffer: 256 << 20, env, shell: process.platform === "win32" });
    if (dropDb) dropDb();
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (why) { /* setup failure already recorded */ }
    else if (r.status !== 0) why = `exit ${r.status ?? r.signal}`;
    else if (!ASSERTION_MARKER.test(out)) why = "exit 0 but no assertion marker (vacuous green)";
    else if (VACUOUS.test(out)) why = "exit 0 but reports zero assertions (vacuous green)";
    if (why) {
      failures.push(p);
      log(`[FAIL] ${p} (${secs}s): ${why}`);
      log(out.split(/\r?\n/).slice(-40).join("\n"));
    } else {
      passed++;
      log(`[PASS] ${p} (${secs}s)`);
    }
  }
  log(`security-gate lab ${lab}: ${passed}/${todo.length} security test files passed (manifest declares ${todo.length})`);
  const ok = failures.length === 0 && passed === todo.length && todo.length > 0;
  if (todo.length === 0) log(`[FAIL] lab ${lab} declares no tests — a gate step that runs nothing is not a gate`);
  log(ok ? `SECURITY-GATE LAB ${lab}: PASS` : `SECURITY-GATE LAB ${lab}: FAIL`);
  return ok;
}

function stats(root) {
  const { entries } = loadManifest(root);
  const by = {};
  for (const [, e] of entries) {
    const k = e.class === "SECURITY_REQUIRED" ? `${e.class}/${e.lab}` : e.class;
    by[k] = (by[k] ?? 0) + 1;
  }
  console.log(JSON.stringify(by, null, 2));
}

function selfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stc-"));
  const git = (...a) => execFileSync("git", a, { cwd: tmp, stdio: "ignore" });
  const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(tmp, p)), { recursive: true }); fs.writeFileSync(path.join(tmp, p), s); };
  git("init", "-q");
  const gate = "on:\n  pull_request:\n    branches: [main]\njobs:\n  gate:\n    steps:\n      - run: node scripts/ci/security-test-coverage.mjs --run --lab pure\n";
  const base = () => {
    fs.rmSync(path.join(tmp, "lib"), { recursive: true, force: true });
    fs.rmSync(path.join(tmp, MANIFEST_DIR), { recursive: true, force: true });
    fs.rmSync(path.join(tmp, ".github"), { recursive: true, force: true });
    w("lib/tenant-isolation.test.ts", "console.log('ok');\n");
    w("lib/format.test.ts", "console.log('ok');\n");
    w(GATE, gate);
    w(`${MANIFEST_DIR}/a.json`, JSON.stringify({ tests: {
      "lib/tenant-isolation.test.ts": { class: "SECURITY_REQUIRED", lab: "pure", reason: "tenant isolation proof" },
      "lib/format.test.ts": { class: "PRODUCT_REQUIRED", reason: "formatting helpers" },
    } }));
  };
  const addAll = () => { git("add", "-A"); };
  const cases = [];
  const run = (name, mutate, want) => {
    base(); mutate(); addAll();
    const out = []; const ok = check(tmp, { log: (l) => out.push(l) });
    const good = want === true ? ok : !ok && out.some((l) => l.includes(want));
    cases.push(good);
    console.log(`${good ? "PASS" : "FAIL"}  self-test: ${name}${good ? "" : "\n" + out.join("\n")}`);
  };
  run("classified tree passes", () => {}, true);
  run("new unclassified test fails", () => w("lib/new.test.ts", "x"), "UNCLASSIFIED lib/new.test.ts");
  run("security-looking test classified as product without reason fails", () => w(`${MANIFEST_DIR}/b.json`, JSON.stringify({ tests: { "lib/webhook-sig.test.ts": { class: "PRODUCT_REQUIRED", reason: "some reason here" } } })) || w("lib/webhook-sig.test.ts", "x"), "C3 lib/webhook-sig.test.ts");
  run("SECURITY_REQUIRED not run by the gate fails", () => w(GATE, gate.replace("--lab pure", "--lab test-db")), "NOT-INVOKED lib/tenant-isolation.test.ts");
  run("gate without pull_request trigger fails", () => w(GATE, gate.replace("pull_request", "workflow_dispatch")), "NOT-INVOKED");
  run("workflow-lab entry whose workflow does not name the file fails", () => {
    w(`${MANIFEST_DIR}/a.json`, JSON.stringify({ tests: { "lib/tenant-isolation.test.ts": { class: "SECURITY_REQUIRED", lab: "workflow", workflow: "x.yml", reason: "run by x" }, "lib/format.test.ts": { class: "PRODUCT_REQUIRED", reason: "formatting helpers" } } }));
    w(".github/workflows/x.yml", "on:\n  pull_request:\njobs:\n  a:\n    steps:\n      - run: echo nothing\n      # lib/tenant-isolation.test.ts only in a comment\n");
  }, "NOT-INVOKED lib/tenant-isolation.test.ts");
  run("test run by a sec-*-ci.yml is implicitly accepted", () => { w("lib/sec-b.test.ts", "x"); w(".github/workflows/sec-b-ci.yml", "on:\n  pull_request:\njobs:\n  a:\n    steps:\n      - run: npx tsx lib/sec-b.test.ts\n"); }, true);
  run("duplicate classification across fragments fails", () => w(`${MANIFEST_DIR}/b.json`, JSON.stringify({ tests: { "lib/format.test.ts": { class: "PRODUCT_REQUIRED", reason: "formatting helpers" } } })), "classified twice");
  run("stale entry fails", () => w(`${MANIFEST_DIR}/b.json`, JSON.stringify({ tests: { "lib/gone.test.ts": { class: "OBSOLETE", reason: "deleted long ago" } } })), "STALE lib/gone.test.ts");
  // RUN mode: vacuous green and a failing test are both refused.
  base(); addAll();
  const vac = path.join(tmp, "lib/tenant-isolation.test.ts");
  fs.writeFileSync(vac, "// nothing asserted\n");
  const tsx = process.env.TSX_CLI;
  if (tsx) {
    const o1 = []; const r1 = runLab(tmp, "pure", { tsx, log: (l) => o1.push(l) });
    const g1 = !r1 && o1.some((l) => l.includes("vacuous green"));
    console.log(`${g1 ? "PASS" : "FAIL"}  self-test: run refuses a vacuous green`); cases.push(g1);
    fs.writeFileSync(vac, "console.log('FAIL  tenant leak'); process.exit(1);\n");
    const o2 = []; const r2 = runLab(tmp, "pure", { tsx, log: (l) => o2.push(l) });
    const g2 = !r2 && o2.some((l) => l.includes("exit 1"));
    console.log(`${g2 ? "PASS" : "FAIL"}  self-test: run refuses a failing test`); cases.push(g2);
    fs.writeFileSync(vac, "console.log('ok - isolation held');\n");
    const r3 = runLab(tmp, "pure", { tsx, log: () => {} });
    console.log(`${r3 ? "PASS" : "FAIL"}  self-test: run accepts a real pass`); cases.push(r3);
  } else console.log("note: TSX_CLI not set — run-mode self-tests skipped (the gate sets it)");
  fs.rmSync(tmp, { recursive: true, force: true });
  const ok = cases.every(Boolean);
  console.log(ok ? `security-test-coverage self-test: ${cases.length} checks passed` : "security-test-coverage self-test FAILED");
  return ok;
}

const argv = process.argv.slice(2);
const root = ".";
if (argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
else if (argv.includes("--stats")) stats(root);
else if (argv.includes("--run")) {
  const lab = argv[argv.indexOf("--lab") + 1];
  if (!LABS.includes(lab) || lab === "workflow") { console.error(`--lab must be one of pure|test-db|rls-db|owner-lab`); process.exit(2); }
  process.exit(runLab(root, lab) ? 0 : 1);
} else process.exit(check(root) ? 0 : 1);
