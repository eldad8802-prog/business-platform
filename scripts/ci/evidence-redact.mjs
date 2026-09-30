#!/usr/bin/env node
/**
 * evidence-redact.mjs — M-1: stdin filter for psql output in PUBLIC Actions logs.
 *
 *   psql ... --file=q.sql | node scripts/ci/evidence-redact.mjs
 *
 * Passes through \echo headers, SET/BEGIN/ROLLBACK tags and the "(N rows)" footer.
 * Inside a result table it keeps the column NAMES and replaces every cell with
 * `<redacted>` UNLESS the cell is assert-shaped:
 *   - a boolean (t / f / true / false)
 *   - a verdict token (PASS, FAIL, OK, HELD, BROKEN, MATCH, MISMATCH, YES, NO, SKIP)
 *   - an integer in a column whose name says it is a count (n, count, *_count, num_*, rows, total_rows)
 *   - NULL / empty
 * Expanded output (\x) is handled the same way per "key | value" line.
 * Row data — emails, names, business names, amounts, role names, ids — never reaches the log.
 * The full, unredacted result is NOT written anywhere (artifacts on a public repo are public too).
 *
 * Exit status: 0 always for the filter itself; callers MUST use `set -o pipefail` so a failed psql
 * still fails the step (the workflow guard checks for it).
 *
 * --self-test runs the unit checks.
 */
const VERDICT = /^(pass|fail|ok|held|broken|match|mismatch|yes|no|skip|t|f|true|false|null)?$/i;
const COUNT_COL = /^(n|count|rows|total_rows|num_\w+|\w+_count|count_\w+|\w+_n)$/i;

export function redactCell(col, v) {
  const s = v.trim();
  if (VERDICT.test(s)) return s;
  if (/^-?\d+$/.test(s) && COUNT_COL.test(col.trim())) return s;
  return "<redacted>";
}

export function redact(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let header = null;
  let inTable = false;
  let inRecord = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const next = lines[i + 1] ?? "";
    if (/^-\[ RECORD \d+ \]/.test(l)) { inRecord = true; out.push(l); continue; }
    if (inRecord) {
      const m = l.match(/^([^|]+)\|(.*)$/);
      if (m) { out.push(`${m[1]}| ${redactCell(m[1], m[2])}`); continue; }
      if (!l.trim()) { inRecord = false; out.push(l); continue; }
      out.push("<redacted>");
      continue;
    }
    if (!inTable && /^-+(\+-+)*$/.test(next.trim()) && next.trim().length > 0 && l.trim()) {
      header = l.split("|").map((h) => h.trim());
      out.push(l);
      out.push(next);
      i++;
      inTable = true;
      continue;
    }
    if (inTable) {
      if (/^\(\d+ rows?\)$/.test(l.trim())) { out.push(l); inTable = false; header = null; continue; }
      if (!l.trim()) { out.push(l); inTable = false; header = null; continue; }
      const cells = l.split("|");
      out.push(cells.map((c, k) => ` ${redactCell(header?.[k] ?? "", c)} `).join("|"));
      continue;
    }
    out.push(l);
  }
  return out.join("\n");
}

function selfTest() {
  const sample = [
    "== Login accounts ==",
    " login_email      | user_name | has_logged_in | login_count | verdict",
    "------------------+-----------+---------------+-------------+---------",
    " owner@example.com | Owner Name | t            |          12 | PASS",
    "(1 row)",
    "",
    "-[ RECORD 1 ]---+------",
    "business_name | Acme Ltd",
    "n             | 3",
    "",
    "ROLLBACK",
  ].join("\n");
  const r = redact(sample);
  const checks = [
    ["email redacted", !r.includes("owner@example.com")],
    ["name redacted", !r.includes("Owner Name")],
    ["business name redacted (expanded)", !r.includes("Acme Ltd")],
    ["boolean kept", /\| t \|/.test(r)],
    ["count column kept", r.includes(" 12 ")],
    ["verdict kept", r.includes("PASS")],
    ["count kept in expanded", /n\s+\| 3/.test(r)],
    ["headers kept", r.includes("login_email") && r.includes("== Login accounts ==")],
    ["footer kept", r.includes("(1 row)")],
    ["amount in a non-count column redacted", redactCell("amount", "1250") === "<redacted>"],
  ];
  let ok = true;
  for (const [n, p] of checks) { console.log(`${p ? "PASS" : "FAIL"}  self-test: ${n}`); ok &&= p; }
  console.log(ok ? `evidence-redact self-test: ${checks.length} checks passed` : "evidence-redact self-test FAILED");
  return ok;
}

if (process.argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
else {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (buf += d));
  process.stdin.on("end", () => process.stdout.write(redact(buf) + "\n"));
}
