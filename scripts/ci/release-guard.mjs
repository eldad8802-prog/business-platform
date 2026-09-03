/**
 * Release guard — refuse to deploy code whose migrations Production has not run.
 *
 * WHY THIS EXISTS
 *
 * On 2026-09-02 a PR that added `User.tokenVersion` merged to main. Vercel
 * auto-deploys main, so the code was live 1-4 minutes later. The migration was
 * NOT applied — it needs a separately gated run. Prisma issues an explicit
 * column list, so every `User` read asked for a column the database did not
 * have; `getCurrentUser` caught the error and returned null, and every
 * authenticated request 401'd while login 500'd.
 *
 * Hours later a second PR from a different author landed the same hazard shape.
 * That time the correct order happened only because a Vercel build-quota limit
 * stalled the deploy for 26 minutes. A quota limit is not a release control: it
 * is time-boxed, invisible to the author, and disappears without notice.
 *
 * So this runs as Vercel's Ignored Build Step, at the only boundary that
 * actually matters — deployment, not merge.
 *
 * WHAT IT PROVES (one direction only)
 *
 *     every migration required by the deployed commit is already applied
 *
 * It deliberately does NOT prove the schema equals the commit. Production may be
 * AHEAD of the commit — that is normal during a revert, and blocking on it would
 * lock us out of production exactly when we need to recover. The invariant is:
 *
 *     the database may be ahead of X; it must never be behind X.
 *
 * WHERE THE TRUTH COMES FROM
 *
 * Not from the database. The Ignored Build Step runs before dependencies are
 * installed, so there is no Prisma client and no guaranteed `psql`; and putting
 * a production database credential into a build container is a surface we do not
 * need. Instead the gated `release-migrate` workflow — which already has access
 * and already requires a human approval — publishes what it applied as an
 * immutable artifact, and this reads that.
 *
 * Exit code: 0 = SAFE, non-zero = BLOCK. The INVERSION to Vercel's convention
 * (where 0 aborts the build) is done once, in release-guard.sh, deliberately in
 * one place.
 */

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

export const SUPPORTED_ATTESTATION_VERSIONS = [1];

export const BLOCK_REASONS = {
  NOT_APPLIED: "BLOCKED — REQUIRED MIGRATION NOT APPLIED",
  ANOMALY: "BLOCKED — MIGRATION LEDGER ANOMALY",
  CANNOT_VERIFY: "BLOCKED — RELEASE GUARD CANNOT VERIFY PRODUCTION",
};

/* ------------------------------------------------------------------ pure -- */

/**
 * The whole decision, as a pure function. Everything that can go wrong maps to a
 * reason; there is no path that returns "safe" by omission.
 *
 * `required` — migration directory names in the commit being deployed.
 * `attestation` — the parsed payload, or null when it could not be obtained.
 */
export function evaluate({ required, attestation }) {
  if (!attestation || typeof attestation !== "object") {
    return block(BLOCK_REASONS.CANNOT_VERIFY, "no attestation payload");
  }

  const version = attestation.attestationVersion;
  if (!SUPPORTED_ATTESTATION_VERSIONS.includes(version)) {
    // An unknown version is not a safe default. A future format could move or
    // rename `applied`, and reading it with today's assumptions would silently
    // compare against the wrong thing.
    return block(
      BLOCK_REASONS.CANNOT_VERIFY,
      `unsupported attestationVersion: ${JSON.stringify(version)}`
    );
  }

  const ledger = attestation.ledger;
  if (
    !ledger ||
    !Array.isArray(ledger.applied) ||
    !Array.isArray(ledger.inflight)
  ) {
    return block(BLOCK_REASONS.CANNOT_VERIFY, "attestation ledger is malformed");
  }

  // A migration that is running — or that crashed mid-run — means the database
  // is part-way through a structural change. Not the moment to ship code,
  // whether or not this commit needs that particular migration.
  if (ledger.inflight.length > 0) {
    return block(
      BLOCK_REASONS.ANOMALY,
      `migration(s) in flight in production: ${ledger.inflight.join(", ")}`
    );
  }

  const applied = new Set(ledger.applied);
  const missing = required.filter((m) => !applied.has(m));

  if (missing.length > 0) {
    return block(
      BLOCK_REASONS.NOT_APPLIED,
      `not applied in production: ${missing.join(", ")}`
    );
  }

  // Applied migrations absent from this commit are EXPECTED, not a fault: a
  // revert removes migration files while their ledger rows remain. Reported so
  // the drift is visible, never blocking.
  const requiredSet = new Set(required);
  const ahead = ledger.applied.filter((m) => !requiredSet.has(m));

  return {
    safe: true,
    reason: "SAFE_TO_DEPLOY",
    detail: `${required.length} required migration(s) all applied`,
    ahead,
  };
}

function block(reason, detail) {
  return { safe: false, reason, detail, ahead: [] };
}

/**
 * Verify the artifact came from a run we are willing to trust.
 *
 * The payload is not trusted because it arrived from GitHub. It is trusted
 * because of WHICH RUN produced it: one of two workflow files, which are
 * dispatch-only and bound to the `production-db` environment, so a pull request
 * cannot cause one to run.
 */
export function verifyRun({ run, allowedWorkflowPaths }) {
  if (!run || typeof run !== "object") {
    return { ok: false, detail: "no workflow run metadata" };
  }
  const checks = [
    [allowedWorkflowPaths.includes(run.path), `workflow path not allowed: ${run.path}`],
    [run.conclusion === "success", `run conclusion is ${run.conclusion}`],
    [run.head_branch === "main", `run branch is ${run.head_branch}`],
    [run.event === "workflow_dispatch", `run event is ${run.event}`],
  ];
  for (const [ok, detail] of checks) {
    if (!ok) return { ok: false, detail };
  }
  return { ok: true, detail: `run ${run.id} authentic` };
}

