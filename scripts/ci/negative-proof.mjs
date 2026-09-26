#!/usr/bin/env node
/**
 * negative-proof.mjs — one honest mutation proof (M-16 / F-1).
 *
 * A negative proof is only evidence if ALL of these hold, so this driver enforces
 * every one and fails the step otherwise:
 *
 *   1. MUTATION APPLIED   the anchor/pattern occurs EXACTLY once (or --count N) and
 *                         the file's sha256 changes.
 *   2. EXPECTED RED       the command exits non-zero ...
 *   3. INTENDED REASON    ... AND its combined output contains EVERY --expect label
 *                         (fixed strings). "exit != 0" alone is never accepted.
 *   4. NOT A CRASH        the output carries none of the crash signatures below
 *                         (ReferenceError, SyntaxError, missing module, connection
 *                         refused, ...). A mutation that makes the file fail to load
 *                         proves nothing about the guard it claims to exercise.
 *   5. RESTORE            the original bytes are written back and the sha256 is
 *                         verified identical — even when the run throws.
 *   6. POST-RESTORE GREEN (optional --post-green) the same command exits 0 again.
 *
 * Usage (literal):
 *   node scripts/ci/negative-proof.mjs --id NAME --file F \
 *     --anchor 'exact text' --replace 'new text' \
 *     --expect 'FAIL  label' [--expect ...] [--post-green] -- cmd arg...
 * Usage (perl substitution, for the historical s/// proofs):
 *   node scripts/ci/negative-proof.mjs --id NAME --file F --perl 's/PAT/REP/' ... -- cmd
 *   The PAT is counted with `perl -0777` and must match exactly once.
 *
 * Self-test:  node scripts/ci/negative-proof.mjs --self-test
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CRASH_SIGNATURES = [
  /\bReferenceError\b/,
  /\bSyntaxError\b/,
  /\bis not defined\b/,
  /Cannot find module/,
  /ERR_MODULE_NOT_FOUND/,
  /Transform failed/,
  /Unexpected token/,
  /ECONNREFUSED/,
  /\bP1001\b/,
  /Can't reach database server/,
  /does not provide an export named/,
];

/** Crash signatures present in the output, ignoring PASSING assertion lines (a check may be
 *  NAMED after the error it guards against, e.g. "ok  a lost connection (P1001) is TRANSIENT"). */
