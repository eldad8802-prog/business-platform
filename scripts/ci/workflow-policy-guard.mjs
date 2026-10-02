#!/usr/bin/env node
/**
 * workflow-policy-guard.mjs — enforce the delivery-pipeline invariants (H-3, I-3, L-21).
 *
 *   WP-0  every workflow PARSES as YAML and has `on:` and `jobs:`. A workflow GitHub cannot parse
 *         never starts, creates no check run, and so cannot fail a PR: it is invisible, not red.
 *         (Two #525 workflows were silently dead this way.) Parsed with the lockfile-pinned js-yaml;
 *         a missing parser crashes the guard, i.e. fails closed.
 *   WP-1  every workflow declares top-level `permissions:` (no repository-default token scope).
 *   WP-2  every `uses:` is pinned to a full 40-hex commit SHA (local `./` actions excepted).
 *   WP-3  a production-capable secret is referenced only inside a job bound to a protected
 *         environment (production-db | neon-preview | cron | knowledge-derive).
 *   WP-4  a job bound to a protected environment runs only from main
 *         (`if:` contains github.ref == 'refs/heads/main') — release-migrate included (L-21).
 *   WP-5  a workflow that can reach a production-capable secret has no push / pull_request /
 *         pull_request_target / schedule trigger (dispatch only), and no workflow requests
 *         `contents: write` or runs `git push`.
 *   WP-6  a single-purpose machine credential is referenced only inside ITS environment:
 *         CRON_SECRET (payment/intake schedulers) only in `cron`, KNOWLEDGE_DERIVE_SECRET only in
 *         `knowledge-derive`. Every job bound to an environment can read ALL of its secrets, so a
 *         shared environment would silently hand one credential's authority to the other's jobs.
 *         (A bound secret with no environment at all is WP-3's finding, not reported twice.)
 *
 * EXEMPT lists are exact (a stale entry fails) and carry a reason. Peer-owned files are
 * exempted ONLY for the rules the peer must fix in its own PR; they are reported as residual.
 *
 * SANCTIONED is narrower than EXEMPT: a by-design violation, exact rule + file + message (see below).
 *
 * DEBT is narrower than EXEMPT: OPEN SECURITY DEBT, recorded per VIOLATION — exact rule, exact
 * file, exact message, exact count, and the exact (LF-normalised) sha256 of the file it was
 * observed in. A matching violation is reported loudly as debt instead of failing; ANY other
 * violation — in that file or the same violation in any other file — still fails, and an entry
 * whose violation is gone, whose count changed or whose file changed at all FAILS as stale, so
 * the debt cannot outlive the artifact it was granted for.
 *
 * Usage: node scripts/ci/workflow-policy-guard.mjs [ROOT] | --self-test
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const yaml = createRequire(import.meta.url)("js-yaml");

export const PROD_SECRETS = /secrets\.(NEON_API_KEY|CRON_SECRET|KNOWLEDGE_DERIVE_SECRET|DIRECT_URL|DATABASE_URL|W1_RUNTIME_URL|W1_RUNTIME_PW|W2G_ADMIN_PW|PW2_CTL_PW|PREVIEW_RUNTIME_PW|COLLECTION_QA_PASSWORD_HASH|PROD_[A-Z_]+|BILLING_AUTHORITY_[A-Z_]+)\b/g;
const PROTECTED_ENVS = new Set(["production-db", "neon-preview", "cron", "knowledge-derive"]);
/** WP-6: secret -> the ONE environment allowed to hold it. */
export const SECRET_ENV = new Map([
  ["CRON_SECRET", "cron"],
  ["KNOWLEDGE_DERIVE_SECRET", "knowledge-derive"],
]);

/** rule -> Map(file -> reason). */
export const EXEMPT = {
  "WP-2": new Map([
    ["c3-settlement-ci.yml", "peer-owned (CardCom money session); pin in the peer PR"],
    ["collection-product-ci.yml", "peer-owned (CardCom money session); pin in the peer PR"],
    ["m1-inbound-money-ci.yml", "peer-owned (CardCom money session, #524); pin in the peer's next PR"],
  ]),
};

