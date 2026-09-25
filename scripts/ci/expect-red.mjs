#!/usr/bin/env node
/**
 * expect-red.mjs — the verdict half of a negative proof (M-16 F-1).
 *
 *   if ! node scripts/ci/expect-red.mjs --id ID --expect 'LABEL' [--expect ...] -- CMD...; then
 *     <restore>; echo "NEGATIVE-PROOF FAIL"; exit 1
 *   fi
 *
 * Exit 0 ONLY when CMD exits non-zero AND its output contains every --expect label AND it
 * carries no crash signature (ReferenceError, missing module, connection refused, ...).
 * Exit 1 when CMD stayed green, went red for another reason, or crashed. The mutation and the
 * sha-verified restore stay in the calling step (they predate this helper); the label is the
 * one CI observed for this exact mutation (recorded in sec/A F-1 phase 1).
 */
import { spawnSync } from "node:child_process";
import { CRASH_SIGNATURES } from "./negative-proof.mjs";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 0) { console.log("expect-red: usage: --id ID --expect LABEL -- CMD"); process.exit(2); }
const opts = argv.slice(0, sep);
const cmd = argv.slice(sep + 1);
let id = "?";
const expect = [];
for (let i = 0; i < opts.length; i++) {
  if (opts[i] === "--id") id = opts[++i];
  else if (opts[i] === "--expect") expect.push(opts[++i]);
}
if (!expect.length) { console.log(`expect-red [${id}]: at least one --expect label is required`); process.exit(2); }
const r = spawnSync(cmd.join(" "), { shell: true, encoding: "utf8", maxBuffer: 1 << 28 });
const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
const rc = r.status ?? 128;
const missing = expect.filter((e) => !out.includes(e));
const crash = CRASH_SIGNATURES.filter((re) => re.test(out));
console.log(`── expect-red ${id}`);
console.log(`   EXPECTED RED   exit!=0 + ${expect.map((e) => JSON.stringify(e)).join(" + ")}`);
console.log(`   ACTUAL RED     exit=${rc}; labels ${missing.length ? "MISSING" : "present"}; crash signatures ${crash.length ? "PRESENT" : "absent"}`);
const problems = [];
if (rc === 0) problems.push("stayed GREEN under the mutation");
if (missing.length) problems.push(`red, but not for the reason under test — missing ${missing.map((m) => JSON.stringify(m)).join(", ")}`);
if (crash.length) problems.push(`red because of a CRASH: ${crash.map(String).join(", ")}`);
if (problems.length) {
  console.log(out.split(/\r?\n/).slice(-40).join("\n"));
  for (const p of problems) console.log(`EXPECT-RED FAIL [${id}]: ${p}`);
  process.exit(1);
}
console.log(`EXPECT-RED PASS [${id}] — red for the intended reason`);
process.exit(0);
