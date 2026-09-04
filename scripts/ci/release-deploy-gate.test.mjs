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
import { decideRelease, decideMigrationGate, decideFreshness, OUTCOMES } from "./release-deploy-gate.mjs";
import { readRequiredMigrations } from "./release-guard.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

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

/* ── phase split ────────────────────────────────────────────────────────────
 *
 * The workflow runs the decision in two phases so that (a) a block costs zero
 * Vercel contact and needs no Vercel credential, and (b) nothing sits between
 * the freshness answer and the deploy command. These prove the split did not
 * change the decision, and that each phase refuses on its own.
 */
console.log("\nPhase split — decide and freshness, composed");
{
  // Phase 1 must reach a verdict without ever being told what main looks like.
  const blockedNoMain = decideMigrationGate({
    targetSha: SHA_A, checkoutSha: SHA_A,
    required: REQUIRED, attestation: attestation(REQUIRED.slice(0, -1)),
  });
  ok("S1 migration gate blocks without any knowledge of origin/main",
     blockedNoMain.proceed === false && blockedNoMain.outcome === OUTCOMES.BLOCKED);

  ok("S2 migration gate passes on a fully applied ledger",
     decideMigrationGate({ targetSha: SHA_A, checkoutSha: SHA_A, required: REQUIRED, attestation: attestation() }).proceed === true);

  ok("S3 migration gate still catches a checkout mismatch",
     decideMigrationGate({ targetSha: SHA_A, checkoutSha: SHA_B, required: REQUIRED, attestation: attestation() }).outcome === OUTCOMES.SHA_MISMATCH);

  ok("S4 migration gate refuses a malformed attestation",
     decideMigrationGate({ targetSha: SHA_A, checkoutSha: SHA_A, required: REQUIRED, attestation: {} }).outcome === OUTCOMES.CANNOT_VERIFY);

  ok("S5 migration gate refuses an inflight ledger",
     decideMigrationGate({ targetSha: SHA_A, checkoutSha: SHA_A, required: REQUIRED, attestation: attestation(APPLIED, { ledger: { applied: APPLIED, inflight: ["x"], rolledBackOnly: [], totalRows: APPLIED.length } }) }).outcome === OUTCOMES.BLOCKED);

  ok("S6 freshness alone accepts the current head", decideFreshness({ targetSha: SHA_A, freshMain: SHA_A }).proceed === true);
  ok("S7 freshness alone refuses a moved head",
     decideFreshness({ targetSha: SHA_A, freshMain: SHA_B }).outcome === OUTCOMES.STALE_RELEASE);
  ok("S8 freshness refuses an unreadable origin/main",
     decideFreshness({ targetSha: SHA_A, freshMain: null }).outcome === OUTCOMES.CANNOT_VERIFY);

  // Composition equivalence: the two phases together must agree with the
  // canonical whole-decision function on every combination that matters.
  const cases = [
    { name: "safe+current", att: attestation(), fresh: SHA_A },
    { name: "safe+moved", att: attestation(), fresh: SHA_B },
    { name: "blocked+current", att: attestation(REQUIRED.slice(0, -1)), fresh: SHA_A },
    { name: "blocked+moved", att: attestation(REQUIRED.slice(0, -1)), fresh: SHA_B },
    { name: "malformed+current", att: {}, fresh: SHA_A },
  ];
  let agree = true;
  for (const c of cases) {
    const whole = decideRelease({ targetSha: SHA_A, checkoutSha: SHA_A, required: REQUIRED, attestation: c.att, freshMain: c.fresh });
    const g = decideMigrationGate({ targetSha: SHA_A, checkoutSha: SHA_A, required: REQUIRED, attestation: c.att });
    const composed = !g.proceed ? g : decideFreshness({ targetSha: SHA_A, freshMain: c.fresh });
    if (whole.outcome !== composed.outcome || whole.proceed !== composed.proceed) agree = false;
  }
  ok("S9 phase composition agrees with decideRelease on every combination", agree);

  // The property the whole design rests on: an unsafe migration state is
  // refused by phase 1, which is the phase that runs before any Vercel step.
  const unsafeStates = [
    attestation(REQUIRED.slice(0, -1)),
    attestation(APPLIED, { ledger: { applied: APPLIED, inflight: ["mid"], rolledBackOnly: [], totalRows: 1 } }),
    attestation(APPLIED, { attestationVersion: 99 }),
    attestation(APPLIED, { ledger: null }),
    null,
    {},
  ];
  ok("S10 every unsafe migration state is refused in the credential-free phase",
     unsafeStates.every((a) => decideMigrationGate({ targetSha: SHA_A, checkoutSha: SHA_A, required: REQUIRED, attestation: a }).proceed === false));
}

