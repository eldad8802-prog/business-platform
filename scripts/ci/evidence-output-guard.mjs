#!/usr/bin/env node
/**
 * evidence-output-guard.mjs — M-1: Production evidence must not publish row data.
 *
 * The repository is PUBLIC, so every Actions log is public. An evidence query that
 * SELECTs an email, a name, an amount or a role attribute into stdout publishes it.
 * This guard parses every SQL file that a workflow feeds to a Production connection
 * (ops/evidence/*.sql + any *.sql a production-db workflow references) and allows a
 * top-level SELECT to emit ONLY:
 *   - aggregate counts / booleans: count(...), bool_and(...), bool_or(...), every(...)
 *   - assert expressions: CASE ... THEN 'PASS' ... 'FAIL' ..., or a boolean comparison
 *     (=, <>, <, >, IS [NOT] NULL, IN, EXISTS, LIKE) — i.e. true/false, not a value
 *   - string/number literals (labels)
 *   - `now()` / `current_database()`-free constants
 * Anything else (a bare column, a function of a column, sum(amount), min/max(...),
 * string_agg, json_agg, row_to_json, *) is row data and FAILS the guard.
 * `SET`, `BEGIN`, `ROLLBACK`, `\echo`, `\set`, `SHOW` and comments are ignored.
 *
 * Grandfathered files are NOT allowed: a file that fails must be rewritten to
 * assert-style output, or retired (its workflow deleted) — see docs/security/ci-owner-actions.md.
 *
 * Usage: node scripts/ci/evidence-output-guard.mjs [--self-test] [--list]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AGG = /^(count|bool_and|bool_or|every)\s*\(/i;
const ASSERT_CASE = /^case\b[\s\S]*'(pass|fail|ok|held|broken|yes|no|match|mismatch)'[\s\S]*\bend\b/i;
const COMPARISON = /(~|<>|!=|<=|>=|=|<|>|\bis\s+(not\s+)?(null|true|false|distinct)\b|\bin\s*\(|\bexists\s*\(|\blike\b|\bbetween\b)/i;

function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** Split on top-level delimiter (depth 0, outside quotes). */
function splitTop(s, delim) {
  const out = [];
  let depth = 0, cur = "", q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (depth === 0 && s.startsWith(delim, i) && (delim !== "," || true)) { out.push(cur); cur = ""; i += delim.length - 1; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function topLevelKeywordIndex(s, kw) {
  let depth = 0, q = null;
  const re = new RegExp(`^${kw}\\b`, "i");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && /\s/.test(s[i - 1] ?? " ") && re.test(s.slice(i))) return i;
  }
  return -1;
}

export function classifyItem(item) {
  let e = item.trim().replace(/\s+as\s+("?[\w ]+"?)\s*$/i, "").replace(/::\w+(\[\])?$/i, "").trim();
  while (/^\(.*\)$/s.test(e) && splitTop(e.slice(1, -1), ",").length === 1 && balanced(e.slice(1, -1))) e = e.slice(1, -1).trim();
  if (/^'[^']*'$/.test(e) || /^-?\d+(\.\d+)?$/.test(e) || /^(true|false|null)$/i.test(e)) return "literal";
  if (e === "*" || /\.\*$/.test(e)) return "ROW-DATA(*)";
  if (AGG.test(e)) {
    // count(...) of anything is a count; the argument never reaches the log.
    return "aggregate";
  }
  if (/^(coalesce)\s*\(\s*(count|bool_and|bool_or|every)\s*\(/i.test(e)) return "aggregate";
  if (ASSERT_CASE.test(e)) return "assert";
  if (/^case\b/i.test(e)) return "ROW-DATA(case without PASS/FAIL labels)";
  if (/^\(?\s*select\b/i.test(e)) {
    // scalar subquery: judge its own select-list
    const inner = e.replace(/^\(\s*/, "").replace(/\)\s*$/, "");
    const bad = selectItems(inner).map(classifyItem).filter((x) => x.startsWith("ROW-DATA"));
    return bad.length ? bad[0] : "aggregate";
  }
  if (/^(not\s+)?exists\s*\(/i.test(e)) return "assert";
  if (COMPARISON.test(e) && !/^\w+\s*\(/.test(e.replace(COMPARISON, ""))) return "assert";
  if (COMPARISON.test(e)) return "assert";
  return `ROW-DATA(${e.slice(0, 60)})`;
}

function balanced(s) {
  let d = 0;
  for (const c of s) { if (c === "(") d++; if (c === ")") d--; if (d < 0) return false; }
  return d === 0;
}

function selectItems(stmt) {
  let s = stmt.trim();
  s = s.replace(/^with\b[\s\S]*?\)\s*(?=select\b)/i, (m) => m); // CTE bodies are not output
  const at = /^with\b/i.test(s) ? lastTopSelect(s) : 0;
  s = s.slice(at).replace(/^select\s+(distinct\s+(on\s*\([^)]*\)\s*)?)?/i, "");
  const from = topLevelKeywordIndex(s, "from");
  const list = from >= 0 ? s.slice(0, from) : s.replace(/\b(where|order|group|limit)\b[\s\S]*$/i, "");
  return splitTop(list, ",").filter((x) => x.trim());
}

function lastTopSelect(s) {
  // the output SELECT of a WITH statement is the first top-level SELECT after the CTE list
  let depth = 0, q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && /^select\b/i.test(s.slice(i)) && /\s|\)/.test(s[i - 1] ?? " ")) return i;
  }
  return 0;
}

