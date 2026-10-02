#!/usr/bin/env node
// release-migrate-gate — what release-migrate is allowed to apply, decided BEFORE it applies.
//
// THE INCIDENT (docs/security/RELEASE_MIGRATE_AUTHORITY_GATE.md): on 2026-10-01 release-migrate
// applied #594's privilege migration because it was pending on main and a run was dispatched and
// approved — while the owner's security decision package for it did not exist yet. Nothing in the
// workflow knew which migration had been approved.
//
// THIS GATE (implementation of the proposal; wired only after owner approval):
//
//   plan    (no secrets — runs BEFORE the protected job)
//     node scripts/ci/release-migrate-gate.mjs plan --expected "<a,b,…>"
//       * every expected name is a migration directory in this checkout;
//       * every expected AUTHORITY-CHANGING migration (classifier) has an approval record
//         ops/release-approvals/<name>.json whose sha256 equals the file at this SHA, names a
//         decision, an approver and a preflight run id;
//       * when GITHUB_TOKEN is present, that preflight run is a SUCCESSFUL run of
//         prod-readonly-evidence.yml that STARTED AFTER the migration reached main;
//       * prints the plan (name, class, checksum, approval) for the approver.
//
//   verify  (inside the protected job, after approval, BEFORE `prisma migrate deploy`)
//     node scripts/ci/release-migrate-gate.mjs verify --expected "<a,b,…>"
//       * computes the REAL pending set: migration directories minus FINISHED ledger rows
//         (DIRECT_URL); refuses if any ledger row is unfinished or rolled back;
//       * refuses unless pending == expected EXACTLY. One extra migration — e.g. a privilege
//         migration merged while the run waited for approval — stops the release.
//
//   --self-test  pure checks (no network, no database).
//
// EXIT: 0 allowed, 1 refused, 2 could not evaluate (also refuses).

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { classify } from "./migration-security-classifier.mjs";

const MIGRATIONS = "prisma/migrations";
const APPROVALS = "ops/release-approvals";
const NAME_RE = /^\d{14}_[a-z0-9_]+$/;

export function parseExpected(raw) {
  const names = String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) throw new Error("expected_migrations is empty — name exactly what may be applied");
  for (const n of names) if (!NAME_RE.test(n)) throw new Error(`not a migration name: ${n}`);
  if (new Set(names).size !== names.length) throw new Error("expected_migrations lists a name twice");
  return [...names].sort();
}

export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Pure: compare the real pending set with the expected one. */
export function comparePending(pending, expected) {
  const p = new Set(pending), e = new Set(expected);
  const extra = [...p].filter((x) => !e.has(x)).sort();
  const missing = [...e].filter((x) => !p.has(x)).sort();
  return { ok: extra.length === 0 && missing.length === 0, extra, missing };
}

/** Pure: validate one approval record against the migration file's checksum. */
export function checkApproval(name, record, fileSha) {
  const problems = [];
  if (!record) return [`no approval record ${APPROVALS}/${name}.json`];
  if (record.migration !== name) problems.push(`record names ${record.migration}, not ${name}`);
  if (record.sha256 !== fileSha) problems.push(`record checksum ${String(record.sha256).slice(0, 12)}… ≠ file ${fileSha.slice(0, 12)}…`);
  if (!/^https:\/\/github\.com\//.test(String(record.decision ?? ""))) problems.push("record.decision must link the owner's decision on github.com");
  if (!record.approvedBy) problems.push("record.approvedBy missing");
  if (!Number.isInteger(record.preflightRun) || record.preflightRun <= 0) problems.push("record.preflightRun must be a run id");
  return problems;
}

function readApproval(name) {
  const f = join(APPROVALS, `${name}.json`);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return { __invalid: true }; }
}

function mergedAt(name) {
  // First commit on this history that added the migration file.
  const out = execFileSync("git", ["log", "--diff-filter=A", "--format=%cI", "--", join(MIGRATIONS, name, "migration.sql")], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  return out.length ? out[out.length - 1] : null;
}

async function preflightRunOk(runId, notBefore) {
  const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN;
  if (!repo || !token) return { ok: false, why: "GITHUB_TOKEN / GITHUB_REPOSITORY unavailable — cannot verify the preflight run" };
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } });
  if (!r.ok) return { ok: false, why: `preflight run ${runId}: HTTP ${r.status}` };
  const run = await r.json();
  if (!String(run.path ?? "").endsWith("prod-readonly-evidence.yml")) return { ok: false, why: `run ${runId} is not prod-readonly-evidence.yml` };
  if (run.conclusion !== "success") return { ok: false, why: `run ${runId} concluded ${run.conclusion}` };
  if (notBefore && new Date(run.run_started_at) < new Date(notBefore)) return { ok: false, why: `run ${runId} started before the migration reached main` };
  return { ok: true };
}

