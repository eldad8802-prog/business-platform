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
import {
  decideRelease, decideMigrationGate, decideFreshness,
  verifyArtifact, decidePostPromote, decideRemediationResult,
  OUTCOMES,
} from "./release-deploy-gate.mjs";
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

/* ── build then promote, as pure decisions ─────────────────────────────────
 *
 * The release now builds a production artifact that no domain points at, then
 * promotes it. Everything that decides whether that artifact may go live, and
 * what to do if the race crossed the promote boundary anyway, is decided here.
 */
console.log("\nArtifact verification — nothing unproven is ever promoted");
{
  const RUN = "1234567890";
  const ID = "dpl_realArtifact";
  const good = {
    id: ID, name: "business-platform-btrl", projectId: "prj_btrl",
    target: "production", readyState: "READY",
    meta: { releaseTargetSha: SHA_A, releaseWorkflowRunId: RUN },
  };
  const expected = {
    deploymentId: ID, projectName: "business-platform-btrl", projectId: "prj_btrl",
    targetSha: SHA_A, runId: RUN,
  };
  const v = (over) => verifyArtifact({ deployment: { ...good, ...over }, expected });

  ok("V1 a fully provenanced artifact verifies", v({}).ok === true);
  ok("V2 a different deployment id is refused", v({ id: "dpl_other" }).ok === false);
  ok("V3 another project's deployment is refused", v({ name: "business-platform" }).ok === false);
  ok("V4 another projectId is refused", v({ projectId: "prj_primary" }).ok === false);
  ok("V5 a preview-target deployment is refused", v({ target: "preview" }).ok === false);
  ok("V6 a not-yet-READY deployment is refused", v({ readyState: "BUILDING" }).ok === false);
  ok("V7 an artifact carrying another sha is refused",
     v({ meta: { releaseTargetSha: SHA_B, releaseWorkflowRunId: RUN } }).ok === false);
  ok("V8 an artifact built by another run is refused",
     v({ meta: { releaseTargetSha: SHA_A, releaseWorkflowRunId: "999" } }).ok === false);
  ok("V9 a missing payload is refused", verifyArtifact({ deployment: null, expected }).ok === false);
  ok("V10 every refusal reports ARTIFACT_UNVERIFIED",
     [v({ id: "x" }), v({ target: "preview" }), verifyArtifact({ deployment: null, expected })]
       .every((r) => r.outcome === OUTCOMES.ARTIFACT_UNVERIFIED));
}

