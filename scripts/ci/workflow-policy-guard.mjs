#!/usr/bin/env node
/**
 * workflow-policy-guard.mjs — enforce the delivery-pipeline invariants (H-3, I-3, L-21).
 *
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
 * Usage: node scripts/ci/workflow-policy-guard.mjs [ROOT] | --self-test
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
    ["payment-settlement-recovery.yml", "peer-owned (CardCom money session); pin in the peer PR"],
    ["m1-inbound-money-ci.yml", "peer-owned (CardCom money session, #524); pin in the peer's next PR"],
  ]),
  "WP-3": new Map([["payment-settlement-recovery.yml", "peer-owned: CRON_SECRET without an environment — peer must add `environment: cron` (owner action prepared)"]]),
  "WP-5": new Map([["payment-settlement-recovery.yml", "peer-owned: scheduled job holding CRON_SECRET — accepted schedule by design, secret must move to the cron environment"]]),
};

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
  const onBlock = (text.match(/^on:\s*([\s\S]*?)^(?=\S)/m) || [])[1] ?? "";
  const inline = (text.match(/^on:\s*(\[.*\]|\w+)\s*$/m) || [])[1] ?? "";
  const set = new Set();
  for (const t of ["push", "pull_request", "pull_request_target", "schedule", "workflow_dispatch", "workflow_run", "workflow_call"]) {
    if (new RegExp(`^ {2}${t}:`, "m").test(onBlock) || new RegExp(`\\b${t}\\b`).test(inline)) set.add(t);
  }
  return set;
}

export function checkWorkflowText(file, raw) {
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
  const problems = [];
  for (const f of files) for (const [rule, msg] of checkWorkflowText(f, fs.readFileSync(path.join(dir, f), "utf8"))) problems.push(`[FAIL] ${rule} ${f}: ${msg}`);
  for (const [rule, m] of Object.entries(EXEMPT)) for (const f of m.keys()) if (!files.includes(f)) problems.push(`[FAIL] EXEMPT-STALE ${rule} ${f} no longer exists — remove the exemption`);
  for (const [rule, m] of Object.entries(EXEMPT)) for (const [f, why] of m) if (files.includes(f)) log(`  residual ${rule} ${f}: ${why}`);
  for (const p of problems) log(p);
  log(`workflow-policy-guard: ${files.length} workflows`);
  log(problems.length ? `WORKFLOW-POLICY-GUARD: FAIL (${problems.length})` : "WORKFLOW-POLICY-GUARD: PASS");
  return problems.length === 0;
}

function selfTest() {
  const SHA = "11d5960a326750d5838078e36cf38b85af677262";
  const good = `on:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  a:\n    if: github.ref == 'refs/heads/main'\n    environment: neon-preview\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@${SHA} # v4\n      - env:\n          K: \${{ secrets.NEON_API_KEY }}\n        run: echo\n`;
  const derive = good.replace("environment: neon-preview", "environment: knowledge-derive").replace("secrets.NEON_API_KEY", "secrets.KNOWLEDGE_DERIVE_SECRET");
  const cases = [
    ["compliant secret-bearing workflow", good, null],
    ["missing permissions", good.replace("permissions:\n  contents: read\n", ""), "WP-1"],
    ["tag-pinned action", good.replace(`@${SHA}`, "@v4"), "WP-2"],
    ["secret outside a protected environment", good.replace("    environment: neon-preview\n", ""), "WP-3"],
    ["protected environment without main-only condition", good.replace("    if: github.ref == 'refs/heads/main'\n", ""), "WP-4"],
    ["secret-bearing workflow with a push trigger", good.replace("  workflow_dispatch:\n", "  workflow_dispatch:\n  push:\n    branches: [feat/x]\n"), "WP-5"],
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
  console.log(ok ? `workflow-policy-guard self-test: ${cases.length} checks passed` : "workflow-policy-guard self-test FAILED");
  return ok;
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
else process.exit(check(argv[0] ?? ".") ? 0 : 1);
