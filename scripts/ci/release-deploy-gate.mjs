/**
 * The pre-deployment release gate.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT THE IGNORED BUILD STEP
 *
 * The same decision already runs inside Vercel as an Ignored Build Step. That
 * placement is sound but late: Vercel creates the Deployment object first and
 * only then runs the ignore command, so a refusal there is a deployment that
 * exists, was created, and then cancelled. What we need is for an unsafe
 * release to never become a deployment at all. That can only be decided BEFORE
 * anyone asks Vercel to deploy — which means here, in CI, with the Vercel
 * project deliberately disconnected from Git so that nothing else can create
 * deployments behind our back.
 *
 * WHAT IS REUSED AND WHAT IS NEW
 *
 * The migration decision itself is NOT reimplemented. `evaluate()`,
 * `verifyRun()`, `fetchAttestation()` and `readRequiredMigrations()` are
 * imported from release-guard.mjs — the same functions the Vercel-side guard
 * used, and the same ones covered by release-guard.self-test.mjs. This module
 * adds only what the deployment boundary needs and the build-step boundary
 * cannot have:
 *
 *   - the deployed commit is pinned and PROVEN to be what was checked out
 *   - the pinned commit is still the head of main at the moment of deploying
 *
 * ORDER IS THE CONTRACT
 *
 *   1. the checkout really is TARGET_SHA
 *   2. required migrations are read from THAT checkout
 *   3. attestation obtained and its producing run proven authentic
 *   4. evaluate -> must be SAFE (BLOCKED and CANNOT_VERIFY both stop)
 *   5. only then: re-read origin/main and require it still equals TARGET_SHA
 *   6. only then may a deployment be created
 *
 * Step 5 is deliberately after step 4: a stale release is not more acceptable
 * because it is safe, and an unsafe release is not more acceptable because it
 * is current. Both must hold, and neither check is allowed to be skipped by the
 * other failing first.
 *
 * TWO PHASES, AND WHY
 *
 * Steps 1-4 run as phase `decide`. Step 5 runs as phase `freshness`, inside the
 * same shell as, and immediately before, the `vercel deploy` command. The split
 * exists for two reasons that pull in the same direction:
 *
 *   - Nothing may sit between the freshness answer and the deployment call.
 *     Every install, network round-trip or project lookup in that gap is time
 *     for main to move. So `freshness` is the last thing to run before deploy,
 *     with no step boundary in between.
 *   - The migration verdict must not depend on Vercel credentials. `decide`
 *     runs before anything reads VERCEL_TOKEN, so a BLOCKED release is proven
 *     with zero Vercel contact — not even a read.
 *
 * This narrows the race but does NOT eliminate it: GitHub's ref state and
 * Vercel's deployment API are two systems with no shared transaction, so there
 * is no atomic compare-and-swap between "main is still X" and "deploy X". The
 * residual window is one process boundary. It is not zero, and this file does
 * not claim it is.
 *
 * `decideRelease()` remains the composition of both phases and is the single
 * canonical statement of the whole decision.
 *
 * Every failure is fail-closed: `proceed` is false unless every gate passed.
 */

import { evaluate, readRequiredMigrations, BLOCK_REASONS } from "./release-guard.mjs";

export const OUTCOMES = {
  SAFE: "SAFE",
  BLOCKED: "BLOCKED",
  CANNOT_VERIFY: "CANNOT_VERIFY",
  STALE_RELEASE: "STALE_RELEASE",
  SHA_MISMATCH: "CHECKOUT_SHA_MISMATCH",
  // build -> promote outcomes
  ARTIFACT_UNVERIFIED: "ARTIFACT_UNVERIFIED",
  ALIAS_MISMATCH: "ALIAS_MISMATCH",
  STALE_AFTER_PROMOTE_REVERTED: "STALE_AFTER_PROMOTE_REVERTED",
  STALE_AFTER_PROMOTE_RECOVERY_FAILED: "STALE_AFTER_PROMOTE_RECOVERY_FAILED",
};

const isSha = (s) => typeof s === "string" && /^[0-9a-f]{40}$/i.test(s);

/**
 * The whole pre-deployment decision, as a pure function.
 *
 * `targetSha`   — the commit this run intends to deploy.
 * `checkoutSha` — what `git rev-parse HEAD` actually reports in the workspace.
 * `required`    — migration names read from that checkout.
 * `attestation` — parsed payload, or null when it could not be obtained.
 * `freshMain`   — origin/main re-read immediately before deploying.
 */