console.log("\nPost-promote — detect the race, then undo it");
{
  const PROMOTED = "dpl_new";
  const PREV = "dpl_previous";
  const base = { targetSha: SHA_A, freshMain: SHA_A, promotedId: PROMOTED, productionId: PROMOTED, previousProductionId: PREV };
  const d = (over) => decidePostPromote({ ...base, ...over });

  ok("Q1 promoted, still main -> the release stands", d({}).ok === true && d({}).remediate === false);

  // The promotion did not take. Remediation is not the answer to that.
  ok("Q2 production pointing elsewhere is ALIAS_MISMATCH, not a revert",
     d({ productionId: "dpl_somethingelse" }).outcome === OUTCOMES.ALIAS_MISMATCH &&
     d({ productionId: "dpl_somethingelse" }).remediate === false);

  // The race we are here for.
  const raced = d({ freshMain: SHA_B });
  ok("Q3 main advancing across the promote boundary demands remediation", raced.remediate === true);
  ok("Q4 remediation restores the EXACT captured previous deployment", raced.restoreTo === PREV);
  ok("Q5 the raced outcome is STALE_AFTER_PROMOTE_REVERTED", raced.outcome === OUTCOMES.STALE_AFTER_PROMOTE_REVERTED);
  ok("Q6 a raced release is never reported ok", raced.ok === false);

  // Nothing to restore to: say so, do not improvise a target.
  const noPrev = d({ freshMain: SHA_B, previousProductionId: null });
  ok("Q7 drift with no captured predecessor fails as RECOVERY_FAILED",
     noPrev.outcome === OUTCOMES.STALE_AFTER_PROMOTE_RECOVERY_FAILED && noPrev.remediate === false);
  ok("Q8 a predecessor equal to the promoted artifact is refused as a restore target",
     d({ freshMain: SHA_B, previousProductionId: PROMOTED }).outcome === OUTCOMES.STALE_AFTER_PROMOTE_RECOVERY_FAILED);

  // After a good promote, an unreadable main must not trigger a revert.
  const blind = d({ freshMain: null });
  ok("Q9 an unreadable main after promote fails WITHOUT reverting",
     blind.ok === false && blind.remediate === false && blind.outcome === OUTCOMES.CANNOT_VERIFY);

  ok("Q10 a missing promoted id cannot be verified", d({ promotedId: "" }).outcome === OUTCOMES.CANNOT_VERIFY);

  // Remediation is judged by the resulting state, not by an exit code.
  ok("Q11 remediation succeeds only if production is the exact restore target",
     decideRemediationResult({ restoreTo: PREV, productionIdAfter: PREV }).outcome === OUTCOMES.STALE_AFTER_PROMOTE_REVERTED);
  ok("Q12 a restore that did not take is RECOVERY_FAILED",
     decideRemediationResult({ restoreTo: PREV, productionIdAfter: PROMOTED }).outcome === OUTCOMES.STALE_AFTER_PROMOTE_RECOVERY_FAILED);
  ok("Q13 a reverted release is never reported ok",
     decideRemediationResult({ restoreTo: PREV, productionIdAfter: PREV }).ok === false);
  ok("Q14 an unreadable production after restore is RECOVERY_FAILED",
     decideRemediationResult({ restoreTo: PREV, productionIdAfter: null }).outcome === OUTCOMES.STALE_AFTER_PROMOTE_RECOVERY_FAILED);
}

/* ── workflow ordering ──────────────────────────────────────────────────────
 *
 * The pure functions cannot protect the ordering that gives them their meaning.
 * These read release-deploy.yml as text and assert the structural properties
 * the design depends on. Text, not YAML, so this stays dependency-free.
 */