/**
 * SANCTIONED — a deliberate, by-design violation, recorded per VIOLATION (exact rule + file +
 * message), never per rule: every other finding of the same rule in that file still fails, and an
 * entry whose violation is gone fails as stale. Not debt: nothing is expected to remove it.
 *
 * payment-settlement-recovery.yml must run on a schedule while holding CRON_SECRET — the 10-minute
 * recovery cadence is the product (Vercel Hobby crons are daily). Its authority is bounded instead:
 * the job is bound to `cron` (WP-3/WP-6) and main-only (WP-4). Only the SCHEDULE trigger is
 * sanctioned; a push / pull_request / pull_request_target / workflow_run trigger, `contents: write`
 * or `git push` in this file still fails WP-5.
 */
export const SANCTIONED = [
  {
    rule: "WP-5",
    file: "payment-settlement-recovery.yml",
    message: "holds a production-capable secret but has a schedule trigger",
    reason: "by design: 10-minute settlement recovery; CRON authority bound to the `cron` environment, main-only",
  },
];

/** Remove exactly-sanctioned violations from `found`; a sanctioned entry with no violation is stale. */
export function applySanctioned(found, sanctioned = SANCTIONED) {
  const rest = [];
  const recorded = [];
  const hit = new Set();
  for (const v of found) {
    const s = sanctioned.find((x) => x.rule === v.rule && x.file === v.file && x.message === v.msg);
    if (s) { hit.add(s); recorded.push(`sanctioned ${v.rule} ${v.file}: ${v.msg} — ${s.reason}`); }
    else rest.push(v);
  }
  const failures = sanctioned.filter((s) => !hit.has(s)).map((s) => `[FAIL] SANCTIONED-STALE ${s.rule} ${s.file}: "${s.message}" no longer occurs — remove the entry`);
  return { rest, failures, recorded };
}

/**
 * OPEN SECURITY DEBT — NOT compliant behaviour. Temporary, violation-exact (see the header).
 *
 * Two derive-authority Production proof harnesses (#575), each reviewed, each preserved
 * byte-for-byte rather than edited under its proof's feet:
 *
 *   #582 prod-derive-preenrollment-proof.yml — its Production proof SUCCEEDED (run 36662067636,
 *        2026-09-30T02:55Z). Its debt is DUE FOR REMOVAL.
 *   #584 prod-derive-enrollment-proof.yml    — its Production proof has NOT yet run.
 *
 * CLOSED SET. These are the LAST proof-preservation exceptions of this kind: DEBT_FILES is closed,
 * and a debt entry for any other file fails (DEBT-NOT-ALLOWED) — widening it is itself a reviewed
 * change to this guard.
 *
 * NEXT SECURITY CLEANUP (after #584's proof), BOTH workflows together: retire them, or harden them in
 * a separately reviewed change — every action pinned to a commit SHA; no job outside the right
 * environment reads either credential class (DB evidence in production-db, the derive call in
 * `knowledge-derive`, the CRON_SECRET refusal probe in `cron`, one job per environment) — then
 * delete all eight entries and prove zero debt. MUST happen BEFORE the repo-level CRON_SECRET or
 * KNOWLEDGE_DERIVE_SECRET is removed: once they live only in their environments, a production-db
 * job can no longer read them at all.
 */
const REMOVE_WHEN = "in the joint #582/#584 cleanup (retire, or reviewed hardening); BEFORE repo-level CRON_SECRET / KNOWLEDGE_DERIVE_SECRET is removed";
const DEBT_582 = {
  file: "prod-derive-preenrollment-proof.yml",
  sha256: "dd77fd887b264f162e3f48c034ddecd2396d1d68905db6e1a0248dc82ad71b9a",
  status: "DUE FOR REMOVAL",
  reason: "#582 reviewed Production proof harness — its proof SUCCEEDED (run 36662067636); preserved unchanged only until the joint cleanup",
  removeWhen: REMOVE_WHEN,
};
const DEBT_584 = {
  file: "prod-derive-enrollment-proof.yml",
  sha256: "5d114b8a72c464a12f96df5c6d974c9e5bd9a8d1e641e38691a260eb59414dcf",
  status: "proof-preservation",
  reason: "#584 reviewed Production proof harness, NOT yet executed — preserved unchanged until its proof has run",
  removeWhen: REMOVE_WHEN,
};
/** The closed set of files that may carry OPEN SECURITY DEBT. */
export const DEBT_FILES = new Set([DEBT_582.file, DEBT_584.file]);
const derivedProofViolations = (base) => [
  { ...base, rule: "WP-2", message: "unpinned action actions/checkout@v4", count: 1 },
  { ...base, rule: "WP-2", message: "unpinned action actions/setup-node@v4", count: 1 },
  { ...base, rule: "WP-6", message: "job proof references KNOWLEDGE_DERIVE_SECRET in environment production-db (bound to knowledge-derive)", count: 1 },
  { ...base, rule: "WP-6", message: "job proof references CRON_SECRET in environment production-db (bound to cron)", count: 1 },
];
export const DEBT = [...derivedProofViolations(DEBT_582), ...derivedProofViolations(DEBT_584)];