async function plan(expected) {
  let refused = false;
  const rows = [];
  for (const name of expected) {
    const file = join(MIGRATIONS, name, "migration.sql");
    if (!existsSync(file)) { console.log(`REFUSE  ${name}: not a migration in this checkout`); refused = true; continue; }
    const sum = sha256(file);
    const cls = classify(readFileSync(file, "utf8"));
    let approval = "not required (no authority change)";
    if (cls.length) {
      const rec = readApproval(name);
      const problems = rec?.__invalid ? ["approval record is not valid JSON"] : checkApproval(name, rec, sum);
      if (!problems.length) {
        const pre = await preflightRunOk(rec.preflightRun, mergedAt(name));
        if (!pre.ok) problems.push(pre.why);
      }
      if (problems.length) { refused = true; approval = `REFUSED — ${problems.join("; ")}`; }
      else approval = `approved by ${rec.approvedBy} (${rec.decision}); preflight run ${rec.preflightRun}`;
    }
    rows.push(`${name} | ${cls.length ? `AUTHORITY [${cls.join(", ")}]` : "plain"} | sha256 ${sum.slice(0, 16)}… | ${approval}`);
  }
  console.log("release-migrate plan:\n  " + rows.join("\n  "));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## release-migrate plan\n\n${rows.map((r) => `- ${r}`).join("\n")}\n`);
  }
  return refused ? 1 : 0;
}

async function verify(expected) {
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  try {
    const ledger = await db.$queryRawUnsafe(`SELECT migration_name, finished_at IS NOT NULL AS done, rolled_back_at IS NOT NULL AS rolled FROM "_prisma_migrations"`);
    const bad = ledger.filter((r) => !r.done || r.rolled).map((r) => r.migration_name);
    if (bad.length) { console.log(`REFUSE: unfinished or rolled-back ledger rows: ${bad.join(", ")}`); return 1; }
    const applied = new Set(ledger.map((r) => r.migration_name));
    const dirs = readdirSync(MIGRATIONS, { withFileTypes: true }).filter((d) => d.isDirectory() && NAME_RE.test(d.name)).map((d) => d.name);
    const pending = dirs.filter((d) => !applied.has(d)).sort();
    const cmp = comparePending(pending, expected);
    console.log(`pending:  ${pending.join(", ") || "(none)"}\nexpected: ${expected.join(", ")}`);
    if (!cmp.ok) {
      if (cmp.extra.length) console.log(`REFUSE: pending but NOT approved for this run: ${cmp.extra.join(", ")}`);
      if (cmp.missing.length) console.log(`REFUSE: approved but not pending (already applied or absent): ${cmp.missing.join(", ")}`);
      return 1;
    }
    console.log("OK: the pending set is exactly the approved set");
    return 0;
  } finally {
    await db.$disconnect();
  }
}

function selfTest() {
  let failed = 0;
  const t = (name, cond) => { if (!cond) failed++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); };
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  t("parseExpected sorts and trims", JSON.stringify(parseExpected(" 20261005090000_b , 20261004090000_a")) === '["20261004090000_a","20261005090000_b"]');
  t("parseExpected refuses empty", throws(() => parseExpected("")));
  t("parseExpected refuses a non-migration name", throws(() => parseExpected("main")));
  t("parseExpected refuses duplicates", throws(() => parseExpected("20261004090000_a,20261004090000_a")));
  t("pending == expected passes", comparePending(["a", "b"], ["b", "a"]).ok);
  t("an EXTRA pending migration refuses (the #594 shape)", JSON.stringify(comparePending(["a", "p2"], ["a"]).extra) === '["p2"]');
  t("an approved-but-not-pending migration refuses", JSON.stringify(comparePending([], ["a"]).missing) === '["a"]');
  const good = { migration: "m", sha256: "x".repeat(64), decision: "https://github.com/o/r/pull/1#c", approvedBy: "owner", preflightRun: 123 };
  t("a matching approval record passes", checkApproval("m", good, "x".repeat(64)).length === 0);
  t("a checksum mismatch refuses", checkApproval("m", good, "y".repeat(64)).length === 1);
  t("a missing record refuses", checkApproval("m", null, "x".repeat(64)).length === 1);
  t("a record without a preflight run refuses", checkApproval("m", { ...good, preflightRun: 0 }, "x".repeat(64)).length === 1);
  t("a record for another migration refuses", checkApproval("m", { ...good, migration: "n" }, "x".repeat(64)).length === 1);
  console.log(failed ? `\nrelease-migrate-gate self-test: ${failed} FAILED` : "\nrelease-migrate-gate self-test: all passed");
  return failed ? 1 : 0;
}

const [cmd, flag, value] = process.argv.slice(2);
try {
  if (cmd === "--self-test") process.exit(selfTest());
  if (flag !== "--expected") throw new Error("usage: release-migrate-gate.mjs plan|verify --expected \"<names>\"");
  const expected = parseExpected(value);
  if (cmd === "plan") process.exit(await plan(expected));
  if (cmd === "verify") process.exit(await verify(expected));
  throw new Error(`unknown command ${cmd}`);
} catch (e) {
  console.error(`release-migrate-gate: could not evaluate — ${e.message}`);
  process.exit(2);
}
