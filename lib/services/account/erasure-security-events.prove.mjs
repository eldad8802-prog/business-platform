#!/usr/bin/env node
/**
 * sec/INT — negative proofs for the account-deletion security events.
 *   node lib/services/account/erasure-security-events.prove.mjs
 *
 * Per mutation: every anchor must occur EXACTLY once and change its file; the suite must
 * exit 1 printing the SPECIFIC "FAIL <label>" line (a crash signature fails the proof);
 * every file is restored and its sha256 verified identical; the suite is green after.
 *
 *   N1 drop the `completed` emission            -> FAIL E1 every stage emits its event in order
 *   N2 attribute the row to the quarantined tenant (businessId = subject) -> FAIL E3 ...
 *   N3 remove BOTH non-blocking belts (F's catch around the writer, and the wrapper's
 *      catch) -> FAIL E4 a writer that throws on EVERY event never blocks the erasure
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const TSX = process.env.TSX_CLI ? ["node", [process.env.TSX_CLI]] : ["npx", ["tsx"]];
const SUITE = "lib/services/account/erasure-security-events.test.ts";
const EV = "lib/services/account/erasure-security-events.ts";
const JOB = "lib/services/account/erasure-job.ts";
const SE = "lib/security/security-events.ts";
const CRASH = [/ReferenceError/, /SyntaxError/, /Cannot find module/, /Transform failed/, /is not defined/];
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const run = () => {
  const r = spawnSync(TSX[0], [...TSX[1], SUITE], { encoding: "utf8", shell: process.platform === "win32" });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
};

const PROOFS = [
  { id: "N1", label: "FAIL E1 every stage emits its event in order", edits: [
    [JOB, `    await emitErasureEvent("completed", { businessId, userId: actor }, { attempt });\n`, ``],
  ] },
  { id: "N2", label: "FAIL E3 rows carry ids and closed codes only", edits: [
    [EV, `      businessId: null,\n      userId: subject.userId ?? null,`, `      businessId: subject.businessId,\n      userId: subject.userId ?? null,`],
  ] },
  { id: "N3", label: "FAIL E4 a writer that throws on EVERY event never blocks the erasure", edits: [
    [SE, `  try {\n    await writer(row);\n  } catch (error) {`, `  await writer(row);\n  try {\n  } catch (error) {`],
    [EV, `  } catch {\n    // recordSecurityEvent never throws; this is the second belt. Telemetry never blocks.\n  }`, `  } finally {\n    // N3: belt removed\n  }`],
  ] },
];

let ok = true;
for (const p of PROOFS) {
  const originals = new Map();
  let verdict = "";
  try {
    for (const [file, anchor, repl] of p.edits) {
      if (!originals.has(file)) originals.set(file, { bytes: readFileSync(file), sha: sha(file) });
      const s = readFileSync(file, "utf8");
      const n = s.split(anchor).length - 1;
      if (n !== 1) throw new Error(`${p.id}: anchor occurs ${n}x in ${file}`);
      writeFileSync(file, s.replace(anchor, repl));
      if (sha(file) === originals.get(file).sha && originals.size === 1) throw new Error(`${p.id}: mutation did not change ${file}`);
    }
    const r = run();
    const crash = CRASH.filter((re) => re.test(r.out));
    const red = r.code !== 0 && r.out.includes(p.label) && crash.length === 0;
    verdict = red ? "RED as intended" : `NOT RED (exit ${r.code}; label ${r.out.includes(p.label) ? "present" : "absent"}; crash ${crash.length})`;
    if (!red) ok = false;
  } catch (e) {
    verdict = `SETUP FAILURE ${e.message}`;
    ok = false;
  } finally {
    for (const [file, o] of originals) {
      writeFileSync(file, o.bytes);
      if (sha(file) !== o.sha) { console.log(`   RESTORE FAILED ${file}`); ok = false; }
    }
  }
  console.log(`── ${p.id}  EXPECTED "${p.label}"  ACTUAL ${verdict}  RESTORE sha256 identical`);
}
const post = run();
const green = post.code === 0 && post.out.includes("4 passed, 0 failed");
console.log(`POST-RESTORE ${green ? "green" : "NOT GREEN"}`);
ok &&= green;
console.log(ok ? "ERASURE-EVENT NEGATIVE PROOFS: PASS" : "ERASURE-EVENT NEGATIVE PROOFS: FAIL");
process.exit(ok ? 0 : 1);