/* ------------------------------------------------------------------- zip -- */

/**
 * Extract the single JSON entry from a GitHub artifact zip.
 *
 * Written by hand because the Ignored Build Step runs before `npm install`, so
 * there is no unzip dependency available and Node ships none. Reads the central
 * directory rather than scanning for local headers: local headers may carry zero
 * sizes when a data descriptor is used, and guessing there would be fragile.
 */
export function extractSingleFileFromZip(buf) {
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66_000; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip: end-of-central-directory not found");

  const entries = buf.readUInt16LE(eocd + 10);
  if (entries < 1) throw new Error("zip: archive is empty");
  let p = buf.readUInt32LE(eocd + 16);

  if (buf.readUInt32LE(p) !== 0x02014b50) {
    throw new Error("zip: bad central directory signature");
  }
  const method = buf.readUInt16LE(p + 10);
  const compressedSize = buf.readUInt32LE(p + 20);
  const nameLen = buf.readUInt16LE(p + 28);
  const extraLen = buf.readUInt16LE(p + 30);
  const commentLen = buf.readUInt16LE(p + 32);
  const localOffset = buf.readUInt32LE(p + 42);
  void extraLen;
  void commentLen;
  void nameLen;

  if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
    throw new Error("zip: bad local header signature");
  }
  const lNameLen = buf.readUInt16LE(localOffset + 26);
  const lExtraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + lNameLen + lExtraLen;
  const data = buf.subarray(dataStart, dataStart + compressedSize);

  if (method === 0) return data.toString("utf8");
  if (method === 8) return inflateRawSync(data).toString("utf8");
  throw new Error(`zip: unsupported compression method ${method}`);
}

/* -------------------------------------------------------------------- io -- */

export function readRequiredMigrations(root) {
  const dir = join(root, "prisma", "migrations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(dir, name, "migration.sql")))
    .sort();
}

async function gh(url, token, { raw = false } = {}) {
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: raw ? "application/vnd.github+json" : "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "dubiz-release-guard",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
}

export async function fetchAttestation({
  repo,
  token,
  artifactName,
  allowedWorkflowPaths,
}) {
  const api = `https://api.github.com/repos/${repo}`;
  const list = await gh(
    `${api}/actions/artifacts?name=${encodeURIComponent(artifactName)}&per_page=50`,
    token
  );
  const candidates = (list.artifacts ?? []).filter((a) => !a.expired);
  if (candidates.length === 0) {
    throw new Error("no unexpired attestation artifact found");
  }
  // Newest first; take the newest whose producing run is authentic.
  candidates.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const failures = [];
  for (const artifact of candidates) {
    const runId = artifact.workflow_run?.id;
    if (!runId) {
      failures.push(`artifact ${artifact.id}: no run linkage`);
      continue;
    }
    const run = await gh(`${api}/actions/runs/${runId}`, token);
    const verdict = verifyRun({ run, allowedWorkflowPaths });
    if (!verdict.ok) {
      failures.push(`artifact ${artifact.id}: ${verdict.detail}`);
      continue;
    }
    const zip = await gh(
      `${api}/actions/artifacts/${artifact.id}/zip`,
      token,
      { raw: true }
    );
    return {
      attestation: JSON.parse(extractSingleFileFromZip(zip)),
      run,
      artifactId: artifact.id,
    };
  }
  throw new Error(`no authentic attestation: ${failures.join(" | ")}`);
}

/* ------------------------------------------------------------------ main -- */

async function main() {
  const repo = process.env.RELEASE_GUARD_REPO;
  const token = process.env.RELEASE_GUARD_GITHUB_TOKEN;
  const artifactName =
    process.env.RELEASE_GUARD_ARTIFACT_NAME || "production-migration-attestation";
  const allowedWorkflowPaths = (
    process.env.RELEASE_GUARD_ALLOWED_WORKFLOWS ||
    ".github/workflows/release-migrate.yml,.github/workflows/attest-production-migrations.yml"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const required = readRequiredMigrations(process.cwd());
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || "(sha not exposed)";
  console.log(`release-guard: commit=${sha} required=${required.length}`);

  if (!repo || !token) {
    fail(BLOCK_REASONS.CANNOT_VERIFY, "RELEASE_GUARD_REPO / _GITHUB_TOKEN not set");
  }

  let fetched;
  try {
    fetched = await fetchAttestation({ repo, token, artifactName, allowedWorkflowPaths });
  } catch (err) {
    fail(BLOCK_REASONS.CANNOT_VERIFY, err?.message ?? String(err));
  }

  const result = evaluate({ required, attestation: fetched.attestation });
  console.log(
    `release-guard: attestation run=${fetched.run.id} ` +
      `workflow=${fetched.run.path} generatedAt=${fetched.attestation.generatedAt}`
  );

  if (!result.safe) fail(result.reason, result.detail);

  if (result.ahead.length > 0) {
    console.log(
      `release-guard: note — production is ahead by ${result.ahead.length} ` +
        `migration(s) not in this commit (expected after a revert)`
    );
  }
  console.log(`release-guard: ${result.reason} — ${result.detail}`);
  process.exit(0);
}

function fail(reason, detail) {
  console.error(`release-guard: ${reason}: ${detail}`);
  process.exit(2);
}

// Only run when invoked directly, so the self-test can import the pure parts.
if (process.argv[1] && process.argv[1].endsWith("release-guard.mjs")) {
  main().catch((err) => {
    // Nothing may reach here and look like success.
    console.error(
      `release-guard: ${BLOCK_REASONS.CANNOT_VERIFY}: unexpected ${err?.message ?? err}`
    );
    process.exit(2);
  });
}
