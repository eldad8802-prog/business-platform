/**
 * Self-test for the release guard.
 * Run: node scripts/ci/release-guard.self-test.mjs
 *
 * Two halves:
 *
 *   1. The pure decision — every ledger shape that must deploy or must block.
 *   2. The WRAPPER — proving that a crash, a missing interpreter, or a failing
 *      guard produces Vercel's "abort" exit code and not its "build" one. That
 *      half matters most: Vercel inverts the shell convention, so the natural
 *      failure mode of a bash script here is to deploy anyway.
 *
 * No network, no database, no Vercel.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

import { summarizeLedger } from "./build-migration-attestation.mjs";

import {
  BLOCK_REASONS,
  evaluate,
  extractSingleFileFromZip,
  readRequiredMigrations,
  verifyRun,
} from "./release-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAPPER = join(HERE, "release-guard.sh");

let pass = 0;
let fail = 0;
function ok(name, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok   - ${name}`);
  } else {
    fail += 1;
    console.error(`  FAIL - ${name}${detail ? `  (${detail})` : ""}`);
  }
}

const att = (overrides = {}) => ({
  attestationVersion: 1,
  generatedAt: "2026-09-03T00:00:00.000Z",
  ledger: { applied: [], inflight: [], rolledBackOnly: [], totalRows: 0 },
  ...overrides,
});

/* ------------------------------------------------- 1. the pure decision -- */

console.log("\n[1] ledger decision");

{
  const r = evaluate({
    required: ["20260101_a"],
    attestation: att({ ledger: { applied: ["20260101_a"], inflight: [], rolledBackOnly: [], totalRows: 1 } }),
  });
  ok("1. applied once -> SAFE", r.safe === true);
}

{
  const r = evaluate({
    required: ["20260101_a", "20260102_b"],
    attestation: att({ ledger: { applied: ["20260101_a"], inflight: [], rolledBackOnly: [], totalRows: 1 } }),
  });
  ok("2. required but missing -> BLOCK", r.safe === false);
  ok("2. reason is NOT APPLIED", r.reason === BLOCK_REASONS.NOT_APPLIED, r.reason);
  ok("2. names the missing migration", /20260102_b/.test(r.detail));
}

{
  // Failed only: the publisher reports it as inflight (started, never finished).
  const r = evaluate({
    required: ["20260101_a"],
    attestation: att({ ledger: { applied: [], inflight: ["20260101_a"], rolledBackOnly: [], totalRows: 1 } }),
  });
  ok("3. failed only -> BLOCK", r.safe === false);
  ok("3. reason is ANOMALY", r.reason === BLOCK_REASONS.ANOMALY, r.reason);
}

{
  const r = evaluate({
    required: ["20260101_a"],
    attestation: att({ ledger: { applied: [], inflight: [], rolledBackOnly: ["20260101_a"], totalRows: 1 } }),
  });
  ok("4. rolled-back only -> BLOCK", r.safe === false);
  ok("4. reason is NOT APPLIED", r.reason === BLOCK_REASONS.NOT_APPLIED, r.reason);
}

{
  // The correction that matters: a historical failure must not poison a
  // migration that was later applied successfully.
  const r = evaluate({
    required: ["20260101_a"],
    attestation: att({
      ledger: {
        applied: ["20260101_a"],
        inflight: [],
        rolledBackOnly: [],
        totalRows: 2, // one rolled-back attempt + one successful
      },
    }),
  });
  ok("5. rolled-back then successful retry -> SAFE", r.safe === true);
}

{
  const r = evaluate({
    required: ["20260101_a"],
    attestation: att({
      ledger: { applied: ["20260101_a", "20260102_gone"], inflight: [], rolledBackOnly: [], totalRows: 2 },
    }),
  });
  ok("6. orphan (db ahead of commit) -> SAFE", r.safe === true);
  ok("6. orphan is reported, not blocked", r.ahead.includes("20260102_gone"));
}

