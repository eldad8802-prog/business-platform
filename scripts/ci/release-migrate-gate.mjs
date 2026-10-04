#!/usr/bin/env node
// release-migrate-gate — what release-migrate is allowed to apply, decided BEFORE it applies, and
// the only migrations the apply step can SEE.
//
// THE INCIDENT (docs/security/RELEASE_MIGRATE_AUTHORITY_GATE.md): on 2026-10-01 release-migrate
// applied #594's privilege migration because it was pending on main and a run was dispatched and
// approved — while the owner's security decision package for it did not exist yet. Nothing in the
// workflow knew which migration had been approved.
//
// THE SECOND PROBLEM (2026-10-04, P3-A behind M6): `prisma migrate deploy` applies EVERY pending
// migration, so an exact-set gate forced the owner to approve a later, unrelated migration merged to
// main (M6) just to release an earlier, ready one (P3-A). Weakening the comparison would not help:
// deploy would still apply M6. So the apply step is given a STAGED migrations directory that holds
// only what is already applied plus the approved prefix — an unapproved migration's SQL is not there
// to run. Nothing is marked applied by hand, the ledger is never edited, no SQL bypasses Prisma.
//
//   plan    (no secrets — runs BEFORE the protected job)
//     node scripts/ci/release-migrate-gate.mjs plan --expected "<a,b,…>"
//       * the names are given IN PRISMA ORDER (the order they will be applied);
//       * every expected name is a migration directory in this checkout;
//       * every expected AUTHORITY-CHANGING migration (classifier) has an approval record
//         ops/release-approvals/<name>.json whose sha256 equals the file at this SHA, names a
//         decision, an approver and a preflight run id;
//       * that preflight run is a SUCCESSFUL run of prod-readonly-evidence.yml FROM MAIN that
//         STARTED AFTER the migration reached main and names the record's evidence file — and its
//         log shows the evidence VERDICT: at least one PASS row and no FAIL row (a run "succeeds"
//         even when a check inside it fails);
//       * OWNER-BOUND RELEASE SETS: every approval record carrying "releaseSet" that shares a
//         migration with expected must equal expected exactly (subset, superset, other order,
//         conflicting sets refuse); a changed binding must name the decision it supersedes (see
//         checkReleaseSet / checkReleaseBinding / checkSupersession);
//       * prints the plan (name, class, checksum, approval) for the approver.
//
//   stage   (inside the protected job, AFTER approval, BEFORE any write)
//     node scripts/ci/release-migrate-gate.mjs stage --expected "<a,b,…>" --pinned-sha <sha> --out <dir>
//       * this checkout is exactly the dispatch commit (HEAD == --pinned-sha);
//       * the authority checks of `plan` again, after the wait (a record or run cannot have changed
//         its meaning while the run waited);
//       * reads the Production ledger NOW; refuses any unfinished or rolled-back row;
//       * pending order = migration directories AT THE DISPATCH SHA minus finished ledger rows,
//         in Prisma order;
//       * PREFIX INVARIANT: expected == pending[0..k) exactly, in order. An unapproved migration
//         before or inside the expected run, a gap, a different order, or a name that is not
//         pending refuses. Everything after the prefix stays pending;
//       * writes <dir>/prisma: schema.prisma + migration_lock.toml + byte-identical copies of the
//         applied directories and the approved prefix ONLY, re-reads that tree and refuses unless it
//         holds exactly those names with identical checksums; records <dir>/release-manifest.json.
//       `prisma migrate deploy --schema <dir>/prisma/schema.prisma` then cannot apply anything else.
//
//   confirm (inside the protected job, AFTER the apply)
//     node scripts/ci/release-migrate-gate.mjs confirm --expected "<a,b,…>" --out <dir>
//       * re-reads the ledger: finished == finished-before ∪ expected EXACTLY, no unfinished or
//         rolled-back row, and no ledger row at all for any migration left pending.
//
//   verify  stage's ledger + prefix checks without writing (no authority re-check, no staging).
//
//   --self-test  pure checks (no network, no database).
//
// EXIT: 0 allowed, 1 refused, 2 could not evaluate (also refuses).

import { readFileSync, readdirSync, existsSync, mkdirSync, cpSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { classify } from "./migration-security-classifier.mjs";

const MIGRATIONS = "prisma/migrations";
const APPROVALS = "ops/release-approvals";
const NAME_RE = /^\d{14}_[a-z0-9_]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const PREFLIGHT_FILE_RE = /^ops\/evidence\/[a-z0-9][a-z0-9._-]*\.sql$/;

/** The names, in the order given (= the order they must be applied). */
export function parseExpected(raw) {
  const names = String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) throw new Error("expected_migrations is empty — name exactly what may be applied");
  for (const n of names) if (!NAME_RE.test(n)) throw new Error(`not a migration name: ${n}`);
  if (new Set(names).size !== names.length) throw new Error("expected_migrations lists a name twice");
  return names;
}