/* ── workflow ordering ──────────────────────────────────────────────────────
 *
 * The pure functions above cannot protect the ordering that gives them their
 * meaning. These read release-deploy.yml as text and assert the two structural
 * properties the design depends on. Text, not YAML, so this stays dependency-
 * free and runnable before `npm ci` if it ever needs to be.
 */
console.log("\nWorkflow ordering — the guarantees the pure functions cannot make");
{
  const wf = readFileSync(join(REPO_ROOT, ".github", "workflows", "release-deploy.yml"), "utf8");
  const lines = wf.split("\n");
  const at = (re) => lines.findIndex((l) => re.test(l));

  const decide = at(/release-deploy-gate\.mjs decide/);
  const freshness = at(/release-deploy-gate\.mjs freshness/);
  const deploy = at(/^\s*URL="\$\(vercel deploy/);
  const firstToken = at(/VERCEL_TOKEN:/);

  ok("W1 the workflow invokes the decide phase", decide > 0);
  ok("W2 the workflow invokes the freshness phase", freshness > 0);
  // Comment lines are excluded: prose may discuss the deploy, only one line may
  // perform it.
  const executable = lines.filter((l) => !/^\s*#/.test(l));
  ok("W3 the workflow contains exactly one vercel deploy command",
     deploy > 0 && executable.filter((l) => /vercel deploy/.test(l)).length === 1);

  // A block must cost zero Vercel contact, so the migration gate has to be
  // decided before the first step that is even handed a Vercel credential.
  ok("W4 the migration gate runs before any step reads VERCEL_TOKEN",
     decide < firstToken, `decide@${decide} firstToken@${firstToken}`);

  // Nothing may sit between the freshness answer and the deploy command.
  ok("W5 freshness is checked before the deploy command", freshness < deploy);

  const between = lines.slice(freshness + 1, deploy);
  ok("W6 no step boundary between freshness and deploy",
     !between.some((l) => /^\s{6}- name:/.test(l) || /^\s{6}- uses:/.test(l)),
     JSON.stringify(between.filter((l) => l.trim())));
  ok("W7 nothing at all runs between freshness and deploy",
     between.every((l) => l.trim() === ""), JSON.stringify(between.filter((l) => l.trim())));

  // Without `set -e` a non-zero freshness exit would be ignored and the very
  // next line would deploy a stale commit.
  const stepStart = lines.slice(0, freshness).map((l, i) => (/^\s{6}- name:/.test(l) ? i : -1)).filter((i) => i >= 0).pop();
  ok("W8 the deploy step aborts on error (set -e) before reaching deploy",
     lines.slice(stepStart, freshness).some((l) => /set -euo pipefail/.test(l)));

  // A skippable pre-deploy step is a bypass. None of them may carry an `if:`.
  const deployStepStart = stepStart;
  ok("W9 no pre-deploy step is conditional",
     !lines.slice(0, deployStepStart).some((l) => /^\s{8}if:/.test(l)));

  ok("W10 the environment name is pure ASCII",
     /environment: 'production-btrl-release'/.test(wf) && !/[^\x00-\x7F]/.test(
       lines[at(/^\s*environment:/)] ?? ""));
}

console.log(
  failures.length === 0
    ? `\nRELEASE-DEPLOY-GATE: ${pass} passed, 0 failed.\n`
    : `\nRELEASE-DEPLOY-GATE: ${failures.length} FAILED of ${pass + failures.length}:\n` +
        failures.map((f) => `  - ${f}`).join("\n") + "\n"
);
process.exit(failures.length === 0 ? 0 : 1);