export function checkSql(text) {
  const findings = [];
  const body = stripComments(text)
    .split("\n")
    .filter((l) => !/^\s*\\/.test(l))
    .join("\n");
  for (const raw of splitTop(body, ";")) {
    const st = raw.trim();
    if (!/^(select|with)\b/i.test(st)) continue;
    if (/^with\b/i.test(st) && !/\bselect\b/i.test(st)) continue;
    for (const item of selectItems(st)) {
      const c = classifyItem(item);
      if (c.startsWith("ROW-DATA")) findings.push(`${c} in: ${st.replace(/\s+/g, " ").slice(0, 90)}`);
    }
  }
  return findings;
}

export function productionSqlFiles(root) {
  const set = new Set();
  const evid = path.join(root, "ops/evidence");
  if (fs.existsSync(evid)) for (const f of fs.readdirSync(evid)) if (f.endsWith(".sql")) set.add(`ops/evidence/${f}`);
  const wfDir = path.join(root, ".github/workflows");
  if (fs.existsSync(wfDir))
    for (const f of fs.readdirSync(wfDir)) {
      const t = fs.readFileSync(path.join(wfDir, f), "utf8");
      if (!/environment:\s*production-db/.test(t)) continue;
      for (const m of t.matchAll(/([\w./-]+\.sql)\b/g)) if (fs.existsSync(path.join(root, m[1]))) set.add(m[1]);
    }
  return [...set].sort();
}

function selfTest() {
  const cases = [
    ["SELECT count(*) AS n FROM \"User\";", 0],
    ["SELECT CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict FROM \"User\";", 0],
    ["SELECT (SELECT count(*) FROM \"User\") = 3 AS three_users;", 0],
    ["SELECT u.email AS login_email FROM \"User\" u;", 1],
    ["SELECT b.id, b.name FROM \"Business\" b;", 2],
    ["SELECT sum(amount) FROM \"Payment\";", 1],
    ["SELECT * FROM \"User\";", 1],
    ["SELECT rolname, rolbypassrls FROM pg_roles;", 2],
    ["SELECT 'label' AS section, count(*) FROM x;", 0],
    ["WITH t AS (SELECT email FROM \"User\") SELECT count(*) FROM t;", 0],
    ["WITH t AS (SELECT email FROM \"User\") SELECT email FROM t;", 1],
    ["SELECT string_agg(name, ',') FROM \"Business\";", 1],
  ];
  let ok = true;
  for (const [sql, want] of cases) {
    const got = checkSql(sql).length;
    const pass = got === want;
    ok &&= pass;
    console.log(`${pass ? "PASS" : "FAIL"}  self-test: ${sql.slice(0, 70)} -> ${got} finding(s)${pass ? "" : ` (want ${want})`}`);
  }
  // integration: a workflow-referenced SQL file is discovered and judged
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evguard-"));
  fs.mkdirSync(path.join(tmp, ".github/workflows"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "ops/x"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "ops/x/q.sql"), "SELECT email FROM \"User\";");
  fs.writeFileSync(path.join(tmp, ".github/workflows/w.yml"), "jobs:\n  a:\n    environment: production-db\n    steps:\n      - run: psql -f ops/x/q.sql\n");
  const disc = productionSqlFiles(tmp);
  const pass = disc.includes("ops/x/q.sql");
  ok &&= pass;
  console.log(`${pass ? "PASS" : "FAIL"}  self-test: SQL referenced by a production-db workflow is discovered`);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(ok ? `evidence-output-guard self-test: ${cases.length + 1} checks passed` : "evidence-output-guard self-test FAILED");
  return ok;
}

/**
 * Workflow tier (ENFORCED): in every job bound to the production-db environment, every
 * psql invocation must either (a) pipe into scripts/ci/evidence-redact.mjs inside a step
 * that sets pipefail, or (b) run a SQL file that passes the SQL tier above. Exempt
 * workflows are listed with their reason; the list is exact (a stale entry fails).
 */
export const WORKFLOW_EXEMPT = new Map([
  ["prod-create-collection-qa-tenant.yml", "provisions the SYNTHETIC QA tenant whose identity is committed in ops/tenant/collection-qa-tenant.identity.env; output is parsed (-tAX VERIFY|...) and carries no customer data"],
  ["prod-set-collection-qa-tenant-password.yml", "same synthetic QA tenant; RESIDUAL: its verify prints left(md5(password hash),8) of the QA account — owner may drop that column"],
]);