/** Prisma's order: migration directory names, byte-wise. */
export function prismaOrder(names) {
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Pure: compare the real pending set with the expected one (kept for the exact-set reading). */
export function comparePending(pending, expected) {
  const p = new Set(pending), e = new Set(expected);
  const extra = [...p].filter((x) => !e.has(x)).sort();
  const missing = [...e].filter((x) => !p.has(x)).sort();
  return { ok: extra.length === 0 && missing.length === 0, extra, missing };
}

/**
 * Pure: the PREFIX INVARIANT. `pending` is in Prisma order; `expected` in the order given.
 * ok only when expected == pending[0..expected.length) element by element. `held` is what stays
 * pending (every element sorts after the whole approved prefix).
 */
export function checkPrefix(pending, expected) {
  const reasons = [];
  const pendingSet = new Set(pending);
  for (const e of expected) if (!pendingSet.has(e)) reasons.push(`approved but not pending (already applied or absent): ${e}`);
  if (!reasons.length) {
    for (let i = 0; i < expected.length; i++) {
      if (expected[i] === pending[i]) continue;
      const before = pending.slice(0, pending.indexOf(expected[i])).filter((p) => !expected.includes(p));
      if (before.length) reasons.push(`pending but NOT approved, and it would have to run before ${expected[i]}: ${before.join(", ")}`);
      else reasons.push(`expected is not in Prisma order: position ${i + 1} is ${expected[i]}, Prisma applies ${pending[i]} there`);
      break;
    }
  }
  const ok = reasons.length === 0;
  return { ok, reasons, held: ok ? pending.slice(expected.length) : [] };
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
  if (!PREFLIGHT_FILE_RE.test(String(record.preflightFile ?? ""))) problems.push("record.preflightFile must name the ops/evidence/*.sql the preflight ran");
  return problems;
}

// ── OWNER-BOUND RELEASE SETS ───────────────────────────────────────────────────────────────────
// The approved-prefix capability (stage) is TECHNICAL: it can apply any approved prefix of the
// pending order. An owner decision can be narrower: "these migrations go to Production TOGETHER, in
// one run". That is AUTHORITY, so it lives where authority lives — in the repository-tracked approval
// record — never in a dispatch input:
//
//   "releaseSet": ["<name>", …]   optional; the complete set, in Prisma order, that must be applied
//                                 together in one run.
//
// Restrict-only: a binding can only turn a release into a refusal, never authorize anything. Every
// approval record that carries a releaseSet touching the requested release is consulted — not only
// the records of the requested migrations — so a subset cannot slip through because the one record
// that binds it belongs to a migration that was left out. Records without releaseSet keep the generic
// prefix behaviour (backward compatible).
//
// Changing an owner's mind is a NEW authority artifact: the record that changes or removes a binding
// must name the decision it replaces ("supersedes": "<previous decision URL>") and carry a new
// decision link; the gate compares the record with its previous version in git history.

/** Pure: the shape of one record's releaseSet. `known` = migration directory names in this checkout. */
export function checkReleaseSet(name, record, known) {
  if (!record || record.releaseSet === undefined) return [];
  const rs = record.releaseSet;
  if (!Array.isArray(rs) || rs.length === 0) return ["releaseSet must be a non-empty list of migration names"];
  const problems = [];
  const bad = rs.filter((n) => typeof n !== "string" || !NAME_RE.test(n));
  if (bad.length) problems.push(`releaseSet holds names that are not migration names: ${bad.map(String).join(", ")}`);
  const dup = rs.filter((n, i) => rs.indexOf(n) !== i);
  if (dup.length) problems.push(`releaseSet lists a migration twice: ${[...new Set(dup)].join(", ")}`);
  if (!rs.includes(name)) problems.push(`releaseSet does not contain the record's own migration ${name}`);
  if (known) {
    const unknown = rs.filter((n) => NAME_RE.test(String(n)) && !known.has(n));
    if (unknown.length) problems.push(`releaseSet names migrations that do not exist in this checkout: ${unknown.join(", ")}`);
  }
  if (!bad.length && !dup.length && prismaOrder(rs).join() !== rs.join()) {
    problems.push(`releaseSet is not in Prisma order (canonical: ${prismaOrder(rs).join(", ")})`);
  }
  return problems;
}

/**
 * Pure: the release binding. `bindings` = every record that carries a releaseSet:
 * [{ source, migration, releaseSet }]. Only bindings that share a migration with `expected` apply.
 * Returns { problems, lines } — lines is the audit text printed for the approver.
 */
export function checkReleaseBinding(expected, bindings) {
  const relevant = bindings.filter((b) => Array.isArray(b.releaseSet) && b.releaseSet.some((n) => expected.includes(n)));
  const lines = [];
  const problems = [];
  if (!relevant.length) return { problems, lines };
  const sets = new Map();
  for (const b of relevant) {
    const key = b.releaseSet.join(",");
    if (!sets.has(key)) sets.set(key, { set: b.releaseSet, sources: [] });
    sets.get(key).sources.push(b.source);
  }
  if (sets.size > 1) {
    lines.push("conflicting owner-bound release sets:");
    for (const { set, sources } of sets.values()) lines.push(`  [${set.join(", ")}] (${sources.join(", ")})`);
    problems.push("REFUSED: approval records bind the requested migrations to DIFFERENT release sets — an owner decision must reconcile them (supersedes) before any of them is released");
    return { problems, lines };
  }
  const [{ set, sources }] = [...sets.values()];
  lines.push(`owner-bound release set detected (${sources.join(", ")}):`, ...set.map((n) => `  ${n}`));
  lines.push("requested release:", ...expected.map((n) => `  ${n}`));
  if (set.join() === expected.join()) return { problems, lines };
  const inSet = expected.filter((n) => set.includes(n));
  const outside = expected.filter((n) => !set.includes(n));
  const left = set.filter((n) => !expected.includes(n));
  if (!outside.length && left.length) {
    problems.push(`REFUSED: requested migrations are only a subset of the owner-approved release set (left out: ${left.join(", ")}) — releasing part of it needs a new owner decision`);
  } else if (outside.length && !left.length) {
    problems.push(`REFUSED: requested migrations go beyond the owner-approved release set (outside it: ${outside.join(", ")})`);
  } else if (outside.length) {
    problems.push(`REFUSED: requested migrations differ from the owner-approved release set (left out: ${left.join(", ")}; outside it: ${outside.join(", ")})`);
  } else {
    problems.push(`REFUSED: requested order ${inSet.join(", ")} is not the owner-approved release order`);
  }
  return { problems, lines };
}

/**
 * Pure: which owner-bound release sets are in force for `expected`, and which records refuse.
 * `entries` = every approval record: { path, name, record, prev } (prev = previousApproval(...)), or
 * { path, name, invalid: true }. A record matters when its own migration is requested, or its CURRENT
 * or its PREVIOUS binding touches the request — so a removed or changed binding cannot drop out of view.
 * Unless that change is validly superseded, the PREVIOUS binding stays in force (and the record
 * refuses); after a valid supersession the new authority governs and nothing resurrects.
 * Returns { refusals: [text], bindings: [{ source, migration, releaseSet }] }.
 */
export function evaluateApprovalBindings(expected, entries, known) {
  const refusals = [];
  const bindings = [];
  const touches = (set) => Array.isArray(set) && set.some((n) => expected.includes(n));
  for (const r of entries) {
    if (r.invalid) {
      if (!expected.includes(r.name)) refusals.push(`REFUSED — ${r.path} is not valid JSON (it could hide an owner-bound release set)`);
      continue; // a requested migration's invalid record is refused by the authority check itself
    }
    if (r.record.releaseSet !== undefined) {
      const shape = checkReleaseSet(r.record.migration ?? r.name, r.record, known);
      // A malformed binding refuses every release (fail closed): it cannot be told what it binds.
      if (shape.length) { refusals.push(`REFUSED — ${r.path}: ${shape.join("; ")}`); continue; }
    }
    if (!r.prev || r.prev.error) {
      // History is unreadable, so a binding this record once carried cannot be ruled out: fail closed.
      refusals.push(`REFUSED — cannot read the git history of ${r.path} (no git or a shallow clone; a removed or changed release binding could not be detected)`);
      continue;
    }
    const previousSet = r.prev.record?.releaseSet;
    if (!(expected.includes(r.name) || touches(r.record.releaseSet) || touches(previousSet))) continue;
    const sup = checkSupersession(r.record, r.prev.record);
    if (sup.length) {
      refusals.push(`REFUSED — ${r.path}: ${sup.join("; ")}`);
      if (Array.isArray(previousSet)) bindings.push({ source: `${r.path} (previous binding, not validly superseded)`, migration: r.prev.record.migration, releaseSet: previousSet });
    }
    if (r.record.releaseSet !== undefined) bindings.push({ source: r.path, migration: r.record.migration, releaseSet: r.record.releaseSet });
  }
  return { refusals, bindings };
}

/**
 * Pure: may `current` replace `previous` (the record file's previous version in git history)?
 * A change of binding — a releaseSet added to an approved record, changed, or removed — is a new
 * owner decision: `current.supersedes` must equal `previous.decision`, and `current.decision` must
 * be a different decision link. Unchanged bindings need nothing.
 */
export function checkSupersession(current, previous) {
  if (!previous || previous.__invalid) return [];
  const before = previous.releaseSet === undefined ? null : JSON.stringify(previous.releaseSet);
  const after = current?.releaseSet === undefined ? null : JSON.stringify(current?.releaseSet);
  if (before === after) return [];
  const problems = [];
  if (current?.supersedes !== previous.decision) {
    problems.push(after === null
      ? `the owner-bound release set ${before} was REMOVED without superseding the prior decision ("supersedes": "${previous.decision}" and a new decision link are required)`
      : `the release binding changed (${before ?? "none"} → ${after}) without "supersedes": "${previous.decision}" — a changed owner decision must name the decision it replaces`);
  }
  if (current?.decision === previous.decision) problems.push("the release binding changed but the decision link did not — link the NEW owner decision");
  return problems;
}

/**
 * Pure: is this GitHub run the preflight the record claims? A successful, manually dispatched
 * prod-readonly-evidence.yml run FROM MAIN, started after the migration reached main, whose title
 * (run-name) names the record's preflight file.
 */
export function checkPreflightRun(run, { notBefore, file }) {
  if (!run) return "preflight run not found";
  if (!String(run.path ?? "").endsWith("prod-readonly-evidence.yml")) return `run ${run.id} is not prod-readonly-evidence.yml`;
  if (run.event !== "workflow_dispatch") return `run ${run.id} was not manually dispatched`;
  if (run.head_branch !== "main") return `run ${run.id} ran from ${run.head_branch}, not main`;
  if (run.status !== "completed" || run.conclusion !== "success") return `run ${run.id} concluded ${run.conclusion ?? run.status}`;
  if (!notBefore) return "cannot establish when the migration reached main — refusing";
  if (!(new Date(run.run_started_at) >= new Date(notBefore))) return `run ${run.id} started before the migration reached main`;
  if (!file || !String(run.display_title ?? "").includes(file)) return `run ${run.id} does not name ${file} in its title (run-name)`;
  return null;
}

/**
 * Pure: the evidence VERDICT in a preflight job log. Evidence rows are pipe-separated
 * (`n | PASS | observed`); a verdict is a cell that is exactly PASS or FAIL. The workflow run
 * concludes "success" whenever the SQL ran, whatever it found — so the gate reads the verdict.
 */
export function checkPreflightVerdict(logText) {
  const lines = String(logText ?? "").split(/\r?\n/).map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, ""));
  let pass = 0, fail = 0;
  for (const l of lines) {
    if (!l.includes("|")) continue;
    const c = l.split("|").map((s) => s.trim());
    if (c.includes("FAIL")) fail++;
    else if (c.includes("PASS")) pass++;
  }
  if (fail) return `its evidence reports ${fail} FAIL row(s) — a preflight that found a problem is not a passing preflight`;
  if (!pass) return "its log shows no PASS verdict row — cannot establish that the preflight passed";
  return null;
}