export function decideRelease({ targetSha, checkoutSha, required, attestation, freshMain }) {
  const gate = decideMigrationGate({ targetSha, checkoutSha, required, attestation });
  if (!gate.proceed) return gate;

  const fresh = decideFreshness({ targetSha, freshMain });
  if (!fresh.proceed) return fresh;

  return {
    proceed: true,
    outcome: OUTCOMES.SAFE,
    detail: `${required.length} required migration(s) applied; ${targetSha.slice(0, 12)} is current origin/main`,
    ahead: gate.ahead,
  };
}

/**
 * Phase 1 — everything that can be decided without Vercel and without knowing
 * what main looks like right now: the workspace is the target, and production
 * has the migrations this commit requires.
 *
 * Deliberately credential-free. A BLOCKED verdict here is reached before any
 * step has read VERCEL_TOKEN, which is what makes "zero Vercel contact on a
 * block" a property of the ordering rather than a hope.
 */
export function decideMigrationGate({ targetSha, checkoutSha, required, attestation }) {
  const stop = (outcome, detail) => ({ proceed: false, outcome, detail });

  // A run that cannot even name what it is deploying has nothing to verify.
  if (!isSha(targetSha)) {
    return stop(OUTCOMES.CANNOT_VERIFY, `target SHA is not a full commit sha: ${JSON.stringify(targetSha)}`);
  }
  if (!isSha(checkoutSha)) {
    return stop(OUTCOMES.CANNOT_VERIFY, `checkout SHA is not a full commit sha: ${JSON.stringify(checkoutSha)}`);
  }

  // The guard reads migrations off the working tree, so a workspace that is not
  // the commit we claim to deploy would verify the wrong thing entirely.
  if (targetSha.toLowerCase() !== checkoutSha.toLowerCase()) {
    return stop(
      OUTCOMES.SHA_MISMATCH,
      `workspace is ${checkoutSha}, expected ${targetSha}`
    );
  }

  // Reuse the guard verbatim. No second opinion, no parallel implementation.
  const verdict = evaluate({ required, attestation });
  if (!verdict.safe) {
    const outcome =
      verdict.reason === BLOCK_REASONS.NOT_APPLIED || verdict.reason === BLOCK_REASONS.ANOMALY
        ? OUTCOMES.BLOCKED
        : OUTCOMES.CANNOT_VERIFY;
    return stop(outcome, `${verdict.reason}: ${verdict.detail}`);
  }

  return {
    proceed: true,
    outcome: OUTCOMES.SAFE,
    detail: `${required.length} required migration(s) all applied`,
    ahead: verdict.ahead,
  };
}

/**
 * Phase 2 — the last question, asked as late as possible: is the commit we are
 * about to put live still the head of main?
 *
 * Safe but stale is still refused. A run that started on X while main has moved
 * to Y must not put X live over Y.
 */
export function decideFreshness({ targetSha, freshMain }) {
  const stop = (outcome, detail) => ({ proceed: false, outcome, detail });

  if (!isSha(targetSha)) {
    return stop(OUTCOMES.CANNOT_VERIFY, `target SHA is not a full commit sha: ${JSON.stringify(targetSha)}`);
  }
  if (!isSha(freshMain)) {
    return stop(OUTCOMES.CANNOT_VERIFY, `could not determine origin/main: ${JSON.stringify(freshMain)}`);
  }
  if (freshMain.toLowerCase() !== targetSha.toLowerCase()) {
    return stop(
      OUTCOMES.STALE_RELEASE,
      `target ${targetSha.slice(0, 12)} is no longer origin/main (${freshMain.slice(0, 12)})`
    );
  }

  return {
    proceed: true,
    outcome: OUTCOMES.SAFE,
    detail: `${targetSha.slice(0, 12)} is current origin/main`,
  };
}

/* --------------------------------------------------- build -> promote -- */

/**
 * Phase 2a — is the thing we are about to make live actually the thing this
 * run built?
 *
 * `vercel deploy --prod --skip-domain` produces a real production-target
 * deployment that no domain points at yet. Between building it and promoting
 * it, every claim about that artifact is re-read from the Vercel API and
 * checked here. Nothing is inferred from the CLI's stdout.
 *
 * Every field is mandatory. An artifact whose provenance cannot be proven is
 * not promoted — there is no "probably ours" branch.
 */
