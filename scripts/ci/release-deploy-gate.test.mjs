/**
 * Deterministic proofs for the pre-deployment gate.
 *
 * These are the P2 / P3 / P4 negative proofs, plus SAFE and same-SHA resume,
 * established without a Vercel deployment, without touching the production
 * database, and without inventing migration drift anywhere real. Every unsafe
 * case must end with `proceed === false`, because `proceed` is the only thing
 * standing between a workflow run and a created Deployment object.
 *
 * Run: node scripts/ci/release-deploy-gate.test.mjs
 */
import { decideRelease, OUTCOMES } from "./release-deploy-gate.mjs";
import { readRequiredMigrations } from "./release-guard.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

/* ── real inputs, so the fixtures cannot drift from reality ──────────────── */

const REQUIRED = readRequiredMigrations(REPO_ROOT);
const APPLIED = [...REQUIRED];

const SHA_A = "59e43321be83351d3f8398fbc6a0c5b4fe39a30c";
const SHA_B = "8ebe3de70000000000000000000000000000beef";

const attestation = (applied = APPLIED, over = {}) => ({
  attestationVersion: 1,
  generatedAt: "2026-09-03T03:19:31.705Z",
  source: { workflowPath: ".github/workflows/attest-production-migrations.yml", runId: "33710533846" },
  ledger: { applied, inflight: [], rolledBackOnly: [], totalRows: applied.length },
  ...over,
});

const base = {
  targetSha: SHA_A,
  checkoutSha: SHA_A,
  required: REQUIRED,
  attestation: attestation(),
  freshMain: SHA_A,
};

console.log(`\nrelease-deploy-gate — deterministic proofs\n  required migrations: ${REQUIRED.length}\n`);

/* ── P1 shape: everything correct ───────────────────────────────────────── */
console.log("P1 — SAFE (the only path that may deploy)");
{
  const r = decideRelease(base);
  ok("P1.1 proceed is true", r.proceed === true, r.detail);
  ok("P1.2 outcome is SAFE", r.outcome === OUTCOMES.SAFE, r.outcome);
  ok("P1.3 detail records the migration count and currency", /115 required/.test(r.detail) || /required migration/.test(r.detail), r.detail);
}

/* ── P2: BLOCKED ────────────────────────────────────────────────────────── */
console.log("\nP2 — BLOCKED (a required migration is not applied)");
{
  const victim = REQUIRED[REQUIRED.length - 1];
  const r = decideRelease({ ...base, attestation: attestation(APPLIED.filter((m) => m !== victim)) });
  ok("P2.1 proceed is FALSE — zero deployment", r.proceed === false);
  ok("P2.2 outcome is BLOCKED", r.outcome === OUTCOMES.BLOCKED, r.outcome);
  ok("P2.3 names the missing migration", r.detail.includes(victim), r.detail);

  const early = decideRelease({ ...base, attestation: attestation(APPLIED.filter((m) => m !== REQUIRED[0])) });
  ok("P2.4 an OLD missing migration blocks too", early.proceed === false && early.outcome === OUTCOMES.BLOCKED);

  const inflight = decideRelease({
    ...base,
    attestation: attestation(APPLIED, { ledger: { applied: APPLIED, inflight: [REQUIRED[0]], rolledBackOnly: [], totalRows: APPLIED.length } }),
  });
  ok("P2.5 a migration in flight blocks (ANOMALY -> BLOCKED)", inflight.proceed === false && inflight.outcome === OUTCOMES.BLOCKED, inflight.outcome);
}

/* ── P3: CANNOT_VERIFY ──────────────────────────────────────────────────── */
console.log("\nP3 — CANNOT_VERIFY (fail closed, never fail open)");
{
  const cases = [
    ["missing attestation", { attestation: null }],
    ["unknown attestation version", { attestation: attestation(APPLIED, { attestationVersion: 99 }) }],
    ["malformed ledger", { attestation: attestation(APPLIED, { ledger: { applied: "115" } }) }],
    ["target sha absent", { targetSha: "" }],
    ["target sha not a full sha", { targetSha: "59e4332" }],
    ["checkout sha absent", { checkoutSha: null }],
    ["fresh main undeterminable", { freshMain: null }],
  ];
  for (const [label, over] of cases) {
    const r = decideRelease({ ...base, ...over });
    ok(`P3 ${label} -> CANNOT_VERIFY, proceed false`,
       r.proceed === false && r.outcome === OUTCOMES.CANNOT_VERIFY,
       `${r.outcome}: ${r.detail}`);
  }
}