export const sha256Lf = (raw) => crypto.createHash("sha256").update(raw.replace(/\r\n/g, "\n")).digest("hex");

/**
 * Split violations into failures and recorded debt. `found`: [{ file, rule, msg }]; `hashes`:
 * Map(file -> sha256Lf). Returns { failures: string[], debt: string[] }.
 */
export function applyDebt(found, hashes, debt = DEBT) {
  const key = (file, rule, msg) => `${rule}\u0000${file}\u0000${msg}`;
  const seen = new Map();
  for (const v of found) seen.set(key(v.file, v.rule, v.msg), (seen.get(key(v.file, v.rule, v.msg)) ?? 0) + 1);
  const failures = [];
  const recorded = [];
  const granted = new Map();
  for (const d of debt) {
    const k = key(d.file, d.rule, d.message);
    const got = seen.get(k) ?? 0;
    const hash = hashes.get(d.file);
    if (!DEBT_FILES.has(d.file)) { failures.push(`[FAIL] DEBT-NOT-ALLOWED ${d.rule} ${d.file}: OPEN SECURITY DEBT is closed to the #582/#584 proof harnesses — fix the workflow instead`); continue; }
    if (granted.has(k)) { failures.push(`[FAIL] DEBT-DUPLICATE ${d.rule} ${d.file}: "${d.message}" recorded twice`); continue; }
    if (hash === undefined) { failures.push(`[FAIL] DEBT-STALE ${d.rule} ${d.file}: file no longer exists — remove the debt entry`); continue; }
    if (hash !== d.sha256) { failures.push(`[FAIL] DEBT-STALE ${d.rule} ${d.file}: file changed since the debt was recorded (sha256 ${hash.slice(0, 12)} ≠ ${d.sha256.slice(0, 12)}) — re-review and remove or re-record`); continue; }
    if (got !== d.count) { failures.push(`[FAIL] DEBT-STALE ${d.rule} ${d.file}: "${d.message}" found ${got}, debt records ${d.count} — remove/adjust the entry`); continue; }
    granted.set(k, d);
  }
  for (const v of found) {
    const d = granted.get(key(v.file, v.rule, v.msg));
    if (d) recorded.push(`OPEN SECURITY DEBT [${d.status}] ${v.rule} ${v.file}: ${v.msg} — ${d.reason}; remove ${d.removeWhen}`);
    else failures.push(`[FAIL] ${v.rule} ${v.file}: ${v.msg}`);
  }
  return { failures, debt: recorded };
}

function jobsOf(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return [];
  const jobs = [];
  let cur = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\S/.test(l)) break;
    const m = l.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (m) { if (cur) jobs.push(cur); cur = { id: m[1], lines: [] }; continue; }
    if (cur) cur.lines.push(l);
  }
  if (cur) jobs.push(cur);
  return jobs.map((j) => {
    const body = j.lines.join("\n");
    const env = (body.match(/^ {4}environment:\s*(?:\n\s+name:\s*)?([\w-]+)/m) || [])[1] ?? null;
    const iff = (body.match(/^ {4}if:\s*(.+)$/m) || [])[1] ?? "";
    return { id: j.id, body, env, iff };
  });
}