{
  const r = evaluate({
    required: ["20260101_a"],
    attestation: att({
      ledger: { applied: ["20260101_a"], inflight: ["20260109_z"], rolledBackOnly: [], totalRows: 2 },
    }),
  });
  ok("7. inflight elsewhere -> BLOCK even though this commit is satisfied", r.safe === false);
  ok("7. reason is ANOMALY", r.reason === BLOCK_REASONS.ANOMALY, r.reason);
}

for (const [label, bad] of [
  ["null", null],
  ["string", "nope"],
  ["missing ledger", { attestationVersion: 1 }],
  ["ledger not arrays", { attestationVersion: 1, ledger: { applied: "x", inflight: [] } }],
]) {
  const r = evaluate({ required: ["a"], attestation: bad });
  ok(`8. malformed attestation (${label}) -> BLOCK`, r.safe === false);
  ok(`8. malformed (${label}) -> CANNOT VERIFY`, r.reason === BLOCK_REASONS.CANNOT_VERIFY, r.reason);
}

for (const v of [0, 2, "1", null, undefined]) {
  const r = evaluate({ required: ["a"], attestation: att({ attestationVersion: v }) });
  ok(`9. unsupported version ${JSON.stringify(v)} -> BLOCK`, r.safe === false);
  ok(`9. version ${JSON.stringify(v)} -> CANNOT VERIFY`, r.reason === BLOCK_REASONS.CANNOT_VERIFY);
}

{
  const r = evaluate({ required: [], attestation: null });
  ok("10. no artifact/attestation -> BLOCK", r.safe === false);
  ok("10. no attestation -> CANNOT VERIFY", r.reason === BLOCK_REASONS.CANNOT_VERIFY);
  ok(
    "10. an EMPTY required set still blocks without an attestation",
    r.safe === false,
    "must not vacuously pass"
  );
}

/* ------------------------------------------------------- authenticity -- */

console.log("\n[2] run authenticity");

const ALLOWED = [
  ".github/workflows/release-migrate.yml",
  ".github/workflows/attest-production-migrations.yml",
];
const goodRun = {
  id: 1,
  path: ".github/workflows/release-migrate.yml",
  conclusion: "success",
  head_branch: "main",
  event: "workflow_dispatch",
};

ok("11. authentic run accepted", verifyRun({ run: goodRun, allowedWorkflowPaths: ALLOWED }).ok === true);

for (const [label, patch] of [
  ["foreign workflow", { path: ".github/workflows/ci-1-prisma-centralization.yml" }],
  ["attacker-added workflow", { path: ".github/workflows/evil.yml" }],
  ["failed run", { conclusion: "failure" }],
  ["cancelled run", { conclusion: "cancelled" }],
  ["non-main branch", { head_branch: "feat/x" }],
  ["push-triggered", { event: "push" }],
  ["pull_request-triggered", { event: "pull_request" }],
]) {
  const v = verifyRun({ run: { ...goodRun, ...patch }, allowedWorkflowPaths: ALLOWED });
  ok(`11. rejected: ${label}`, v.ok === false, v.detail);
}
ok("11. missing run metadata rejected", verifyRun({ run: null, allowedWorkflowPaths: ALLOWED }).ok === false);

/* ------------------------------------------------------------- zip io -- */

console.log("\n[3] artifact decoding");

