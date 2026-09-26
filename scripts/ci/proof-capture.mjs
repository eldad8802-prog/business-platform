#!/usr/bin/env node
/**
 * proof-capture.mjs — TRANSITIONAL helper (sec/A F-1 phase 1).
 *
 *   node scripts/ci/proof-capture.mjs <id> -- <command...>
 *
 * Runs the command exactly as before and exits with ITS status, so wrapping an
 * `if CMD >/dev/null 2>&1; then` proof in it changes nothing about the verdict. What it
 * adds is evidence: it prints the lines that name WHY the mutated run went red (FAIL /
 * [FAIL] / ✗ / AssertionError) and whether the output carries a crash signature. Those
 * lines become the `--expect` labels of the reason-specific proof that replaces the step.
 */
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const id = argv[0];
const cmd = argv.slice(sep + 1);
const r = spawnSync(cmd.join(" "), { shell: true, encoding: "utf8", maxBuffer: 1 << 28 });
const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
const all = out.split(/\r?\n/);
// A bare assert() has no label; keep the diff lines that follow it, which name the value.
const ctx = all.flatMap((l, i) => (/AssertionError/.test(l) ? all.slice(i + 1, i + 7).map((x) => `  ctx: ${x}`) : []));
const lines = all.filter((l) => /FAIL|✗|✘|not ok|AssertionError|^\s*NEW\s+[A-Z0-9-]{3,}\s/.test(l)).slice(0, 14);
const crash = /ReferenceError|SyntaxError|is not defined|Cannot find module|Transform failed|Unexpected token|ECONNREFUSED|P1001|does not provide an export/.test(out);
console.log(`PROOF-CAPTURE ${id} rc=${r.status} crash=${crash}`);
for (const l of [...lines, ...ctx]) console.log(`PROOF-CAPTURE ${id} | ${l.slice(0, 300)}`);
process.exit(r.status ?? 1);