function triggers(text) {
  // `[ \t]*\n`, not `\s*`: \s* also swallowed the FIRST trigger's indentation, so `^ {2}<t>:` never
  // matched it and the first trigger under `on:` was invisible to WP-5.
  const onBlock = (text.match(/^on:[ \t]*\n([\s\S]*?)^(?=\S)/m) || [])[1] ?? "";
  const inline = (text.match(/^on:\s*(\[.*\]|\w+)\s*$/m) || [])[1] ?? "";
  const set = new Set();
  for (const t of ["push", "pull_request", "pull_request_target", "schedule", "workflow_dispatch", "workflow_run", "workflow_call"]) {
    if (new RegExp(`^ {2}${t}:`, "m").test(onBlock) || new RegExp(`\\b${t}\\b`).test(inline)) set.add(t);
  }
  return set;
}

export function checkWorkflowText(file, raw) {
  let doc;
  try {
    doc = yaml.load(raw);
  } catch (e) {
    return [["WP-0", `does not parse as YAML — GitHub will not run it (${String(e.reason ?? e.message).split("\n")[0]} at line ${(e.mark?.line ?? -1) + 1})`]];
  }
  if (!doc || typeof doc !== "object" || !doc.jobs || !("on" in doc)) return [["WP-0", "parses, but has no `on:` / `jobs:` — not a runnable workflow"]];
  const text = raw.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  const out = [];
  const ex = (rule) => EXEMPT[rule]?.has(file);
  if (!/^permissions:/m.test(text)) out.push(["WP-1", "no top-level permissions: block"]);
  if (!ex("WP-2"))
    for (const m of text.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
      const ref = m[1];
      if (ref.startsWith("./")) continue;
      if (!/@[0-9a-f]{40}$/.test(ref)) out.push(["WP-2", `unpinned action ${ref}`]);
    }
  const trig = triggers(text);
  let holdsProdSecret = false;
  for (const job of jobsOf(text)) {
    const secrets = [...new Set([...job.body.matchAll(PROD_SECRETS)].map((m) => m[1]))];
    if (secrets.length) holdsProdSecret = true;
    if (secrets.length && !PROTECTED_ENVS.has(job.env ?? "") && !ex("WP-3")) out.push(["WP-3", `job ${job.id} references ${secrets.join(", ")} outside a protected environment`]);
    // production-db already carries a main-only deployment-branch policy (verified via the API);
    // the repo-side condition is REQUIRED for the environments this change introduces, and for
    // release-migrate (L-21), where applying migrations from another ref must be impossible twice over.
    const mustBeMainOnly = (job.env !== null && job.env !== "production-db" && PROTECTED_ENVS.has(job.env)) || file === "release-migrate.yml";
    if (job.env !== null && !ex("WP-6"))
      for (const s of secrets) {
        const bound = SECRET_ENV.get(s);
        if (bound && job.env !== bound) out.push(["WP-6", `job ${job.id} references ${s} in environment ${job.env} (bound to ${bound})`]);
      }
    if (mustBeMainOnly && !/github\.ref\s*==\s*'refs\/heads\/main'/.test(job.iff)) out.push(["WP-4", `job ${job.id} (environment ${job.env}) is not restricted to refs/heads/main`]);
  }
  if (holdsProdSecret && !ex("WP-5")) for (const t of ["push", "pull_request", "pull_request_target", "schedule", "workflow_run"]) if (trig.has(t)) out.push(["WP-5", `holds a production-capable secret but has a ${t} trigger`]);
  if (/contents:\s*write/.test(text)) out.push(["WP-5", "requests contents: write"]);
  if (/\bgit push\b/.test(text)) out.push(["WP-5", "runs git push"]);
  return out;
}