function makeZip(name, content, { store = false } = {}) {
  const nameBuf = Buffer.from(name, "utf8");
  const raw = Buffer.from(content, "utf8");
  const data = store ? raw : deflateRawSync(raw);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(store ? 0 : 8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const localAll = Buffer.concat([local, nameBuf, data]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(store ? 0 : 8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const centralAll = Buffer.concat([central, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralAll.length, 12);
  eocd.writeUInt32LE(localAll.length, 16);

  return Buffer.concat([localAll, centralAll, eocd]);
}

{
  const payload = JSON.stringify(att({ ledger: { applied: ["m1"], inflight: [], rolledBackOnly: [], totalRows: 1 } }));
  ok("12. deflated zip decodes", extractSingleFileFromZip(makeZip("a.json", payload)) === payload);
  ok("12. stored zip decodes", extractSingleFileFromZip(makeZip("a.json", payload, { store: true })) === payload);
  let threw = false;
  try {
    extractSingleFileFromZip(Buffer.from("not a zip at all"));
  } catch {
    threw = true;
  }
  ok("12. garbage zip throws (caller turns it into CANNOT VERIFY)", threw);
}

/* ------------------------------------------- required-migration reading -- */

console.log("\n[4] required migrations from the tree");

{
  const root = mkdtempSync(join(tmpdir(), "rg-"));
  mkdirSync(join(root, "prisma", "migrations", "20260101_a"), { recursive: true });
  writeFileSync(join(root, "prisma", "migrations", "20260101_a", "migration.sql"), "-- x");
  mkdirSync(join(root, "prisma", "migrations", "20260102_no_sql"), { recursive: true });
  const found = readRequiredMigrations(root);
  ok("13. reads migration dirs", found.includes("20260101_a"));
  ok("13. ignores dirs without migration.sql", !found.includes("20260102_no_sql"));
  ok("13. missing prisma/migrations -> empty", readRequiredMigrations(mkdtempSync(join(tmpdir(), "rg2-"))).length === 0);
  rmSync(root, { recursive: true, force: true });
}

/* --------------------------------------------- 5. THE WRAPPER INVERSION -- */

console.log("\n[5] wrapper exit codes  (0 = Vercel ABORTS, 1 = Vercel BUILDS)");

/**
 * Absolute path to bash, resolved once. Needed because the PATH-starvation test
 * below replaces PATH, and the child-process launcher resolves the interpreter
 * using the env we hand it — so a bare "bash" would fail to launch and the test
 * would report no exit code instead of testing anything.
 */
const BASH = (() => {
  const candidates = [
    "/bin/bash",
    "/usr/bin/bash",
    // Git for Windows: the MSYS paths above are not launchable by the Node
    // process, which needs a real Win32 path.
    "C:/Program Files/Git/bin/bash.exe",
    "C:/Program Files/Git/usr/bin/bash.exe",
  ];
  for (const c of candidates) {
    try {
      execFileSync(c, ["-c", "exit 0"], { stdio: "pipe" });
      return c;
    } catch {
      /* try next */
    }
  }
  return null;
})();

/** A PATH that keeps the shell's own tools reachable but hides `node`. */
function pathWithoutNode() {
  const sep = process.platform === "win32" ? ";" : ":";
  const nodeDir = dirname(process.execPath).toLowerCase();
  return (process.env.PATH || "")
    .split(sep)
    .filter((p) => p && p.toLowerCase() !== nodeDir)
    .join(sep);
}

function runWrapper(env, { path = null } = {}) {
  try {
    execFileSync(BASH ?? "bash", [WRAPPER], {
      env: { ...process.env, ...env, ...(path ? { PATH: path } : {}) },
      stdio: "pipe",
    });
    return 0;
  } catch (e) {
    return e.status ?? -1;
  }
}

const PATH_WITHOUT_NODE = pathWithoutNode();

{
  const code = runWrapper({ VERCEL_ENV: "preview" });
  ok("14. preview -> exit 1 (BUILDS, guard not involved)", code === 1, `got ${code}`);
}
{
  const code = runWrapper({ VERCEL_ENV: "development" });
  ok("14. development -> exit 1 (BUILDS)", code === 1, `got ${code}`);
}
{
  const code = runWrapper({ VERCEL_ENV: "" });
  ok("14. unset VERCEL_ENV -> exit 1 (BUILDS; not production)", code === 1, `got ${code}`);
}
{
  // Production with no credentials: the guard cannot verify, so it must ABORT.
  const code = runWrapper({
    VERCEL_ENV: "production",
    RELEASE_GUARD_REPO: "",
    RELEASE_GUARD_GITHUB_TOKEN: "",
  });
  ok("15. production + no token -> exit 0 (ABORTS, fail-closed)", code === 0, `got ${code}`);
}
{
  // The scenario that would be catastrophic: the interpreter is gone. A naive
  // script exits non-zero here and Vercel DEPLOYS.
  const sanity = runWrapper(
    { VERCEL_ENV: "preview" },
    { path: PATH_WITHOUT_NODE }
  );
  ok("16a. harness sanity: wrapper still runs on the reduced PATH", sanity === 1, `got ${sanity}`);

  const code = runWrapper({ VERCEL_ENV: "production" }, { path: PATH_WITHOUT_NODE });
  ok("16b. production + no node on PATH -> exit 0 (ABORTS, not fail-open)", code === 0, `got ${code}`);
}
{
  const dir = mkdtempSync(join(tmpdir(), "rg-w-"));
  const copy = join(dir, "release-guard.sh");
  writeFileSync(copy, `#!/usr/bin/env bash\n${""}`);
  chmodSync(copy, 0o755);
  // A wrapper whose sibling guard file is absent must abort, not build.
  const src = execFileSync("bash", ["-c", `cat ${JSON.stringify(WRAPPER)}`]).toString();
  writeFileSync(copy, src);
  let code;
  try {
    execFileSync("bash", [copy], {
      env: { ...process.env, VERCEL_ENV: "production", RELEASE_GUARD_REPO: "x/y", RELEASE_GUARD_GITHUB_TOKEN: "t" },
      stdio: "pipe",
    });
    code = 0;
  } catch (e) {
    code = e.status ?? -1;
  }
  ok("17. production + guard script missing -> exit 0 (ABORTS)", code === 0, `got ${code}`);
  rmSync(dir, { recursive: true, force: true });
}


/* --------------------------------------- 6. LEDGER SUMMARISER (publisher) -- */

console.log("\n[6] ledger summariser — raw rows to effective state");

const row = (name, finished, rolledBack) => ({
  migration_name: name,
  finished_at: finished,
  rolled_back_at: rolledBack,
});
const T = new Date("2026-01-01T00:00:00Z");

{
  const s = summarizeLedger([row("a", T, null)]);
  ok("18. single successful row -> applied", s.applied.includes("a") && s.inflight.length === 0);
}
{
  const s = summarizeLedger([row("a", null, null)]);
  ok("18. started, never finished -> inflight (not applied)", s.inflight.includes("a") && !s.applied.includes("a"));
}
{
  const s = summarizeLedger([row("a", null, T)]);
  ok("18. rolled back, never re-applied -> rolledBackOnly", s.rolledBackOnly.includes("a") && !s.applied.includes("a"));
}
{
  // The correction: a failed+rolled-back attempt followed by a successful retry.
  // Whether Prisma UPDATES the row or INSERTS a new one is not documented
  // unambiguously, so both shapes are asserted — the summariser must not care.
  const asTwoRows = summarizeLedger([row("a", null, T), row("a", T, null)]);
  ok("18. rolled-back THEN successful retry (2 rows) -> applied", asTwoRows.applied.includes("a"));
  ok("18. ...and not reported inflight", !asTwoRows.inflight.includes("a"));
  ok("18. ...and not reported rolledBackOnly", !asTwoRows.rolledBackOnly.includes("a"));

  const asOneRow = summarizeLedger([row("a", T, null)]);
  ok("18. same outcome if Prisma updates in place (1 row)", asOneRow.applied.includes("a"));
}
{
  const s = summarizeLedger([row("a", T, null), row("b", null, null), row("c", null, T)]);
  ok("18. mixed ledger classifies each name once",
    s.applied.length === 1 && s.inflight.length === 1 && s.rolledBackOnly.length === 1);
  ok("18. totalRows counts ROWS, not names", s.totalRows === 3);
}
{
  const s = summarizeLedger([]);
  ok("18. empty ledger summarises to empty (publisher refuses separately)", s.applied.length === 0);
}

/* ------------------------------------------------------------------------ */

console.log(
  `\nrelease-guard.self-test: ${pass} passed, ${fail} failed\n`
);
process.exit(fail === 0 ? 0 : 1);