export function verifyArtifact({ deployment, expected }) {
  const stop = (detail) => ({ ok: false, outcome: OUTCOMES.ARTIFACT_UNVERIFIED, detail });

  if (!deployment || typeof deployment !== "object") return stop("no deployment payload");
  if (!expected || typeof expected !== "object") return stop("no expectation to check against");

  const id = deployment.id ?? deployment.uid ?? null;
  const meta = deployment.meta ?? {};

  const checks = [
    [typeof id === "string" && id.length > 0, `deployment has no id`],
    [id === expected.deploymentId, `deployment id ${id} is not the artifact this run built (${expected.deploymentId})`],
    [deployment.name === expected.projectName, `deployment belongs to project ${JSON.stringify(deployment.name)}, expected ${JSON.stringify(expected.projectName)}`],
    [deployment.projectId === expected.projectId, `deployment projectId ${JSON.stringify(deployment.projectId)} is not the expected project`],
    [deployment.target === "production", `deployment target is ${JSON.stringify(deployment.target)}, expected production`],
    [(deployment.readyState ?? deployment.status) === "READY", `deployment state is ${JSON.stringify(deployment.readyState ?? deployment.status)}, not READY`],
    [meta.releaseTargetSha === expected.targetSha, `deployment carries sha ${JSON.stringify(meta.releaseTargetSha)}, expected ${expected.targetSha}`],
    [meta.releaseWorkflowRunId === expected.runId, `deployment was built by run ${JSON.stringify(meta.releaseWorkflowRunId)}, not this one (${expected.runId})`],
  ];
  for (const [ok, detail] of checks) if (!ok) return stop(detail);

  return { ok: true, outcome: OUTCOMES.SAFE, detail: `artifact ${id} verified: production, READY, ${expected.targetSha.slice(0, 12)}, this run` };
}

/**
 * Phase 4 — what the post-promote observation means.
 *
 * The promote boundary is the one place a race can still cross: main can move
 * between the freshness check and the alias flip. This decides, from what was
 * observed after the flip, whether that happened and what must be done.
 *
 * Deliberately NOT symmetric with the pre-promote check. Before promoting, the
 * safe answer to "I cannot tell" is to stop. After promoting, reverting a
 * release we cannot prove is stale would itself be an unsafe act, so an
 * unreadable main fails the run WITHOUT remediation and says so.
 */
export function decidePostPromote({ targetSha, freshMain, promotedId, productionId, previousProductionId }) {
  const out = (outcome, detail, extra = {}) => ({ ok: false, remediate: false, restoreTo: null, outcome, detail, ...extra });

  if (typeof promotedId !== "string" || promotedId.length === 0) {
    return out(OUTCOMES.CANNOT_VERIFY, "no promoted deployment id to verify");
  }

  // Did the promotion actually take effect? If production points somewhere
  // else, the release did not happen and remediation is not the answer.
  if (productionId !== promotedId) {
    return out(
      OUTCOMES.ALIAS_MISMATCH,
      `production points at ${JSON.stringify(productionId)}, not the promoted artifact ${promotedId}`
    );
  }

  if (!isSha(targetSha)) return out(OUTCOMES.CANNOT_VERIFY, `target sha unusable: ${JSON.stringify(targetSha)}`);

  // Unreadable main after a successful promote: report, never auto-revert.
  if (!isSha(freshMain)) {
    return out(OUTCOMES.CANNOT_VERIFY, `could not re-read origin/main after promote: ${JSON.stringify(freshMain)}`);
  }

  if (freshMain.toLowerCase() === targetSha.toLowerCase()) {
    return { ok: true, remediate: false, restoreTo: null, outcome: OUTCOMES.SAFE, detail: `${targetSha.slice(0, 12)} promoted and still origin/main` };
  }

  // The race happened. Remediation must name the exact deployment that was
  // production before this run touched it — never "the latest", never "the
  // previous one" as Vercel computes it.
  if (typeof previousProductionId !== "string" || previousProductionId.length === 0) {
    return out(
      OUTCOMES.STALE_AFTER_PROMOTE_RECOVERY_FAILED,
      `main advanced to ${freshMain.slice(0, 12)} across the promote boundary, and no previous production deployment was captured to restore`
    );
  }
  if (previousProductionId === promotedId) {
    return out(
      OUTCOMES.STALE_AFTER_PROMOTE_RECOVERY_FAILED,
      `main advanced to ${freshMain.slice(0, 12)}, but the captured previous production deployment is the one just promoted`
    );
  }

  return {
    ok: false,
    remediate: true,
    restoreTo: previousProductionId,
    outcome: OUTCOMES.STALE_AFTER_PROMOTE_REVERTED,
    detail: `main advanced to ${freshMain.slice(0, 12)} across the promote boundary; restoring production to ${previousProductionId}`,
  };
}

/**
 * Phase 5 — did the remediation actually put production back?
 *
 * Success is not "the command exited zero". It is "production now points at
 * the exact deployment we captured before promoting".
 */