export function check(root, { log = console.log } = {}) {
  const dir = path.join(root, ".github/workflows");
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  const found = [];
  const hashes = new Map();
  for (const f of files) {
    const raw = fs.readFileSync(path.join(dir, f), "utf8");
    hashes.set(f, sha256Lf(raw));
    for (const [rule, msg] of checkWorkflowText(f, raw)) found.push({ file: f, rule, msg });
  }
  const sanc = applySanctioned(found);
  const { failures, debt } = applyDebt(sanc.rest, hashes);
  const problems = [...sanc.failures, ...failures];
  for (const s of sanc.recorded) log(`  ${s}`);
  for (const [rule, m] of Object.entries(EXEMPT)) for (const f of m.keys()) if (!files.includes(f)) problems.push(`[FAIL] EXEMPT-STALE ${rule} ${f} no longer exists — remove the exemption`);
  for (const [rule, m] of Object.entries(EXEMPT)) for (const [f, why] of m) if (files.includes(f)) log(`  residual ${rule} ${f}: ${why}`);
  for (const d of debt) log(`  ${d}`);
  for (const p of problems) log(p);
  log(`workflow-policy-guard: ${files.length} workflows`);
  const byStatus = [...new Set(DEBT.map((d) => d.status))].map((s) => `${debt.filter((d) => d.includes(`[${s}]`)).length} ${s}`).join(", ");
  const debtNote = debt.length ? ` — ${debt.length} OPEN SECURITY DEBT item(s) (${byStatus}), see above` : "";
  log(problems.length ? `WORKFLOW-POLICY-GUARD: FAIL (${problems.length})${debtNote}` : `WORKFLOW-POLICY-GUARD: PASS${debtNote}`);
  return problems.length === 0;
}