function readApproval(name) {
  const f = join(APPROVALS, `${name}.json`);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return { __invalid: true }; }
}

function mergedAt(name) {
  // First commit on this history that added the migration file.
  // null (no history, shallow clone, git missing) refuses downstream: never assumed "old enough".
  try {
    const out = execFileSync("git", ["log", "--diff-filter=A", "--format=%cI", "--", join(MIGRATIONS, name, "migration.sql")], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    return out.length ? out[out.length - 1] : null;
  } catch { return null; }
}

function gh(path) {
  const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN;
  return fetch(`https://api.github.com/repos/${repo}${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } });
}

async function preflightRunOk(runId, notBefore, file) {
  if (!process.env.GITHUB_REPOSITORY || !process.env.GITHUB_TOKEN) return { ok: false, why: "GITHUB_TOKEN / GITHUB_REPOSITORY unavailable — cannot verify the preflight run" };
  const r = await gh(`/actions/runs/${runId}`);
  if (!r.ok) return { ok: false, why: `preflight run ${runId}: HTTP ${r.status}` };
  const why = checkPreflightRun(await r.json(), { notBefore, file });
  if (why) return { ok: false, why };
  if (!existsSync(file)) return { ok: false, why: `${file} is not in this checkout` };
  const jobs = await gh(`/actions/runs/${runId}/jobs?per_page=20`);
  if (!jobs.ok) return { ok: false, why: `preflight run ${runId} jobs: HTTP ${jobs.status}` };
  const list = (await jobs.json()).jobs ?? [];
  if (!list.length) return { ok: false, why: `preflight run ${runId} has no job` };
  let log = "";
  for (const j of list) {
    const l = await gh(`/actions/jobs/${j.id}/logs`);
    if (!l.ok) return { ok: false, why: `preflight run ${runId} log: HTTP ${l.status} (expired or unreadable — re-run the preflight)` };
    log += (await l.text()) + "\n";
  }
  const verdict = checkPreflightVerdict(log);
  if (verdict) return { ok: false, why: `preflight run ${runId}: ${verdict}` };
  return { ok: true };
}

/**
 * Every approval record in this checkout (all of ops/release-approvals/*.json): the owner-bound
 * release sets live in them. An unreadable record is reported, never skipped — a corrupt file must
 * not be able to hide a binding.
 */
function allApprovalRecords() {
  if (!existsSync(APPROVALS)) return [];
  return readdirSync(APPROVALS).filter((f) => f.endsWith(".json")).map((f) => {
    const path = `${APPROVALS}/${f}`; // forward slashes: also a git pathspec (git show <commit>:<path>)
    try { return { path, name: f.replace(/\.json$/, ""), record: JSON.parse(readFileSync(path, "utf8")) }; }
    catch { return { path, name: f.replace(/\.json$/, ""), invalid: true }; }
  });
}

/**
 * The version a binding change is judged against: walking the record's committed history from newest
 * to oldest, the most recent version whose releaseSet differs from the record as it is now (so a change
 * cannot be laundered by touching the file again afterwards). Versions that are not valid JSON are
 * skipped — an unreadable intermediate version must not be able to stand in for the binding it hid.
 *   { record }      the last valid version with a different binding
 *   { none: true }  no committed version ever bound differently (also: a record not committed yet)
 *   { error: true } the history cannot be read — no git, or a SHALLOW clone (whose log silently looks
 *                   like "no history"); the caller refuses rather than assume
 */
function previousApproval(path, current) {
  try {
    if (execFileSync("git", ["rev-parse", "--is-shallow-repository"], { encoding: "utf8" }).trim() !== "false") return { error: true };
    const commits = execFileSync("git", ["log", "--format=%H", "--", path], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    const binding = (r) => (r?.releaseSet === undefined ? null : JSON.stringify(r.releaseSet));
    for (const c of commits) {
      let rec;
      try { rec = JSON.parse(execFileSync("git", ["show", `${c}:${path}`], { encoding: "utf8" })); } catch { continue; }
      if (binding(rec) !== binding(current)) return { record: rec };
    }
    return { none: true };
  } catch { return { error: true }; }
}

/** The authority checks (plan, and again in the protected job). Returns { refused, rows }. */
async function authorize(expected) {
  let refused = false;
  const rows = [];
  const known = new Set(checkoutDirs());
  for (const name of expected) {
    const file = join(MIGRATIONS, name, "migration.sql");
    if (!existsSync(file)) { rows.push(`${name} | REFUSED — not a migration in this checkout`); refused = true; continue; }
    const sum = sha256(file);
    const cls = classify(readFileSync(file, "utf8"));
    let approval = "not required (no authority change)";
    if (cls.length) {
      const rec = readApproval(name);
      const problems = rec?.__invalid ? ["approval record is not valid JSON"] : checkApproval(name, rec, sum);
      if (!problems.length) {
        const pre = await preflightRunOk(rec.preflightRun, mergedAt(name), rec.preflightFile);
        if (!pre.ok) problems.push(pre.why);
      }
      if (problems.length) { refused = true; approval = `REFUSED — ${problems.join("; ")}`; }
      else approval = `approved by ${rec.approvedBy} (${rec.decision}); preflight ${rec.preflightFile} run ${rec.preflightRun}`;
    }
    rows.push(`${name} | ${cls.length ? `AUTHORITY [${cls.join(", ")}]` : "plain"} | sha256 ${sum.slice(0, 16)}… | ${approval}`);
  }
  const order = prismaOrder(expected);
  if (order.join() !== expected.join()) { refused = true; rows.push(`REFUSED — expected is not in Prisma order; Prisma applies: ${order.join(", ")}`); }

  // Owner-bound release sets: every approval record, its current binding and its previous one.
  const entries = allApprovalRecords().map((r) => (r.invalid ? r : { ...r, prev: previousApproval(r.path, r.record) }));
  const scan = evaluateApprovalBindings(expected, entries, known);
  if (scan.refusals.length) { refused = true; rows.push(...scan.refusals); }
  const bindings = scan.bindings;
  const binding = checkReleaseBinding(expected, bindings);
  rows.push(...binding.lines);
  if (binding.problems.length) { refused = true; rows.push(...binding.problems); }
  return { refused, rows };
}

function summary(title, rows) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${title}\n\n${rows.map((r) => `- ${r}`).join("\n")}\n\n`);
}

async function plan(expected) {
  const { refused, rows } = await authorize(expected);
  console.log("release-migrate plan:\n  " + rows.join("\n  "));
  summary("release-migrate plan", rows);
  return refused ? 1 : 0;
}

async function readLedger() {
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  try {
    return await db.$queryRawUnsafe(`SELECT migration_name, finished_at IS NOT NULL AS done, rolled_back_at IS NOT NULL AS rolled FROM "_prisma_migrations"`);
  } finally {
    await db.$disconnect();
  }
}

function checkoutDirs(root = MIGRATIONS) {
  return readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && NAME_RE.test(d.name)).map((d) => d.name);
}