console.log("\nWorkflow ordering — the guarantees the pure functions cannot make");
{
  const wf = readFileSync(join(REPO_ROOT, ".github", "workflows", "release-deploy.yml"), "utf8");
  const lines = wf.split("\n");
  const code = lines.map((l) => (/^\s*#/.test(l) ? "" : l));
  const at = (re) => code.findIndex((l) => re.test(l));

  const decide = at(/release-deploy-gate\.mjs decide/);
  const firstToken = at(/VERCEL_TOKEN:/);
  const build = at(/vercel deploy /);
  const verify = at(/verifyArtifact\(/);
  const capturePrev = at(/targets\?\.production\?\.id/);
  const freshness = at(/release-deploy-gate\.mjs freshness/);
  const promote = at(/^\s*vercel promote "\$DEPLOYMENT_ID"/);
  const postFresh = at(/decidePostPromote\(/);
  const restore = at(/^\s*vercel promote "\$RESTORE"/);

  ok("W1 every stage of the release is present",
     [decide, firstToken, build, verify, capturePrev, freshness, promote, postFresh, restore].every((i) => i > 0),
     JSON.stringify({ decide, firstToken, build, verify, capturePrev, freshness, promote, postFresh, restore }));

  // A block must cost zero Vercel contact, so the migration verdict has to be
  // reached before the first step that is even handed a credential. This is the
  // single assertion behind "BLOCKED and CANNOT_VERIFY create no deployment".
  ok("W2 the migration gate runs before any step reads VERCEL_TOKEN", decide < firstToken);
  ok("W3 nothing builds before the migration gate", decide < build);

  // Build with the production target but no alias, so finishing the build does
  // not put anything live.
  ok("W4 the build uses --prod and --skip-domain",
     /vercel deploy --prod --skip-domain/.test(code[build] ?? ""), code[build]);
  ok("W5 there is exactly one build command",
     code.filter((l) => /vercel deploy /.test(l)).length === 1);

  ok("W6 the artifact is verified before it is promoted", verify < promote);
  ok("W7 the previous production deployment is captured before promoting", capturePrev < promote);
  ok("W8 final freshness precedes the promote", freshness < promote);

  // Nothing may sit between the freshness answer and the alias flip.
  const between = code.slice(freshness + 1, promote);
  ok("W9 no step boundary between freshness and promote",
     !between.some((l) => /^\s{6}- (name|uses):/.test(l)), JSON.stringify(between.filter((l) => l.trim())));
  ok("W10 nothing at all runs between freshness and promote",
     between.every((l) => l.trim() === ""), JSON.stringify(between.filter((l) => l.trim())));

  // The promote must name the artifact this run built and verified. A promote
  // of "latest", of the project, or of the working directory is a different and
  // unprovable act.
  ok("W11 promote names the exact verified deployment id",
     /vercel promote "\$DEPLOYMENT_ID"/.test(code[promote] ?? ""), code[promote]);
  ok("W12 no promote of a latest/implicit target",
     !code.some((l) => /vercel (promote|rollback)\s*(--|$)/.test(l)) &&
     !code.some((l) => /vercel rollback/.test(l)));
  ok("W13 every promote names an explicit id",
     code.filter((l) => /vercel promote/.test(l))
         .every((l) => /vercel promote "\$(DEPLOYMENT_ID|RESTORE)"/.test(l)));

  // Remediation restores the captured predecessor, never a computed one.
  ok("W14 drift is re-checked after the promote", promote < postFresh);
  ok("W15 the restore target is read from the post-promote verdict, not improvised",
     /RESTORE="\$\(field restoreTo\)"/.test(wf) && /vercel promote "\$RESTORE"/.test(code[restore] ?? ""));
  ok("W16 the restore target comes from the pre-promote capture",
     /PREV_PROD_ID: \$\{\{ steps\.prev\.outputs\.id \}\}/.test(wf));

  // A step that can continue past a failed check is a bypass.
  const stepStarts = code.map((l, i) => (/^\s{6}- name:/.test(l) ? i : -1)).filter((i) => i >= 0);
  const stepOf = (i) => stepStarts.filter((s) => s <= i).pop();
  for (const [label, idx] of [["promote", freshness], ["post-promote", postFresh]]) {
    const s = stepOf(idx);
    ok(`W17-${label} the step aborts on error (set -e)`,
       code.slice(s, idx).some((l) => /set -euo pipefail/.test(l)));
  }
  ok("W18 the post-promote step fails the run on an unremediated outcome",
     /exit 1/.test(code.slice(stepOf(postFresh)).join("\n")));

  // No pre-promote step may be skippable.
  ok("W19 no step before the promote is conditional",
     !code.slice(0, stepOf(promote)).some((l) => /^\s{8}if:/.test(l)));

  // Credentials stay bound to the pilot, in code, not by configuration alone.
  ok("W20 the workflow refuses any project that is not business-platform-btrl",
     /!= "business-platform-btrl"/.test(wf) && /projectName: "business-platform-btrl"/.test(wf));
  ok("W21 releases serialise and are never cancelled mid-flight",
     /cancel-in-progress: false/.test(wf));
  ok("W22 the environment name is pure ASCII",
     /environment: 'production-btrl-release'/.test(wf) &&
     !/[^\x00-\x7F]/.test(lines[at(/^\s*environment:/)] ?? ""));
}

console.log(
  failures.length === 0
    ? `\nRELEASE-DEPLOY-GATE: ${pass} passed, 0 failed.\n`
    : `\nRELEASE-DEPLOY-GATE: ${failures.length} FAILED of ${pass + failures.length}:\n` +
        failures.map((f) => `  - ${f}`).join("\n") + "\n"
);
process.exit(failures.length === 0 ? 0 : 1);