function selfTest() {
  const SHA = "11d5960a326750d5838078e36cf38b85af677262";
  const good = `on:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  a:\n    if: github.ref == 'refs/heads/main'\n    environment: neon-preview\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@${SHA} # v4\n      - env:\n          K: \${{ secrets.NEON_API_KEY }}\n        run: echo\n`;
  const derive = good.replace("environment: neon-preview", "environment: knowledge-derive").replace("secrets.NEON_API_KEY", "secrets.KNOWLEDGE_DERIVE_SECRET");
  const cases = [
    ["compliant secret-bearing workflow", good, null],
    ["a run: | block ended early by a column-2 continuation line (the ci-1 defect)", good.replace("        run: echo\n", "        run: |\n          node x.mjs --replace 'a\n  b' \\\n            --expect c\n"), "WP-0"],
    ["a duplicated top-level key (the i8b6 defect: two copies concatenated)", good + good, "WP-0"],
    ["valid YAML that is not a workflow (no jobs)", "on:\n  workflow_dispatch:\npermissions:\n  contents: read\n", "WP-0"],
    ["missing permissions", good.replace("permissions:\n  contents: read\n", ""), "WP-1"],
    ["tag-pinned action", good.replace(`@${SHA}`, "@v4"), "WP-2"],
    ["secret outside a protected environment", good.replace("    environment: neon-preview\n", ""), "WP-3"],
    ["protected environment without main-only condition", good.replace("    if: github.ref == 'refs/heads/main'\n", ""), "WP-4"],
    ["secret-bearing workflow with a push trigger", good.replace("  workflow_dispatch:\n", "  workflow_dispatch:\n  push:\n    branches: [feat/x]\n"), "WP-5"],
    ["the FIRST trigger under on: is seen (push listed first)", good.replace("on:\n  workflow_dispatch:\n", "on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n"), "WP-5"],
    ["the FIRST trigger under on: is seen (schedule listed first)", good.replace("on:\n  workflow_dispatch:\n", "on:\n  schedule:\n    - cron: \"*/10 * * * *\"\n  workflow_dispatch:\n"), "WP-5"],
    ["contents: write", good.replace("contents: read", "contents: write"), "WP-5"],
    ["git push", good.replace("run: echo", "run: git push origin main"), "WP-5"],
    ["compliant derive workflow (knowledge-derive env, main-only)", derive, null],
    ["derive secret in the cron environment", derive.replace("environment: knowledge-derive", "environment: cron"), "WP-6"],
    ["cron secret in the knowledge-derive environment", derive.replace("KNOWLEDGE_DERIVE_SECRET", "CRON_SECRET"), "WP-6"],
    ["derive secret in production-db", derive.replace("environment: knowledge-derive", "environment: production-db"), "WP-6"],
    ["derive secret with no environment", derive.replace("    environment: knowledge-derive\n", ""), "WP-3"],
    ["knowledge-derive environment without main-only condition", derive.replace("    if: github.ref == 'refs/heads/main'\n", ""), "WP-4"],
  ];
  let ok = true;
  for (const [name, text, rule] of cases) {
    const got = checkWorkflowText("t.yml", text);
    const pass = rule ? got.some(([r]) => r === rule) : got.length === 0;
    ok &&= pass;
    console.log(`${pass ? "PASS" : "FAIL"}  self-test: ${name}${pass ? "" : ` -> ${JSON.stringify(got)}`}`);
  }

  // OPEN SECURITY DEBT is violation-exact: it never becomes a pass for anything else. Each case runs a
  // small "tree": both recorded harnesses (debtShape, at their recorded hashes) plus the file under test.
  const debtShape = `on:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  proof:\n    runs-on: ubuntu-latest\n    environment: production-db\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n      - env:\n          D: \${{ secrets.DIRECT_URL }}\n          K: \${{ secrets.KNOWLEDGE_DERIVE_SECRET }}\n          C: \${{ secrets.CRON_SECRET }}\n        run: echo\n`;
  const RECORDED = new Map([[DEBT_582.file, DEBT_582.sha256], [DEBT_584.file, DEBT_584.sha256]]);
  const run = (file, text, { hash, debt } = {}) => {
    const tree = new Map([...RECORDED.keys()].map((f) => [f, debtShape]));
    tree.set(file, text);
    const found = [];
    const hashes = new Map();
    for (const [f, t] of tree) {
      for (const [rule, msg] of checkWorkflowText(f, t)) found.push({ file: f, rule, msg });
      hashes.set(f, f === file && hash ? hash : RECORDED.get(f) ?? sha256Lf(t));
    }
    return applyDebt(found, hashes, debt);
  };
  const mentions = (r, s) => r.failures.some((f) => s.every((x) => f.includes(x)));
  const debtCases = [];
  for (const [pr, DF] of [["#582", DEBT_582.file], ["#584", DEBT_584.file]]) {
    debtCases.push(
      [`${pr}: its four items are reported as OPEN SECURITY DEBT, not passed silently`, () => { const r = run(DF, debtShape); return r.failures.length === 0 && r.debt.filter((d) => d.includes(` ${DF}:`)).length === 4 && r.debt.every((d) => d.startsWith("OPEN SECURITY DEBT [")); }],
      [`${pr}: a NEW unpinned action in its file still fails`, () => mentions(run(DF, debtShape.replace("      - env:", "      - uses: actions/cache@v4\n      - env:")), ["WP-2", DF, "actions/cache@v4"])],
      [`${pr}: a SECOND occurrence of a recorded action fails (count is exact)`, () => mentions(run(DF, debtShape.replace("      - env:", "      - uses: actions/checkout@v4\n      - env:")), ["DEBT-STALE", DF, "checkout"])],
      [`${pr}: the same secrets in a NEW production-db job fail`, () => mentions(run(DF, debtShape.replace("jobs:\n", "jobs:\n  extra:\n    runs-on: ubuntu-latest\n    environment: production-db\n    steps:\n      - env:\n          C: ${{ secrets.CRON_SECRET }}\n        run: echo\n")), ["WP-6", DF, "job extra"])],
      [`${pr}: a violation of a rule its debt does not cover fails (WP-5)`, () => mentions(run(DF, debtShape.replace("  workflow_dispatch:\n", "  workflow_dispatch:\n  push:\n")), ["WP-5", DF])],
      [`${pr}: a recorded violation that disappears fails as stale`, () => mentions(run(DF, debtShape.replace("actions/setup-node@v4", `actions/setup-node@${SHA}`)), ["DEBT-STALE", DF, "setup-node"])],
      [`${pr}: any change to its file fails all four items as stale`, () => run(DF, debtShape, { hash: "0".repeat(64) }).failures.filter((f) => f.includes("DEBT-STALE") && f.includes(DF)).length === 4],
    );
  }
  debtCases.push(
    ["another workflow with the SAME violations still fails (WP-2 and WP-6)", () => { const r = run("other-proof.yml", debtShape); return r.debt.every((d) => !d.includes("other-proof.yml")) && ["WP-2", "WP-6"].every((w) => mentions(r, [` ${w} other-proof.yml:`])); }],
    ["#582's debt does not cover #584's file (a mis-recorded entry is refused)", () => mentions(run(DEBT_584.file, debtShape, { debt: DEBT.map((d) => (d.file === DEBT_584.file ? { ...d, sha256: DEBT_582.sha256 } : d)) }), ["DEBT-STALE", DEBT_584.file])],
    ["CLOSED SET: a debt entry for any third file is refused", () => mentions(run("third-proof.yml", debtShape, { debt: [...DEBT, { ...DEBT[0], file: "third-proof.yml", sha256: sha256Lf(debtShape) }] }), ["DEBT-NOT-ALLOWED", "third-proof.yml"])],
    ["a duplicated debt entry is refused", () => mentions(run(DEBT_584.file, debtShape, { debt: [...DEBT, DEBT[DEBT.length - 1]] }), ["DEBT-DUPLICATE", DEBT_584.file])],
    ["statuses are exact: #582 DUE FOR REMOVAL, #584 proof-preservation", () => { const r = run(DEBT_584.file, debtShape); return r.debt.filter((d) => d.includes("[DUE FOR REMOVAL]") && d.includes(DEBT_582.file)).length === 4 && r.debt.filter((d) => d.includes("[proof-preservation]") && d.includes(DEBT_584.file)).length === 4 && r.debt.length === 8; }],
  );
  for (const [name, fn] of debtCases) {
    const pass = fn();
    ok &&= pass;
    console.log(`${pass ? "PASS" : "FAIL"}  self-test: debt — ${name}`);
  }

  // Settlement recovery: CRON authority only through `cron`, main-only; only its SCHEDULE is sanctioned.
  const SF = "payment-settlement-recovery.yml";
  const settle = `on:\n  schedule:\n    - cron: "*/10 * * * *"\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  recover:\n    if: github.ref == 'refs/heads/main'\n    environment: cron\n    runs-on: ubuntu-latest\n    steps:\n      - env:\n          CRON_SECRET: \${{ secrets.CRON_SECRET }}\n        run: echo\n`;
  const judge = (file, text) => {
    const s = applySanctioned(checkWorkflowText(file, text).map(([rule, msg]) => ({ file, rule, msg })));
    return { failures: [...s.failures, ...s.rest.map((v) => `[FAIL] ${v.rule} ${v.file}: ${v.msg}`)], recorded: s.recorded };
  };
  const has = (r, rule) => r.failures.some((f) => f.includes(` ${rule} `));
  const settleCases = [
    ["compliant: cron-bound, main-only, schedule reported as sanctioned (not silent)", () => { const r = judge(SF, settle); return r.failures.length === 0 && r.recorded.length === 1 && r.recorded[0].includes("schedule trigger"); }],
    ["regression to repo-level authority (no environment) fails WP-3", () => has(judge(SF, settle.replace("    environment: cron\n", "")), "WP-3")],
    ["an inappropriate environment (production-db) fails WP-6", () => has(judge(SF, settle.replace("environment: cron", "environment: production-db")), "WP-6")],
    ["an inappropriate environment (knowledge-derive) fails WP-6", () => has(judge(SF, settle.replace("environment: cron", "environment: knowledge-derive")), "WP-6")],
    ["dropping the main-only condition fails WP-4", () => has(judge(SF, settle.replace("    if: github.ref == 'refs/heads/main'\n", "")), "WP-4")],
    ["a push trigger is NOT covered by the sanction (fails WP-5)", () => has(judge(SF, settle.replace("  workflow_dispatch:\n", "  workflow_dispatch:\n  push:\n")), "WP-5")],
    ["contents: write is NOT covered by the sanction (fails WP-5)", () => has(judge(SF, settle.replace("contents: read", "contents: write")), "WP-5")],
    ["the same scheduled secret-holder in ANOTHER file is not sanctioned", () => has(judge("other-scheduler.yml", settle), "WP-5")],
    ["a sanction whose violation is gone fails as stale", () => judge(SF, settle.replace("  schedule:\n    - cron: \"*/10 * * * *\"\n", "")).failures.some((f) => f.includes("SANCTIONED-STALE"))],
  ];
  for (const [name, fn] of settleCases) {
    const pass = fn();
    ok &&= pass;
    console.log(`${pass ? "PASS" : "FAIL"}  self-test: settlement — ${name}`);
  }
  console.log(ok ? `workflow-policy-guard self-test: ${cases.length + debtCases.length + settleCases.length} checks passed` : "workflow-policy-guard self-test FAILED");
  return ok;
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
else process.exit(check(argv[0] ?? ".") ? 0 : 1);