/** Ledger + checkout → the prefix decision. Prints; returns { ok, finished, pending, held }. */
async function decide(expected) {
  const ledger = await readLedger();
  const bad = ledger.filter((r) => !r.done || r.rolled).map((r) => r.migration_name);
  if (bad.length) { console.log(`REFUSE: unfinished or rolled-back ledger rows: ${bad.join(", ")}`); return { ok: false }; }
  const finished = new Set(ledger.map((r) => r.migration_name));
  const pending = prismaOrder(checkoutDirs().filter((d) => !finished.has(d)));
  const p = checkPrefix(pending, expected);
  console.log(`pending (Prisma order): ${pending.join(", ") || "(none)"}\nexpected:               ${expected.join(", ")}`);
  if (!p.ok) { for (const r of p.reasons) console.log(`REFUSE: ${r}`); return { ok: false }; }
  console.log(p.held.length
    ? `OK: expected is the approved prefix of the pending order; stays pending (not applied by this run): ${p.held.join(", ")}`
    : "OK: the pending set is exactly the approved set");
  return { ok: true, finished, pending, held: p.held };
}

async function verify(expected) {
  return (await decide(expected)).ok ? 0 : 1;
}

function assertPinned(pinned) {
  if (!SHA_RE.test(String(pinned ?? ""))) throw new Error("--pinned-sha <40-hex dispatch sha> is required");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== pinned) { console.log(`REFUSE: this checkout is ${head}, not the dispatch commit ${pinned}`); return false; }
  console.log(`pinned: checkout == dispatch commit ${pinned}`);
  return true;
}