/* ── P4: STALE SHA ──────────────────────────────────────────────────────── */
console.log("\nP4 — STALE_RELEASE (safe, current-looking, but main moved)");
{
  const r = decideRelease({ ...base, freshMain: SHA_B });
  ok("P4.1 proceed is FALSE — zero deployment", r.proceed === false);
  ok("P4.2 outcome is STALE_RELEASE", r.outcome === OUTCOMES.STALE_RELEASE, r.outcome);
  ok("P4.3 detail names both SHAs", r.detail.includes(SHA_A.slice(0, 12)) && r.detail.includes(SHA_B.slice(0, 12)), r.detail);
  ok("P4.4 staleness is checked even though migrations were SAFE",
     decideRelease({ ...base, freshMain: SHA_B }).outcome === OUTCOMES.STALE_RELEASE);

  // The concurrency case: A is safe and was head when the run started; B is head now.
  const race = decideRelease({ targetSha: SHA_A, checkoutSha: SHA_A, required: REQUIRED, attestation: attestation(), freshMain: SHA_B });
  ok("P4.5 A cannot deploy over a newer B", race.proceed === false && race.outcome === OUTCOMES.STALE_RELEASE);
}

/* ── checkout integrity ─────────────────────────────────────────────────── */
console.log("\nCheckout integrity — the workspace must BE the target");
{
  const r = decideRelease({ ...base, checkoutSha: SHA_B });
  ok("C1 workspace != target -> refuse", r.proceed === false);
  ok("C2 outcome is CHECKOUT_SHA_MISMATCH", r.outcome === OUTCOMES.SHA_MISMATCH, r.outcome);
  ok("C3 mismatch is caught BEFORE the migration verdict is trusted",
     decideRelease({ ...base, checkoutSha: SHA_B, attestation: null }).outcome === OUTCOMES.SHA_MISMATCH);
}

/* ── same-SHA resume ────────────────────────────────────────────────────── */
console.log("\nResume — the same SHA becomes deployable once production catches up");
{
  const victim = REQUIRED[REQUIRED.length - 1];
  const before = decideRelease({ ...base, attestation: attestation(APPLIED.filter((m) => m !== victim)) });
  ok("R1 first attempt on X is BLOCKED", before.proceed === false && before.outcome === OUTCOMES.BLOCKED);

  // Nothing about X changes. Only production's ledger does.
  const after = decideRelease({ ...base, attestation: attestation(APPLIED) });
  ok("R2 same X, same checkout, no new commit -> SAFE", after.proceed === true, after.detail);
  ok("R3 resume needs no dummy commit — target is byte-identical",
     before.proceed === false && after.proceed === true && base.targetSha === SHA_A);

  // ...but only while X is still main.
  const movedOn = decideRelease({ ...base, attestation: attestation(APPLIED), freshMain: SHA_B });
  ok("R4 resume of X refuses once main has moved past it", movedOn.outcome === OUTCOMES.STALE_RELEASE);
}

/* ── fail-closed totality ───────────────────────────────────────────────── */
console.log("\nTotality — nothing returns proceed by omission");
{
  const hostile = [
    {}, { targetSha: SHA_A }, { targetSha: SHA_A, checkoutSha: SHA_A },
    { targetSha: SHA_A, checkoutSha: SHA_A, required: [] },
    { targetSha: SHA_A, checkoutSha: SHA_A, required: [], attestation: {} },
    { targetSha: undefined, checkoutSha: undefined, required: undefined, attestation: undefined, freshMain: undefined },
  ];
  let allRefused = true;
  for (const h of hostile) {
    let r;
    try { r = decideRelease(h); } catch { r = { proceed: false }; }
    if (r.proceed !== false) allRefused = false;
  }
  ok("T1 every incomplete/hostile input refuses", allRefused);
  ok("T2 an empty required set with a valid attestation is still gated on currency",
     decideRelease({ ...base, required: [], attestation: attestation([]), freshMain: SHA_B }).outcome === OUTCOMES.STALE_RELEASE);
}

console.log(
  failures.length === 0
    ? `\nRELEASE-DEPLOY-GATE: ${pass} passed, 0 failed.\n`
    : `\nRELEASE-DEPLOY-GATE: ${failures.length} FAILED of ${pass + failures.length}:\n` +
        failures.map((f) => `  - ${f}`).join("\n") + "\n"
);
process.exit(failures.length === 0 ? 0 : 1);
