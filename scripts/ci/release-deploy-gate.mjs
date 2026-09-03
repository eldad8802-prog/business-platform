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
 * uses and the same ones covered by release-guard.self-test.mjs and
 * release-guard.decision-matrix.mjs. This module adds only what the deployment
 * boundary needs and the build-step boundary cannot have:
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
 * Every failure is fail-closed: `proceed` is false unless every gate passed.
 */

import { evaluate, readRequiredMigrations, BLOCK_REASONS } from "./release-guard.mjs";

export const OUTCOMES = {
  SAFE: "SAFE",
  BLOCKED: "BLOCKED",
  CANNOT_VERIFY: "CANNOT_VERIFY",
  STALE_RELEASE: "STALE_RELEASE",
  SHA_MISMATCH: "CHECKOUT_SHA_MISMATCH",
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

  // Safe, but possibly no longer the release anyone wants. A run that started
  // on X while main has moved to Y must not put X live over Y.
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
    detail: `${required.length} required migration(s) applied; ${targetSha.slice(0, 12)} is current origin/main`,
    ahead: verdict.ahead,
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

  // Re-read main only now, as late as possible before the deployment call.
  let freshMain = null;
  try {
    git("fetch", "origin", "main", "--quiet");
    freshMain = git("rev-parse", "origin/main");
  } catch (err) {
    emit({ proceed: false, outcome: OUTCOMES.CANNOT_VERIFY, detail: `could not fetch origin/main: ${err?.message ?? err}` });
  }
  console.log(`release-deploy-gate: fresh origin/main=${freshMain}`);

  const result = decideRelease({
    targetSha,
    checkoutSha,
    required,
    attestation: fetched.attestation,
    freshMain,
  });

  emit(result, {
    target_sha: targetSha,
    checkout_sha: checkoutSha,
    fresh_main: freshMain,
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