async function stage(expected, { pinned, out }) {
  if (!out) throw new Error("--out <dir> is required");
  if (!assertPinned(pinned)) return 1;
  const auth = await authorize(expected);
  console.log("authority (re-checked after approval):\n  " + auth.rows.join("\n  "));
  if (auth.refused) return 1;
  const d = await decide(expected);
  if (!d.ok) return 1;

  const keep = new Set([...checkoutDirs().filter((n) => d.finished.has(n)), ...expected]);
  rmSync(out, { recursive: true, force: true });
  const mig = join(out, "prisma", "migrations");
  mkdirSync(mig, { recursive: true });
  cpSync("prisma/schema.prisma", join(out, "prisma", "schema.prisma"));
  cpSync(join(MIGRATIONS, "migration_lock.toml"), join(mig, "migration_lock.toml"));
  for (const n of keep) cpSync(join(MIGRATIONS, n), join(mig, n), { recursive: true });

  // Re-read what was written: exactly the kept names, byte-identical, and no held migration.
  const staged = checkoutDirs(mig);
  const problems = [];
  if (staged.length !== keep.size || staged.some((n) => !keep.has(n))) problems.push("staged names differ from applied ∪ approved");
  for (const n of staged) if (sha256(join(mig, n, "migration.sql")) !== sha256(join(MIGRATIONS, n, "migration.sql"))) problems.push(`staged ${n} differs from the checkout`);
  for (const h of d.held) if (existsSync(join(mig, h))) problems.push(`held migration ${h} was staged`);
  const stagedPending = prismaOrder(staged.filter((n) => !d.finished.has(n)));
  if (stagedPending.join() !== expected.join()) problems.push(`staged pending ${stagedPending.join(", ")} ≠ expected`);
  if (problems.length) { for (const p of problems) console.log(`REFUSE: ${p}`); return 1; }

  const manifest = {
    pinnedSha: pinned,
    expected,
    held: d.held,
    finishedBefore: prismaOrder([...d.finished]),
    expectedSha256: Object.fromEntries(expected.map((n) => [n, sha256(join(MIGRATIONS, n, "migration.sql"))])),
  };
  writeFileSync(join(out, "release-manifest.json"), JSON.stringify(manifest, null, 2));
  const rows = [
    `dispatch commit: ${pinned}`,
    `applies (in order): ${expected.join(", ")}`,
    `stays pending, NOT staged: ${d.held.join(", ") || "(none)"}`,
    `staged: ${staged.length} migration directories = ${staged.length - expected.length} applied + ${expected.length} approved`,
  ];
  console.log("STAGED:\n  " + rows.join("\n  "));
  summary("release-migrate staged", rows);
  return 0;
}

async function confirm(expected, { out }) {
  if (!out) throw new Error("--out <dir> is required");
  const m = JSON.parse(readFileSync(join(out, "release-manifest.json"), "utf8"));
  if (m.expected.join() !== expected.join()) { console.log("REFUSE: the manifest is for another expected list"); return 1; }
  const ledger = await readLedger();
  const problems = [];
  const bad = ledger.filter((r) => !r.done || r.rolled).map((r) => r.migration_name);
  if (bad.length) problems.push(`unfinished or rolled-back ledger rows: ${bad.join(", ")}`);
  const names = new Set(ledger.map((r) => r.migration_name)); // any row, finished or not
  const finished = new Set(ledger.filter((r) => r.done && !r.rolled).map((r) => r.migration_name));
  const want = new Set([...m.finishedBefore, ...m.expected]);
  const extra = [...names].filter((n) => !want.has(n));
  const missing = [...want].filter((n) => !finished.has(n));
  if (extra.length) problems.push(`ledger rows this release did not approve: ${extra.join(", ")}`);
  if (missing.length) problems.push(`approved but not recorded as FINISHED: ${missing.join(", ")}`);
  const heldRows = m.held.filter((h) => names.has(h));
  if (heldRows.length) problems.push(`a held migration has a ledger row: ${heldRows.join(", ")}`);
  const rows = [
    `ledger: ${finished.size} finished of ${names.size} rows (was ${m.finishedBefore.length}; +${m.expected.length} approved)`,
    `applied now: ${m.expected.map((n) => `${n} ${finished.has(n) ? "✓" : names.has(n) ? "✗ FAILED / UNFINISHED" : "✗ NO ROW"}`).join(", ")}`,
    `still pending (no ledger row): ${m.held.map((h) => `${h} ${names.has(h) ? "✗ HAS A ROW" : "✓"}`).join(", ") || "(none)"}`,
  ];
  console.log("LEDGER AFTER:\n  " + rows.join("\n  "));
  summary("release-migrate ledger after", rows);
  if (problems.length) { for (const p of problems) console.log(`FAIL: ${p}`); return 1; }
  console.log("OK: the ledger holds exactly what was applied before plus the approved prefix");
  return 0;
}

