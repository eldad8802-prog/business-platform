/**
 * Build the production migration attestation.
 *
 * This is the ROOT OF TRUST for the release guard. The guard never reads the
 * database: the Ignored Build Step runs before dependencies are installed, so it
 * has no Prisma client and no guaranteed `psql`, and putting a production
 * database credential into a build container is a surface we do not need. So the
 * two workflows that already hold that credential — and that already require a
 * human approval on the `production-db` environment — read the ledger and
 * publish what they saw. The guard verifies WHICH RUN produced the artifact and
 * trusts that, not the JSON.
 *
 * Run from a workflow that has DATABASE_URL/DIRECT_URL. Writes one JSON file.
 *
 * PUBLICATION ORDER IS LOAD-BEARING: this must run only AFTER `migrate deploy`
 * succeeded and `migrate status` reported up-to-date. If the ledger read here
 * fails, the process exits non-zero and NO artifact is produced — the previous
 * attestation stays, and because it will not contain the new migration, the
 * guard blocks anyway. Staleness is safe by construction; a wrong attestation
 * would not be.
 */

import { writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

export const ATTESTATION_VERSION = 1;

/**
 * Collapse raw ledger rows into effective per-migration state.
 *
 * A migration is applied if ANY execution of it finished and was not rolled
 * back. That is deliberately about EXISTENCE, not purity: Prisma's documented
 * recovery path is `migrate resolve --rolled-back` followed by a retry, so a
 * historical failed or rolled-back attempt is a normal artefact of a successful
 * recovery. Blocking on "this name once had a bad row" would lock production out
 * permanently after a legitimate fix.
 *
 * `inflight` is the genuinely dangerous state: started, never finished, never
 * rolled back. The database is part-way through a structural change.
 */
export function summarizeLedger(rows) {
  const byName = new Map();
  for (const r of rows) {
    const e = byName.get(r.migration_name) ?? {
      applied: false,
      inflight: false,
      rolledBack: false,
    };
    if (r.finished_at !== null && r.rolled_back_at === null) e.applied = true;
    else if (r.finished_at === null && r.rolled_back_at === null) e.inflight = true;
    if (r.rolled_back_at !== null) e.rolledBack = true;
    byName.set(r.migration_name, e);
  }

  const applied = [];
  const inflight = [];
  const rolledBackOnly = [];
  for (const [name, e] of byName) {
    if (e.applied) applied.push(name);
    else if (e.inflight) inflight.push(name);
    else if (e.rolledBack) rolledBackOnly.push(name);
  }

  return {
    applied: applied.sort(),
    inflight: inflight.sort(),
    rolledBackOnly: rolledBackOnly.sort(),
    totalRows: rows.length,
  };
}

/** Endpoint host only — never the credential. */
function endpointOf(url) {
  try {
    return new URL(url).hostname.split(".")[0];
  } catch {
    return "(unparseable)";
  }
}

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error("usage: build-migration-attestation.mjs <output.json>");

  const prisma = new PrismaClient();
  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      'SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"'
    );
  } finally {
    await prisma.$disconnect();
  }

  if (!Array.isArray(rows)) throw new Error("ledger read returned a non-array");
  if (rows.length === 0) {
    // An empty ledger against a live production database is not a believable
    // reading. Publishing it would assert "nothing is applied" and block every
    // deployment; refusing to publish leaves the previous attestation, which is
    // the safe direction.
    throw new Error("ledger read returned zero rows — refusing to publish");
  }

  const attestation = {
    attestationVersion: ATTESTATION_VERSION,
    generatedAt: new Date().toISOString(),
    source: {
      workflow: process.env.GITHUB_WORKFLOW_REF ?? process.env.GITHUB_WORKFLOW ?? null,
      workflowPath: process.env.RELEASE_ATTESTATION_WORKFLOW_PATH ?? null,
      runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      commitSha: process.env.GITHUB_SHA ?? null,
      actor: process.env.GITHUB_ACTOR ?? null,
      repository: process.env.GITHUB_REPOSITORY ?? null,
    },
    productionEnvironment: {
      githubEnvironment: "production-db",
      endpoint: endpointOf(process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? ""),
    },
    ledger: summarizeLedger(rows),
  };

  writeFileSync(out, `${JSON.stringify(attestation, null, 2)}\n`, "utf8");
  console.log(
    `attestation: ${attestation.ledger.applied.length} applied, ` +
      `${attestation.ledger.inflight.length} inflight, ` +
      `${attestation.ledger.rolledBackOnly.length} rolled-back-only, ` +
      `${attestation.ledger.totalRows} rows`
  );
}

if (process.argv[1] && process.argv[1].endsWith("build-migration-attestation.mjs")) {
  main().catch((err) => {
    // Loud, and non-zero: the workflow must fail rather than publish anything.
    console.error(`attestation: FAILED — ${err?.message ?? err}`);
    process.exit(1);
  });
}
