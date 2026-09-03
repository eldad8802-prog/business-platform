/**
 * Release guard — deterministic decision matrix.
 *
 * WHY THIS EXISTS SEPARATELY FROM release-guard.self-test.mjs
 *
 * The self-test proves the ledger shapes and the wrapper's inverted exit codes.
 * This proves the other half of the contract — the half that was going to be
 * established by deploying a dozen times against Vercel:
 *
 *   - the real production attestation, unmodified, evaluates SAFE
 *   - a one-migration-short ledger evaluates BLOCKED, naming the migration
 *   - each authenticity condition rejects independently
 *   - the attestation is bound to the DEPLOYED TREE, not to a SHA string
 *
 * It needs no network, no database, no Vercel, and no deployment quota. The
 * production reading used here is the one published by run 33710533846; only
 * the migration-name list is kept, and those names are already public in this
 * repository.
 *
 * Run: node scripts/ci/release-guard.decision-matrix.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BLOCK_REASONS,
  evaluate,
  verifyRun,
  readRequiredMigrations,
} from "./release-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ─────────────────────────── the real inputs ─────────────────────────────── */

/** Every migration this commit requires, read exactly as the guard reads it. */
const REQUIRED = readRequiredMigrations(REPO_ROOT);

/** What production attested on 2026-09-03: the same 115 names. */
const REAL_APPLIED = [...REQUIRED];

const attestationOf = (over = {}) => ({
  attestationVersion: 1,
  generatedAt: "2026-09-03T03:19:31.705Z",
  source: {
    workflowPath: ".github/workflows/attest-production-migrations.yml",
    runId: "33710533846",
    commitSha: "81be6ef3ab7d541f60a02f59674978a74d539a3e",
  },
  ledger: {
    applied: REAL_APPLIED,
    inflight: [],
    rolledBackOnly: [],
    totalRows: REAL_APPLIED.length,
  },
  ...over,
});

const ledgerOf = (applied, over = {}) => ({
  applied,
  inflight: [],
  rolledBackOnly: [],
  totalRows: applied.length,
  ...over,
});

const ALLOWED = [
  ".github/workflows/release-migrate.yml",
  ".github/workflows/attest-production-migrations.yml",
];
const authenticRun = (over = {}) => ({
  id: 33710533846,
  path: ".github/workflows/attest-production-migrations.yml",
  conclusion: "success",
  head_branch: "main",
  event: "workflow_dispatch",
  ...over,
});

console.log(
  `\nRelease guard — decision matrix\n  required migrations in this commit: ${REQUIRED.length}\n`
);

/* ── A. SAFE: the real attestation against the real commit ────────────────── */

console.log("A. SAFE — real attestation, real commit");
{
  const r = evaluate({ required: REQUIRED, attestation: attestationOf() });
  ok("A1 115/115 -> SAFE", r.safe === true, r.reason);
  ok("A2 reason is SAFE_TO_DEPLOY", r.reason === "SAFE_TO_DEPLOY");
  ok("A3 required-but-not-applied is 0", !/not applied/.test(r.detail ?? ""));
  ok("A4 applied-but-not-in-repo is 0", r.ahead.length === 0, `ahead=${r.ahead.length}`);
  ok("A5 the two sets are the same size", REQUIRED.length === REAL_APPLIED.length);
}

/* ── B. BLOCKED: one migration short — fixture only, no database ──────────── */

console.log("\nB. BLOCKED — synthetic 114/115 (fixture; production untouched)");
{
  const victim = REQUIRED[REQUIRED.length - 1];
  const short = REAL_APPLIED.filter((m) => m !== victim);
  const r = evaluate({
    required: REQUIRED,
    attestation: attestationOf({ ledger: ledgerOf(short) }),
  });
  ok("B1 114/115 -> BLOCKED", r.safe === false);
  ok(
    "B2 reason is REQUIRED MIGRATION NOT APPLIED",
    r.reason === BLOCK_REASONS.NOT_APPLIED,
    r.reason
  );
  ok("B3 the detail names the exact missing migration", (r.detail ?? "").includes(victim), r.detail);
  ok("B4 the fixture really is one short", short.length === REQUIRED.length - 1);

  // Not only the newest one: a hole anywhere in the history blocks.
  const early = REAL_APPLIED.filter((m) => m !== REQUIRED[0]);
  const r2 = evaluate({
    required: REQUIRED,
    attestation: attestationOf({ ledger: ledgerOf(early) }),
  });
  ok(
    "B5 a missing OLD migration blocks just as hard",
    r2.safe === false && r2.reason === BLOCK_REASONS.NOT_APPLIED,
    r2.reason
  );
}

/* ── C. CANNOT_VERIFY matrix — V1..V6 ────────────────────────────────────── */

