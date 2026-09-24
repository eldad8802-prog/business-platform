#!/usr/bin/env node
/**
 * proof-step-audit.mjs — inventory of workflow negative proofs (M-16 F-1).
 *
 * A workflow negative proof is REASONED when it asserts WHY the mutated run went red
 * (a specific label / SQLSTATE / HTTP status), and UNREASONED when it accepts any
 * non-zero exit (`if cmd >/dev/null 2>&1; then FAIL; fi`, `cmd || true` + grep "FAIL").
 *
 *   --list [--json]          count reasoned / unreasoned proof steps per workflow
 *   --harvest WF --out FILE  for every single-file perl/literal mutation step in WF that is
 *                            unreasoned: apply the mutation, run the command, capture the
 *                            output, restore (sha256-verified). Used to derive the intended
 *                            failure label from the REAL runner rather than guessing it.
 *
 * Steps that touch peer-owned paths are reported but never harvested or rewritten.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PEER = /lib\/services\/payments|app\/api\/payments|components\/collection|components\/payments|payment-settlement|cardcom|sumit|paypal|tranzila/i;
const UNREASONED = /(>\s*\/dev\/null 2>&1;?\s*then)|(\|\|\s*true\s*\n[\s\S]*grep -q "?FAIL)/;
const IS_PROOF = /negative[- ]proof|NEGATIVE-PROOF|MUTATION NOT APPLIED/i;

export function steps(text) {
  const lines = text.split("\n");
  const out = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)- (name|uses|run):/);
    if (m && (!cur || m[1].length <= cur.indent)) {
      if (cur) { cur.end = i; out.push(cur); }
      cur = { indent: m[1].length, start: i, name: (lines[i].match(/- name:\s*(.*)$/) || [])[1] || lines[i].trim() };
      continue;
    }
    if (cur && /^\S/.test(lines[i])) { cur.end = i; out.push(cur); cur = null; }
    else if (cur && /^\s*[a-z0-9_-]+:\s*$/.test(lines[i]) && lines[i].match(/^(\s*)/)[1].length < cur.indent) { cur.end = i; out.push(cur); cur = null; }
  }
  if (cur) { cur.end = lines.length; out.push(cur); }
  for (const s of out) s.text = lines.slice(s.start, s.end).join("\n");
  return out;
}

export function inventory(root) {
  const dir = path.join(root, ".github/workflows");
  const rows = [];
  for (const f of fs.readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).sort()) {
    for (const s of steps(fs.readFileSync(path.join(dir, f), "utf8"))) {
      if (!IS_PROOF.test(s.name + s.text)) continue;
      const reasoned = /negative-proof\.mjs/.test(s.text) || (!UNREASONED.test(s.text) && /grep -q[F]?\s/.test(s.text));
      rows.push({ workflow: f, line: s.start + 1, name: s.name, reasoned, peer: PEER.test(s.text) });
    }
  }
  return rows;
}

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

export function harvest(root, wf, outFile) {
  const text = fs.readFileSync(path.join(root, ".github/workflows", wf), "utf8");
  const res = [];
  for (const s of steps(text)) {
    const t = s.text;
    if (!/>\s*\/dev\/null 2>&1/.test(t) || PEER.test(t)) continue;
    const F = (t.match(/^\s*F="?([^"\n]+)"?\s*$/m) || [])[1];
    const perls = [...t.matchAll(/perl -0pi -e '((?:[^']|'\\'')*)' "?\$F"?/g)].map((m) => m[1]);
    const ifs = [...t.matchAll(/if (npx tsx|npm run|node|bash)([^\n]*?)\s*>\s*\/dev\/null 2>&1; then/g)].map((m) => (m[1] + m[2]).trim());
    const rec = { line: s.start + 1, name: s.name, F, perl: perls[0], cmd: ifs[0] };
    if (!(F && perls.length === 1 && ifs.length === 1)) { rec.shape = "manual"; res.push(rec); continue; }
    rec.shape = "canonical";
    const orig = fs.readFileSync(path.join(root, F));
    const h = sha(orig);
    const pr = spawnSync("perl", ["-0pi", "-e", perls[0], F], { cwd: root, encoding: "utf8" });
    rec.changed = pr.status === 0 && sha(fs.readFileSync(path.join(root, F))) !== h;
    let r = { status: null, stdout: "", stderr: "" };
    if (rec.changed) r = spawnSync("bash", ["-c", ifs[0]], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28, timeout: 600000 });
    fs.writeFileSync(path.join(root, F), orig);
    if (sha(fs.readFileSync(path.join(root, F))) !== h) throw new Error(`restore failed ${F}`);
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    rec.rc = r.status;
    rec.failLines = out.split(/\r?\n/).filter((l) => /FAIL|✗|✘|not ok|AssertionError|\[FAIL\]/.test(l)).slice(0, 12);
    rec.crash = /ReferenceError|SyntaxError|is not defined|Cannot find module|Transform failed|Unexpected token|ECONNREFUSED|P1001|does not provide an export/.test(out);
    rec.tail = out.slice(-1500);
    console.log(`${rec.line} ${rec.changed ? "" : "NOT-APPLIED "}rc=${rec.rc} crash=${rec.crash} ${rec.name}`);
    res.push(rec);
  }
  fs.writeFileSync(outFile, JSON.stringify(res, null, 1));
}

const argv = process.argv.slice(2);
const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("scripts", "ci", "proof-step-audit.mjs"));
if (!isMain) { /* imported */ }
else if (argv[0] === "--harvest") harvest(".", argv[1], argv[argv.indexOf("--out") + 1]);
else {
  const rows = inventory(".");
  if (argv.includes("--json")) console.log(JSON.stringify(rows, null, 1));
  else {
    const by = {};
    for (const r of rows) {
      const k = r.workflow;
      by[k] ??= { reasoned: 0, unreasoned: 0, peerUnreasoned: 0 };
      if (r.reasoned) by[k].reasoned++;
      else if (r.peer || /^(c3-settlement-ci|collection-product-ci|payment-settlement-recovery)\.yml$/.test(r.workflow)) by[k].peerUnreasoned++;
      else by[k].unreasoned++;
    }
    let tot = { reasoned: 0, unreasoned: 0, peerUnreasoned: 0 };
    for (const [k, v] of Object.entries(by)) { console.log(`${k.padEnd(44)} reasoned=${v.reasoned} unreasoned=${v.unreasoned} peer-unreasoned=${v.peerUnreasoned}`); for (const x in tot) tot[x] += v[x]; }
    console.log(`TOTAL reasoned=${tot.reasoned} unreasoned=${tot.unreasoned} peer-unreasoned=${tot.peerUnreasoned}`);
  }
}