export function decideRemediationResult({ restoreTo, productionIdAfter }) {
  if (typeof restoreTo !== "string" || restoreTo.length === 0) {
    return { ok: false, outcome: OUTCOMES.STALE_AFTER_PROMOTE_RECOVERY_FAILED, detail: "no restore target" };
  }
  if (productionIdAfter !== restoreTo) {
    return {
      ok: false,
      outcome: OUTCOMES.STALE_AFTER_PROMOTE_RECOVERY_FAILED,
      detail: `restore did not take: production is ${JSON.stringify(productionIdAfter)}, expected ${restoreTo}`,
    };
  }
  return {
    ok: false,
    outcome: OUTCOMES.STALE_AFTER_PROMOTE_REVERTED,
    detail: `production restored to ${restoreTo}; the release did not stand`,
  };
}

/* ------------------------------------------------------------------- main -- */

async function main() {
  const { execFileSync } = await import("node:child_process");
  const { appendFileSync } = await import("node:fs");
  const { fetchAttestation } = await import("./release-guard.mjs");

  const targetSha = (process.env.TARGET_SHA ?? "").trim();
  const repo = process.env.RELEASE_GUARD_REPO;
  const token = process.env.RELEASE_GUARD_GITHUB_TOKEN;
  const artifactName = process.env.RELEASE_GUARD_ARTIFACT_NAME || "production-migration-attestation";
  const allowedWorkflowPaths = (
    process.env.RELEASE_GUARD_ALLOWED_WORKFLOWS ||
    ".github/workflows/release-migrate.yml,.github/workflows/attest-production-migrations.yml"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

  const emit = (result, extra = {}) => {
    const line = `release-deploy-gate: ${result.outcome} — ${result.detail}`;
    console.log(line);
    const out = process.env.GITHUB_OUTPUT;
    if (out) {
      appendFileSync(out, `proceed=${result.proceed ? "true" : "false"}\n`);
      appendFileSync(out, `outcome=${result.outcome}\n`);
      appendFileSync(out, `detail=${result.detail.replace(/\n/g, " ")}\n`);
      for (const [k, v] of Object.entries(extra)) appendFileSync(out, `${k}=${v}\n`);
    }
    // Non-zero on refusal so the job stops even if a later step forgets to check.
    process.exit(result.proceed ? 0 : 2);
  };

  // `decide` (default) answers the migration question with no Vercel contact.
  // `freshness` answers only "is the target still main?", and is invoked from
  // inside the deploy step so nothing can run between the answer and the deploy.
  const phase = (process.argv[2] ?? "decide").trim();
  if (phase !== "decide" && phase !== "freshness") {
    console.error(`release-deploy-gate: unknown phase ${JSON.stringify(phase)} (expected decide|freshness)`);
    process.exit(2);
  }

  if (phase === "freshness") {
    let freshMain = null;
    try {
      git("fetch", "origin", "main", "--quiet");
      freshMain = git("rev-parse", "origin/main");
    } catch (err) {
      emit({ proceed: false, outcome: OUTCOMES.CANNOT_VERIFY, detail: `could not fetch origin/main: ${err?.message ?? err}` });
    }
    console.log(`release-deploy-gate: fresh origin/main=${freshMain}`);
    emit(decideFreshness({ targetSha, freshMain }), { fresh_main: String(freshMain) });
    return;
  }

  const checkoutSha = git("rev-parse", "HEAD");
  const required = readRequiredMigrations(process.cwd());
  console.log(`release-deploy-gate: target=${targetSha} checkout=${checkoutSha} required=${required.length}`);

  if (!repo || !token) {
    emit({ proceed: false, outcome: OUTCOMES.CANNOT_VERIFY, detail: "RELEASE_GUARD_REPO / _GITHUB_TOKEN not set" });
  }

  let fetched = null;
  try {
    fetched = await fetchAttestation({ repo, token, artifactName, allowedWorkflowPaths });
    console.log(
      `release-deploy-gate: attestation run=${fetched.run.id} workflow=${fetched.run.path} ` +
        `generatedAt=${fetched.attestation.generatedAt}`
    );
  } catch (err) {
    emit({ proceed: false, outcome: OUTCOMES.CANNOT_VERIFY, detail: err?.message ?? String(err) });
  }

  emit(decideMigrationGate({ targetSha, checkoutSha, required, attestation: fetched.attestation }), {
    target_sha: targetSha,
    checkout_sha: checkoutSha,
    required_count: String(required.length),
    attestation_run: String(fetched.run.id),
    attestation_generated_at: fetched.attestation.generatedAt,
  });
}

if (process.argv[1] && process.argv[1].endsWith("release-deploy-gate.mjs")) {
  main().catch((err) => {
    // Nothing may reach here and look like permission to deploy.
    console.error(`release-deploy-gate: ${OUTCOMES.CANNOT_VERIFY} — unexpected ${err?.message ?? err}`);
    process.exit(2);
  });
}