function selfTest() {
  let failed = 0;
  const t = (name, cond) => { if (!cond) failed++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); };
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  t("parseExpected keeps the given order and trims", JSON.stringify(parseExpected(" 20261005090000_b , 20261004090000_a")) === '["20261005090000_b","20261004090000_a"]');
  t("parseExpected refuses empty", throws(() => parseExpected("")));
  t("parseExpected refuses a non-migration name", throws(() => parseExpected("main")));
  t("parseExpected refuses duplicates", throws(() => parseExpected("20261004090000_a,20261004090000_a")));
  t("prismaOrder is byte order (same timestamp: the name decides)", prismaOrder(["20261008090000_p3a", "20261008090000_learning"]).join() === "20261008090000_learning,20261008090000_p3a");
  t("pending == expected (exact set) compares equal", comparePending(["a", "b"], ["b", "a"]).ok);
  t("an EXTRA pending migration is visible (the #594 shape)", JSON.stringify(comparePending(["a", "p2"], ["a"]).extra) === '["p2"]');
  const P = ["A", "B", "C"];
  const pre = (e) => checkPrefix(P, e);
  t("prefix [A] allowed, B and C held", pre(["A"]).ok && pre(["A"]).held.join() === "B,C");
  t("prefix [A,B] allowed, C held", pre(["A", "B"]).ok && pre(["A", "B"]).held.join() === "C");
  t("prefix [A,B,C] allowed (the exact set), nothing held", pre(["A", "B", "C"]).ok && pre(["A", "B", "C"]).held.length === 0);
  t("[B] refused: A is unapproved and runs before it", !pre(["B"]).ok && /NOT approved.*before B: A/.test(pre(["B"]).reasons[0]));
  t("[A,C] refused: B is unapproved and inside the run", !pre(["A", "C"]).ok && /before C: B/.test(pre(["A", "C"]).reasons[0]));
  t("[B,C] refused", !pre(["B", "C"]).ok);
  t("[B,A] refused: wrong order", !pre(["B", "A"]).ok && /not in Prisma order/.test(pre(["B", "A"]).reasons[0]));
  t("[A,B,C,D] refused: D is not pending", !pre(["A", "B", "C", "D"]).ok && /not pending.*D/.test(pre(["A", "B", "C", "D"]).reasons[0]));
  t("a refused prefix holds nothing back as 'pending' output", pre(["B"]).held.length === 0);
  t("[A] with nothing pending refused (re-run)", !checkPrefix([], ["A"]).ok);
  const good = { migration: "m", sha256: "x".repeat(64), decision: "https://github.com/o/r/pull/1#c", approvedBy: "owner", preflightRun: 123, preflightFile: "ops/evidence/m-preflight.sql" };
  t("a matching approval record passes", checkApproval("m", good, "x".repeat(64)).length === 0);
  t("a checksum mismatch refuses", checkApproval("m", good, "y".repeat(64)).length === 1);
  t("a missing record refuses", checkApproval("m", null, "x".repeat(64)).length === 1);
  t("a record without a preflight run refuses", checkApproval("m", { ...good, preflightRun: 0 }, "x".repeat(64)).length === 1);
  t("a record for another migration refuses", checkApproval("m", { ...good, migration: "n" }, "x".repeat(64)).length === 1);
  t("a record without its preflight file refuses", checkApproval("m", { ...good, preflightFile: undefined }, "x".repeat(64)).length === 1);
  t("a preflight file outside ops/evidence refuses", checkApproval("m", { ...good, preflightFile: "../x.sql" }, "x".repeat(64)).length === 1);
  const run = { id: 9, path: ".github/workflows/prod-readonly-evidence.yml", event: "workflow_dispatch", head_branch: "main", status: "completed",
    conclusion: "success", run_started_at: "2026-10-02T10:00:00Z", display_title: "Prod Read-Only Evidence — ops/evidence/m-preflight.sql" };
  const at = { notBefore: "2026-10-02T09:00:00Z", file: "ops/evidence/m-preflight.sql" };
  t("the matching preflight run passes", checkPreflightRun(run, at) === null);
  t("a run of another workflow refuses", checkPreflightRun({ ...run, path: ".github/workflows/release-migrate.yml" }, at) !== null);
  t("a failed preflight run refuses", checkPreflightRun({ ...run, conclusion: "failure" }, at) !== null);
  t("a preflight run from a branch refuses", checkPreflightRun({ ...run, head_branch: "feat/x" }, at) !== null);
  t("a preflight run that started before the merge refuses", checkPreflightRun({ ...run, run_started_at: "2026-10-02T08:59:59Z" }, at) !== null);
  t("an unknown merge time refuses (never assumed old enough)", checkPreflightRun(run, { ...at, notBefore: null }) !== null);
  t("a preflight run of a DIFFERENT evidence file refuses", checkPreflightRun({ ...run, display_title: "Prod Read-Only Evidence — ops/evidence/other.sql" }, at) !== null);
  t("a run without a run-name (every run before the gate) refuses", checkPreflightRun({ ...run, display_title: "Prod Read-Only Evidence (CardCom E2E)" }, at) !== null);
  const ts = "2026-10-04T18:20:01.1234567Z ";
  t("verdict: all PASS rows pass", checkPreflightVerdict(`${ts} 1 | PASS | 0 \n${ts} 2 | PASS | 6 `) === null);
  t("verdict: one FAIL row refuses (the P3-A 18/19 run shape)", /1 FAIL/.test(checkPreflightVerdict(`${ts} 1 | PASS | 0 \n${ts} 3 | FAIL | 1 `) ?? ""));
  t("verdict: no PASS row refuses", checkPreflightVerdict(`${ts}hello\n${ts}CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END`) !== null);
  t("verdict: SQL text naming 'FAIL' is not a verdict", checkPreflightVerdict(`${ts}SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result\n${ts} 1 | PASS | 0 `) === null);
  // ── owner-bound release sets (synthetic names) ─────────────────────────────────────────────
  const A = "20300101090000_a", B = "20300101090100_b", C = "20300101090200_c", D = "20300101090300_d";
  const KNOWN = new Set([A, B, C, D]);
  const ABCD = [A, B, C, D];
  const bind = (migration, releaseSet, source = `ops/release-approvals/${migration}.json`) => ({ source, migration, releaseSet });
  const allowed = (expected, bindings) => checkReleaseBinding(expected, bindings).problems.length === 0;
  const why = (expected, bindings) => checkReleaseBinding(expected, bindings).problems.join(" ");
  t("R1 no releaseSet: the exact pending set is allowed (prefix layer, binding silent)",
    checkPrefix(ABCD, ABCD).ok && allowed(ABCD, []));
  t("R2 no releaseSet: a shorter prefix is allowed, the rest held",
    checkPrefix(ABCD, [A, B]).ok && checkPrefix(ABCD, [A, B]).held.join() === `${C},${D}` && allowed([A, B], []));
  const abc = [bind(B, [A, B, C])];
  t("R3 releaseSet [A,B,C] + dispatch [A,B,C] → allowed", allowed([A, B, C], abc));
  t("R4 releaseSet [A,B,C] + dispatch [A,B] → refused as a subset", /only a subset.*left out: .*_c/.test(why([A, B], abc)));
  t("R5 releaseSet [A,B,C] + dispatch [A] → refused as a subset", /only a subset/.test(why([A], abc)));
  t("R6 releaseSet [A,B,C] + dispatch [A,B,C,D] → refused as beyond the set", /beyond the owner-approved release set.*_d/.test(why([A, B, C, D], abc)));
  t("R6b a dispatch that leaves part out AND adds another → refused as different", /differ from.*left out: .*_c.*outside it: .*_d/.test(why([A, B, D], abc)));
  t("R6c a dispatch that touches the set only through a member it left the record of out → still refused (all binding records consulted)",
    /only a subset/.test(why([A], [bind(C, [A, B, C])])));
  t("R7 B and C both bind [A,B,C] → allowed", allowed([A, B, C], [bind(B, [A, B, C]), bind(C, [A, B, C])]));
  t("R8 B binds [A,B,C], C binds [A,B] → refused as conflicting", /DIFFERENT release sets/.test(why([A, B, C], [bind(B, [A, B, C]), bind(C, [A, B])])));
  t("R8b the conflict refuses whichever subset is requested", /DIFFERENT/.test(why([A, B], [bind(B, [A, B, C]), bind(C, [A, B])])));
  t("R9 a duplicate in releaseSet → refused", checkReleaseSet(B, { releaseSet: [A, B, B] }, KNOWN).some((p) => /twice/.test(p)));
  t("R10 an unknown migration in releaseSet → refused", checkReleaseSet(B, { releaseSet: [A, B, "20300101099900_ghost"] }, KNOWN).some((p) => /do not exist/.test(p)));
  t("R10b a non-migration name in releaseSet → refused", checkReleaseSet(B, { releaseSet: [A, B, "main"] }, KNOWN).some((p) => /not migration names/.test(p)));
  t("R11 the record's own migration absent from its releaseSet → refused", checkReleaseSet(B, { releaseSet: [A, C] }, KNOWN).some((p) => /own migration/.test(p)));
  t("R12 a releaseSet out of Prisma order → refused deterministically, naming the canonical order",
    checkReleaseSet(B, { releaseSet: [B, A, C] }, KNOWN).some((p) => /not in Prisma order \(canonical: 20300101090000_a, 20300101090100_b, 20300101090200_c\)/.test(p)));
  t("R12b an empty or non-list releaseSet → refused", checkReleaseSet(B, { releaseSet: [] }, KNOWN).length === 1 && checkReleaseSet(B, { releaseSet: "all" }, KNOWN).length === 1);
  t("R12c a well-formed releaseSet passes its shape check", checkReleaseSet(B, { releaseSet: [A, B, C] }, KNOWN).length === 0);
  t("R12d no releaseSet (legacy record) → no shape problem, no binding", checkReleaseSet(B, { migration: B }, KNOWN).length === 0 && allowed([A], []));
  const legacy = { migration: B, sha256: "x".repeat(64), decision: "https://github.com/o/r/pull/1#c", approvedBy: "owner", preflightRun: 123, preflightFile: "ops/evidence/b-preflight.sql" };
  t("R13 checksum mismatch still refuses a bound record (authority stays checksum-bound)",
    checkApproval(B, { ...legacy, releaseSet: [A, B, C] }, "y".repeat(64)).some((p) => /checksum/.test(p)));
  t("R13b a legacy record without releaseSet still validates unchanged", checkApproval(B, legacy, "x".repeat(64)).length === 0);
  // R14 (unfinished / failed ledger row) and R15 (stale / failed / wrong-file preflight run) are the
  // unchanged ledger and preflight checks above (decide(), checkPreflightRun, checkPreflightVerdict).
  t("R14 an unfinished row refuses before any binding question (the prefix layer has no pending answer)", !checkPrefix([], [A]).ok);
  t("R15 a bound record still needs a passing preflight (a FAIL verdict refuses)", checkPreflightVerdict(" 1 | FAIL | 1 ") !== null);
  const v1 = { ...legacy, releaseSet: [A, B, C] };
  t("R16 changing [A,B,C] → [A,B] without supersedes → refused",
    checkSupersession({ ...v1, releaseSet: [A, B] }, v1).some((p) => /supersedes/.test(p)));
  t("R16b … with supersedes but the SAME decision link → refused",
    checkSupersession({ ...v1, releaseSet: [A, B], supersedes: v1.decision }, v1).some((p) => /decision link did not/.test(p)));
  const v2 = { ...v1, releaseSet: [A, B], supersedes: v1.decision, decision: "https://github.com/o/r/pull/2#new" };
  t("R16c … with supersedes = the old decision and a NEW decision → accepted", checkSupersession(v2, v1).length === 0);
  t("R16d under the new authority [A,B] is allowed and [A,B,C] is refused",
    allowed([A, B], [bind(B, v2.releaseSet)]) && /beyond/.test(why([A, B, C], [bind(B, v2.releaseSet)])));
  t("R16e removing a binding is a change too (needs supersedes)", checkSupersession({ ...legacy }, v1).length >= 1);
  t("R16f adding a binding to an approved record is a change too", checkSupersession(v1, legacy).length >= 1);
  t("R16g an unchanged binding needs nothing; a first version has no previous", checkSupersession(v1, { ...v1 }).length === 0 && checkSupersession(v1, undefined).length === 0);
  const audit = checkReleaseBinding([A, B], abc).lines.join("\n");
  t("audit: the gate prints the bound set and the requested release, member by member",
    audit.includes("owner-bound release set detected") && audit.includes(`  ${C}`) && audit.includes("requested release:\n  " + A + "\n  " + B));
  // ── historical bindings: the same evaluation authorize() runs (evaluateApprovalBindings → checkReleaseBinding)
  const D1 = "https://github.com/o/r/pull/1#decision-1", D2 = "https://github.com/o/r/pull/2#decision-2";
  const recOf = (m, extra) => ({ migration: m, sha256: "x".repeat(64), decision: D1, approvedBy: "owner", preflightRun: 1, preflightFile: "ops/evidence/x.sql", ...extra });
  const entry = (m, record, prevRecord) => ({ path: `ops/release-approvals/${m}.json`, name: m, record, prev: prevRecord === undefined ? { none: true } : { record: prevRecord } });
  const gate = (expected, entries) => {
    const scan = evaluateApprovalBindings(expected, entries, KNOWN);
    const b = checkReleaseBinding(expected, scan.bindings);
    return { ok: scan.refusals.length === 0 && b.problems.length === 0, text: [...scan.refusals, ...b.problems].join(" ") };
  };
  const cBound = recOf(C, { releaseSet: [A, B, C] });
  const cRemoved = recOf(C, {}); // binding removed, no supersedes, same decision
  const h1 = gate([A, B], [entry(C, cRemoved, cBound)]);
  t("H1 C's binding [A,B,C] REMOVED without supersedes, [A,B] requested (C not requested) → refused",
    !h1.ok && /REMOVED without superseding the prior decision/.test(h1.text) && /only a subset/.test(h1.text), h1.text);
  // H2: a later unrelated edit; previousApproval() still returns the last DIFFERENT binding ([A,B,C]).
  const h2 = gate([A, B], [entry(C, { ...cRemoved, approvedAt: "later" }, cBound)]);
  t("H2 a further edit after the removal (the last different binding is still [A,B,C]) → refused", !h2.ok && /REMOVED/.test(h2.text), h2.text);
  const cValidRemoval = recOf(C, { supersedes: D1, decision: D2 });
  const h3 = gate([A, B], [entry(C, cValidRemoval, cBound)]);
  t("H3 removal with supersedes = D1 and decision D2, no other binding → [A,B] allowed", h3.ok, h3.text);
  t("H3b … and the old set does not resurrect: [A,B,C] is a plain prefix question again", gate([A, B, C], [entry(C, cValidRemoval, cBound)]).ok);
  const bStillBound = recOf(B, { releaseSet: [A, B, C] });
  const h4 = gate([A, B], [entry(C, cValidRemoval, cBound), entry(B, bStillBound)]);
  t("H4 C validly removed its binding but B still binds [A,B,C] → [A,B] refused", !h4.ok && /only a subset/.test(h4.text), h4.text);
  const h4b = gate([A, B], [entry(C, cValidRemoval, cBound), entry(B, recOf(B, { supersedes: D1, decision: D2 }), bStillBound)]);
  t("H4b … once B's binding is validly removed too → [A,B] allowed", h4b.ok, h4b.text);
  t("H5 a record whose history cannot be read refuses (no git / shallow clone)",
    !gate([A], [{ path: "ops/release-approvals/x.json", name: C, record: cBound, prev: { error: true } }]).ok);
  t("H6 a record unrelated to the request (no current or previous binding touching it) is not consulted",
    gate([D], [entry(C, cRemoved, cBound)]).ok);
  console.log(failed ? `\nrelease-migrate-gate self-test: ${failed} FAILED` : "\nrelease-migrate-gate self-test: all passed");
  return failed ? 1 : 0;
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!String(argv[i]).startsWith("--") || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "--self-test") process.exit(selfTest());
  const a = args(rest);
  if (a.expected === undefined) throw new Error('usage: release-migrate-gate.mjs plan|verify|stage|confirm --expected "<names>" [--pinned-sha <sha>] [--out <dir>]');
  const expected = parseExpected(a.expected);
  if (cmd === "plan") process.exit(await plan(expected));
  if (cmd === "verify") process.exit(await verify(expected));
  if (cmd === "stage") process.exit(await stage(expected, { pinned: a["pinned-sha"], out: a.out }));
  if (cmd === "confirm") process.exit(await confirm(expected, { out: a.out }));
  throw new Error(`unknown command ${cmd}`);
} catch (e) {
  console.error(`release-migrate-gate: could not evaluate — ${e.message}`);
  process.exit(2);
}