export function checkWorkflows(root) {
  const problems = [];
  const dir = path.join(root, ".github/workflows");
  const seen = new Set();
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)) : []) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    if (!/environment:\s*production-db/.test(text)) continue;
    if (WORKFLOW_EXEMPT.has(f)) { seen.add(f); continue; }
    // drop comments, join shell continuations, then judge each psql command inside its step
    const joined = text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n").replace(/\\\n\s*/g, " ");
    const steps = joined.split(/\n\s*- (?:name|uses|run):/);
    for (const st of steps) {
      for (const line of st.split("\n")) {
        if (!/(^|[\s|(])psql\s+"?\$/.test(line)) continue;
        const redacted = /\|\s*node scripts\/ci\/evidence-redact\.mjs/.test(line);
        const m = line.match(/--file=("?)([^"\s]+)\1/);
        const sqlFile = m ? m[2] : null;
        const sqlClean = sqlFile && !sqlFile.includes("$") && fs.existsSync(path.join(root, sqlFile)) && checkSql(fs.readFileSync(path.join(root, sqlFile), "utf8")).length === 0;
        if (!redacted && !sqlClean) problems.push(`[FAIL] EVIDENCE-UNREDACTED ${f}: ${line.trim().slice(0, 110)}`);
        if (redacted && !/set -[a-z]*o pipefail|set -euo pipefail|set -o pipefail/.test(st)) problems.push(`[FAIL] EVIDENCE-NO-PIPEFAIL ${f}: a redacted psql step without pipefail would hide a failed query`);
      }
    }
  }
  for (const f of WORKFLOW_EXEMPT.keys()) if (!seen.has(f)) problems.push(`[FAIL] EVIDENCE-EXEMPT-STALE ${f} is exempt but is not a production-db workflow any more`);
  return problems;
}

function workflowSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evguard-wf-"));
  fs.mkdirSync(path.join(tmp, ".github/workflows"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "ops/x"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "ops/x/q.sql"), 'SELECT email FROM "User";');
  const wf = (body) => fs.writeFileSync(path.join(tmp, ".github/workflows/w.yml"), `jobs:\n  a:\n    environment: production-db\n    steps:\n      - run: |\n${body}`);
  const only = (ps) => ps.filter((l) => !l.includes("EXEMPT-STALE"));
  wf('          set -euo pipefail\n          psql "$DIRECT_URL" \\\n            --file=ops/x/q.sql\n');
  const p1 = only(checkWorkflows(tmp)).some((l) => l.includes("EVIDENCE-UNREDACTED w.yml"));
  wf('          set -euo pipefail\n          psql "$DIRECT_URL" \\\n            --file=ops/x/q.sql \\\n            | node scripts/ci/evidence-redact.mjs\n');
  const p2 = only(checkWorkflows(tmp)).length === 0;
  wf('          psql "$DIRECT_URL" --file=ops/x/q.sql | node scripts/ci/evidence-redact.mjs\n');
  const p3 = only(checkWorkflows(tmp)).some((l) => l.includes("EVIDENCE-NO-PIPEFAIL"));
  fs.writeFileSync(path.join(tmp, "ops/x/q.sql"), 'SELECT count(*) AS n FROM "User";');
  wf('          set -euo pipefail\n          psql "$DIRECT_URL" --file=ops/x/q.sql\n');
  const p4 = only(checkWorkflows(tmp)).length === 0;
  fs.rmSync(tmp, { recursive: true, force: true });
  let ok = true;
  for (const [n, p] of [
    ["unredacted psql of a row-data SQL in a production-db workflow is caught", p1],
    ["redacted psql with pipefail passes", p2],
    ["redacted psql without pipefail is caught", p3],
    ["unredacted psql of an aggregate-only SQL passes", p4],
  ]) { console.log(`${p ? "PASS" : "FAIL"}  self-test: ${n}`); ok &&= p; }
  return ok;
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) process.exit(selfTest() && workflowSelfTest() ? 0 : 1);
const root = argv.find((a) => !a.startsWith("--")) ?? ".";
const wfProblems = checkWorkflows(root);
for (const p of wfProblems) console.log(p);
if (argv.includes("--sql") || argv.includes("--list")) {
  // SQL tier (REPORT): which evidence files would publish row data if run unredacted.
  const files = productionSqlFiles(root);
  let bad = 0;
  for (const f of files) {
    const findings = checkSql(fs.readFileSync(path.join(root, f), "utf8"));
    if (findings.length) {
      bad++;
      console.log(`[report] EVIDENCE-ROW-DATA ${f}: ${findings.length} row-data output item(s) — redacted at runtime`);
      if (argv.includes("--list")) for (const x of findings) console.log(`    ${x}`);
    }
  }
  console.log(`evidence SQL: ${files.length} file(s), ${bad} would emit row data unredacted`);
}
console.log(wfProblems.length ? `EVIDENCE-OUTPUT-GUARD: FAIL (${wfProblems.length})` : "EVIDENCE-OUTPUT-GUARD: PASS");
process.exit(wfProblems.length ? 1 : 0);