export function crashSignatures(out) {
  const text = out
    .split(/\r?\n/)
    .filter((l) => !/^\s*(ok\b|OK:|PASS\b|\[PASS\]|✓|✔)/.test(l))
    .join("\n");
  return CRASH_SIGNATURES.filter((re) => re.test(text));
}

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function parseArgs(argv) {
  const o = { expect: [], count: 1, postGreen: false, cmd: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { o.cmd = argv.slice(i + 1); break; }
    const v = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === "--id") o.id = v();
    else if (a === "--file") o.file = v();
    else if (a === "--anchor") o.anchor = v();
    else if (a === "--replace") o.replace = v();
    else if (a === "--perl") o.perl = v();
    else if (a === "--expect") o.expect.push(v());
    else if (a === "--count") o.count = Number(v());
    else if (a === "--post-green") o.postGreen = true;
    else if (a === "--self-test") o.selfTest = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

/** Split `s<d>PAT<d>REP<d>flags` honouring backslash escapes. */
export function splitPerlSubst(expr) {
  if (!expr.startsWith("s") || expr.length < 4) throw new Error(`not a perl s/// expression: ${expr}`);
  const d = expr[1];
  const parts = [];
  let cur = "";
  for (let i = 2; i < expr.length; i++) {
    const c = expr[i];
    if (c === "\\" && i + 1 < expr.length) { cur += c + expr[++i]; continue; }
    if (c === d && parts.length < 2) { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (parts.length !== 2) throw new Error(`malformed perl s/// expression: ${expr}`);
  return { pattern: parts[0], replacement: parts[1], flags: cur, delim: d };
}

/** Run a perl program fed on STDIN (never argv: Windows argv quoting mangles `"`). */
function perlScript(program, args) {
  const r = spawnSync("perl", ["-", ...args], { encoding: "utf8", input: program });
  if (r.status === 0 && /Can't open/.test(r.stderr ?? "")) return { ...r, status: 2 };
  return r;
}

function perlCount(file, pattern, flags) {
  const mods = flags.replace(/[^imsx]/g, "");
  const r = perlScript(`local $/; my $t = <>; my $c = () = $t =~ /${pattern}/g${mods}; print $c;\n`, [file]);
  if (r.status !== 0) throw new Error(`perl count failed: ${r.stderr}`);
  return Number(r.stdout.trim());
}

/** Same semantics as `perl -0pi -e EXPR FILE` (record separator \0 = whole file). */
function perlApply(file, expr) {
  return perlScript(`$/ = "\\0"; $^I = ""; while (<>) { ${expr}; print; }\n`, [file]);
}

function run(cmd) {
  // Windows needs a shell to resolve npx/npm (.cmd shims); quote every argument then.
  const win = process.platform === "win32";
  const q = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  const r = spawnSync(win ? cmd.map(q).join(" ") : cmd[0], win ? [] : cmd.slice(1), {
    encoding: "utf8",
    shell: win,
    maxBuffer: 256 * 1024 * 1024,
    env: process.env,
  });
  return { rc: r.status === null ? 128 : r.status, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}${r.error ? `\n${r.error}` : ""}` };
}

function tail(s, n = 60) {
  return s.split(/\r?\n/).slice(-n).join("\n");
}

export function negativeProof(o, { log = console.log } = {}) {
  if (!o.id || !o.file || !o.cmd?.length) throw new Error("--id, --file and -- <command> are required");
  if (!o.expect.length) throw new Error(`${o.id}: at least one --expect label is required (exit != 0 alone is not evidence)`);
  if ((o.anchor === undefined) === (o.perl === undefined)) throw new Error(`${o.id}: give exactly one of --anchor/--replace or --perl`);
  const original = fs.readFileSync(o.file);
  const before = sha(original);
  const rec = { id: o.id, file: o.file };

  // 1. MUTATION
  if (o.anchor !== undefined) {
    if (o.replace === undefined) throw new Error(`${o.id}: --anchor needs --replace`);
    const text = original.toString("utf8");
    const n = text.split(o.anchor).length - 1;
    if (n !== o.count) throw new Error(`${o.id}: MUTATION NOT APPLIED — anchor occurs ${n} times, expected ${o.count}`);
    fs.writeFileSync(o.file, text.split(o.anchor).join(o.replace));
    rec.mutation = `literal ${JSON.stringify(o.anchor.slice(0, 100))} -> ${JSON.stringify(o.replace.slice(0, 100))}`;
  } else {
    const { pattern, flags } = splitPerlSubst(o.perl);
    const n = perlCount(o.file, pattern, flags);
    if (n !== o.count) throw new Error(`${o.id}: MUTATION NOT APPLIED — pattern matches ${n} times, expected ${o.count}`);
    const r = perlApply(o.file, o.perl);
    if (r.status !== 0) { fs.writeFileSync(o.file, original); throw new Error(`${o.id}: perl failed: ${r.stderr}`); }
    rec.mutation = `perl ${o.perl.slice(0, 160)}`;
  }
  let result;
  try {
    const mutated = sha(fs.readFileSync(o.file));
    if (mutated === before) throw new Error(`${o.id}: MUTATION NOT APPLIED — file bytes unchanged`);
    // 2-4. RUN
    result = run(o.cmd);
  } finally {
    // 5. RESTORE (always)
    fs.writeFileSync(o.file, original);
  }
  const after = sha(fs.readFileSync(o.file));
  if (after !== before) throw new Error(`${o.id}: RESTORE NOT BYTE-IDENTICAL (${before} != ${after})`);
  rec.restore = `sha256 ${before.slice(0, 16)} identical`;

  const problems = [];
  if (result.rc === 0) problems.push("stayed GREEN (exit 0) under the mutation");
  const missing = o.expect.filter((e) => !result.out.includes(e));
  if (missing.length) problems.push(`red, but not for the reason under test — missing label(s): ${missing.map((m) => JSON.stringify(m)).join(", ")}`);
  const crash = crashSignatures(result.out);
  if (crash.length) problems.push(`red because of a CRASH, not the guard: ${crash.map(String).join(", ")}`);
  rec.expected = `exit!=0 + ${o.expect.map((e) => JSON.stringify(e)).join(" + ")}`;
  rec.actual = `exit=${result.rc}; labels ${missing.length ? "MISSING" : "present"}; crash signatures ${crash.length ? "PRESENT" : "absent"}`;

  // 6. POST-RESTORE GREEN
  if (!problems.length && o.postGreen) {
    const g = run(o.cmd);
    rec.postRestore = g.rc === 0 ? "green (exit 0)" : `RED (exit ${g.rc})`;
    if (g.rc !== 0) problems.push(`post-restore run is not green (exit ${g.rc})`);
  } else rec.postRestore = o.postGreen ? "not run" : "covered by the positive step";

  log(`── negative proof ${rec.id}`);
  log(`   MUTATION       ${rec.file}: ${rec.mutation}`);
  log(`   EXPECTED RED   ${rec.expected}`);
  log(`   ACTUAL RED     ${rec.actual}`);
  log(`   RESTORE        ${rec.restore}`);
  log(`   POST-RESTORE   ${rec.postRestore}`);
  if (problems.length) {
    log(tail(result.out));
    for (const p of problems) log(`NEGATIVE-PROOF FAIL [${o.id}]: ${p}`);
    return false;
  }
  log(`NEGATIVE-PROOF PASS [${o.id}]`);
  return true;
}

function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "negproof-"));
  const target = path.join(dir, "guard.mjs");
  const src = 'const allowed = (x) => x === "ok";\nif (!allowed(process.argv[2])) { console.log("FAIL  guard refused"); process.exit(1); }\nconsole.log("pass");\n';
  const test = path.join(dir, "test.mjs");
  fs.writeFileSync(target, src);
  // The "test": asserts the guard refuses "evil".
  fs.writeFileSync(test, `import { spawnSync } from "node:child_process";\nconst r = spawnSync(process.execPath, [${JSON.stringify(target)}, "evil"], { encoding: "utf8" });\nif (r.status === 0) { console.log("FAIL  guard accepted evil"); process.exit(1); }\nconsole.log("ok");\n`);
  const cmd = [process.execPath, test];
  const quiet = () => {};
  const cases = [];
  const expectOutcome = (name, fn, want) => {
    let got;
    try { got = fn(); } catch (e) { got = `throw:${e.message.split(" — ")[0].split(":").pop().trim()}`; }
    const pass = want instanceof RegExp ? want.test(String(got)) : got === want;
    cases.push([name, pass, got]);
  };
  // a) honest mutation: guard accepts everything -> test red with the intended label
  expectOutcome("intended red is accepted", () => negativeProof({ id: "st-a", file: target, anchor: 'x === "ok"', replace: "true", expect: ["FAIL  guard accepted evil"], count: 1, cmd }, { log: quiet }), true);
  // b) wrong label -> rejected
  expectOutcome("red for another reason is rejected", () => negativeProof({ id: "st-b", file: target, anchor: 'x === "ok"', replace: "true", expect: ["FAIL  something else"], count: 1, cmd }, { log: quiet }), false);
  // c) crash (ReferenceError) -> rejected even though the label is present? label absent here; crash present
  expectOutcome("crash is rejected", () => negativeProof({ id: "st-c", file: test, anchor: 'console.log("ok");', replace: 'console.log("FAIL  guard accepted evil"); undefinedThing();', expect: ["FAIL  guard accepted evil"], count: 1, cmd }, { log: quiet }), false);
  // d) anchor missing -> throws MUTATION NOT APPLIED
  expectOutcome("unapplied mutation throws", () => negativeProof({ id: "st-d", file: target, anchor: "no such anchor", replace: "x", expect: ["x"], count: 1, cmd }, { log: quiet }), /throw/);
  // e) no-op mutation (green) -> rejected
  expectOutcome("mutation that stays green is rejected", () => negativeProof({ id: "st-e", file: target, anchor: 'console.log("pass");', replace: 'console.log("pass!");', expect: ["FAIL  guard accepted evil"], count: 1, cmd }, { log: quiet }), false);
  // f) perl mode, exactly-once
  expectOutcome("perl mode intended red", () => negativeProof({ id: "st-f", file: target, perl: 's/x === "ok"/true/', expect: ["FAIL  guard accepted evil"], count: 1, cmd }, { log: quiet }), true);
  // g) no --expect -> throws
  expectOutcome("missing --expect throws", () => negativeProof({ id: "st-g", file: target, anchor: "x", replace: "y", expect: [], count: 1, cmd }, { log: quiet }), /throw/);
  const restored = fs.readFileSync(target, "utf8") === src;
  cases.push(["file restored byte-identical after all cases", restored, restored]);
  fs.rmSync(dir, { recursive: true, force: true });
  let ok = true;
  for (const [name, pass, got] of cases) { console.log(`${pass ? "PASS" : "FAIL"}  self-test: ${name}${pass ? "" : ` (got ${got})`}`); ok &&= pass; }
  console.log(ok ? `negative-proof self-test: ${cases.length} checks passed` : "negative-proof self-test FAILED");
  return ok;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isMain) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (o.selfTest) process.exit(selfTest() ? 0 : 1);
  try {
    process.exit(negativeProof(o) ? 0 : 1);
  } catch (e) {
    console.log(`NEGATIVE-PROOF FAIL: ${e.message}`);
    process.exit(1);
  }
}