console.log("\nC. CANNOT_VERIFY — V1..V6");
{
  const v1 = evaluate({ required: REQUIRED, attestation: null });
  ok(
    "V1 missing attestation -> CANNOT_VERIFY",
    v1.safe === false && v1.reason === BLOCK_REASONS.CANNOT_VERIFY,
    v1.reason
  );

  // V2..V5 reject at the authenticity layer: fetchAttestation then returns no
  // payload at all, and main() maps every fetch failure to CANNOT_VERIFY.
  const v2 = verifyRun({ run: authenticRun({ conclusion: "failure" }), allowedWorkflowPaths: ALLOWED });
  ok("V2 failed run rejected", v2.ok === false && /conclusion is failure/.test(v2.detail), v2.detail);

  const v2b = verifyRun({ run: authenticRun({ conclusion: null }), allowedWorkflowPaths: ALLOWED });
  ok("V2b still-running run rejected", v2b.ok === false, v2b.detail);

  const v3 = verifyRun({
    run: authenticRun({ path: ".github/workflows/d2-p7-wave1-ci.yml" }),
    allowedWorkflowPaths: ALLOWED,
  });
  ok("V3 wrong workflow path rejected", v3.ok === false && /path not allowed/.test(v3.detail), v3.detail);

  const v4 = verifyRun({ run: authenticRun({ head_branch: "feat/anything" }), allowedWorkflowPaths: ALLOWED });
  ok("V4 wrong branch rejected", v4.ok === false && /branch is feat/.test(v4.detail), v4.detail);

  const v5 = verifyRun({ run: authenticRun({ event: "pull_request" }), allowedWorkflowPaths: ALLOWED });
  ok("V5 wrong event rejected", v5.ok === false && /event is pull_request/.test(v5.detail), v5.detail);

  ok(
    "V-control the unmodified run IS accepted",
    verifyRun({ run: authenticRun(), allowedWorkflowPaths: ALLOWED }).ok === true
  );

  // V6 — an unreadable or unknown payload is never read optimistically.
  const v6a = evaluate({ required: REQUIRED, attestation: attestationOf({ attestationVersion: 2 }) });
  ok("V6a unknown attestationVersion -> CANNOT_VERIFY", v6a.reason === BLOCK_REASONS.CANNOT_VERIFY, v6a.reason);

  const v6b = evaluate({ required: REQUIRED, attestation: attestationOf({ ledger: { applied: "115" } }) });
  ok("V6b malformed ledger -> CANNOT_VERIFY", v6b.reason === BLOCK_REASONS.CANNOT_VERIFY, v6b.reason);

  const v6c = evaluate({
    required: REQUIRED,
    attestation: attestationOf({
      ledger: ledgerOf(REAL_APPLIED, { inflight: ["20260902120000_d2_cutover2b_pilot_tenant_rls"] }),
    }),
  });
  ok(
    "V6c a migration in flight -> ANOMALY (blocks; never deploys mid-change)",
    v6c.safe === false && v6c.reason === BLOCK_REASONS.ANOMALY,
    v6c.reason
  );
}

/* ── D. SHA race — what the verdict is actually bound to ──────────────────── */

console.log("\nD. SHA RACE — the binding is the deployed TREE, not a SHA string");
{
  // ONE attestation, generated while main was at commit A. Several different
  // commits then ask to deploy against it.
  const attestationFromA = attestationOf();

  const root = mkdtempSync(join(tmpdir(), "guard-sha-"));
  let treeSeq = 0;
  const makeTree = (names) => {
    const dir = join(root, `tree-${(treeSeq += 1)}`);
    for (const n of names) {
      mkdirSync(join(dir, "prisma", "migrations", n), { recursive: true });
      writeFileSync(join(dir, "prisma", "migrations", n, "migration.sql"), "-- fixture\n");
    }
    return dir;
  };

  const treeOld = makeTree(REAL_APPLIED);
  const NEWCOMER = "20260904000000_a_migration_production_has_not_run";
  const treeNew = makeTree([...REAL_APPLIED, NEWCOMER]);

  const reqOld = readRequiredMigrations(treeOld);
  const reqNew = readRequiredMigrations(treeNew);
  ok("D1 the two checkouts really differ", reqNew.length === reqOld.length + 1, `${reqOld.length} vs ${reqNew.length}`);

  const rOld = evaluate({ required: reqOld, attestation: attestationFromA });
  const rNew = evaluate({ required: reqNew, attestation: attestationFromA });

  ok("D2 that attestation + the matching checkout -> SAFE", rOld.safe === true, rOld.reason);
  ok("D3 the SAME attestation + a NEWER checkout -> BLOCKED", rNew.safe === false, rNew.reason);
  ok("D4 and it names the migration the newer commit added", (rNew.detail ?? "").includes(NEWCOMER), rNew.detail);
  ok(
    "D5 one attestation, opposite verdicts — the binding is load-bearing",
    rOld.safe === true && rNew.safe === false
  );

  // The other direction: production AHEAD of the deployed commit is a revert,
  // and must stay deployable or a rollback is locked out.
  const treeReverted = makeTree(REAL_APPLIED.slice(0, -1));
  const rRev = evaluate({ required: readRequiredMigrations(treeReverted), attestation: attestationFromA });
  ok("D6 rolling back to an older commit -> SAFE (db may be ahead, never behind)", rRev.safe === true, rRev.reason);
  ok("D7 ...and the extra applied migration is reported, not blocking", rRev.ahead.length === 1, `ahead=${rRev.ahead.length}`);

  // What source.commitSha does NOT do. It is metadata: rewriting it moves no
  // verdict, because the checkout is what decides.
  const rSpoofed = evaluate({
    required: reqNew,
    attestation: attestationOf({
      source: { ...attestationFromA.source, commitSha: "deadbeef".repeat(5) },
    }),
  });
  ok(
    "D8 attestation.source.commitSha is metadata only — verdict unchanged",
    rSpoofed.safe === rNew.safe && rSpoofed.reason === rNew.reason
  );

  rmSync(root, { recursive: true, force: true });
}

console.log(
  failures.length === 0
    ? `\nDECISION MATRIX PASS — ${pass} checks green.\n`
    : `\nDECISION MATRIX FAIL — ${failures.length} failed of ${pass + failures.length}:\n` +
        failures.map((f) => `  - ${f}`).join("\n") +
        "\n"
);
process.exit(failures.length === 0 ? 0 : 1);
