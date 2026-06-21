/**
 * Manual Party Backfill VERIFICATION entrypoint — Phase 1 T2e.
 *
 * READ-ONLY. Prints a post-backfill verification report. SCRIPT-ONLY — never
 * import this from app/route/runtime code.
 *
 *   npx tsx scripts/party-verify-backfill.ts
 *
 * It performs NO writes, no mode, no confirm phrase, no backfill, no migration.
 * The only gate is the migrations-applied guard (fail-closed): both Party
 * migrations must be recorded as applied in the target DB before it will read.
 *
 * Exit code: 0 when verdict is OK, 1 when verification fails or is blocked.
 *
 * T2e does NOT add: migration run · backfill run · execute · runtime wiring ·
 * route/API/UI/cron · Billing/intake · T3. It reuses already-tested functions.
 */

import { verifyBackfill, type VerificationReport } from "@/lib/services/party/party-verification.service";
import {
  assertMigrationsApplied,
  buildPrismaVerificationDeps,
  type BackfillPrismaClient,
} from "@/lib/services/party/party-backfill.deps";
import type { VerificationDeps } from "@/lib/services/party/party-verification.service";

/**
 * Build read-only verification deps over Prisma, AFTER the migrations-applied
 * guard passes (fail-closed). Client is injectable for tests; the real `prisma`
 * is imported lazily so importing this module never instantiates a client.
 */
export async function loadVerificationDeps(
  client?: BackfillPrismaClient
): Promise<VerificationDeps> {
  let db = client;
  if (!db) {
    const { prisma } = await import("@/lib/prisma");
    db = prisma as unknown as BackfillPrismaClient;
  }
  await assertMigrationsApplied(db); // fail closed if migrations missing
  return buildPrismaVerificationDeps(db);
}

/** Human-readable verification report (verdict + totals + per-business + full JSON). */
export function renderVerificationReport(report: VerificationReport): string {
  const t = report.totals;
  const lines: string[] = [
    "--- party backfill verification ---",
    `VERDICT: ${t.ok ? "OK" : "NOT OK"}`,
    `  totality: ${t.totalityHolds ? "holds" : "FAILED"} · ` +
      `tenant isolation: ${t.tenantIsolationHolds ? "holds" : "FAILED"} · ` +
      `no-signal-invariant: ${t.noSignalInvariantViolation ? "holds" : "VIOLATED"}`,
    "totals:",
    `  businesses: ${t.businesses}`,
    `  customers/leads: ${t.customers}/${t.leads}`,
    `  parties/claims: ${t.parties}/${t.claims}`,
    `  signal/anchor claims: ${t.signalClaims}/${t.anchorClaims}`,
    `  conflicts: ${t.conflicts}`,
    `  missing subjects: ${t.missingSubjects}`,
    `  tenant violations: ${t.tenantViolations}`,
    `  signal invariant violations: ${t.signalInvariantViolations}`,
    "per-business:",
  ];
  for (const b of report.perBusiness) {
    lines.push(
      `  business ${b.businessId}: ${b.ok ? "ok" : "NOT OK"} · ` +
        `cust/lead=${b.customers}/${b.leads} parties=${b.parties} claims=${b.claims} ` +
        `signal/anchor=${b.signalClaims}/${b.anchorClaims} conflicts=${b.conflicts} ` +
        `missing=${b.missingSubjects} tenantViol=${b.tenantViolations} ` +
        `signalInvariant=${b.signalInvariantViolations}`
    );
  }
  lines.push("--- full report (json) ---");
  lines.push(JSON.stringify(report, null, 2));
  return lines.join("\n");
}

export type Verifier = (deps: VerificationDeps) => Promise<VerificationReport>;

/**
 * Orchestrator. Returns a process exit code: 0 if verification verdict is OK,
 * 1 if it fails the verdict or is blocked (e.g. migrations missing → guard throws).
 * The deps factory and verifier are injectable for tests.
 */
export async function main(
  io: {
    depsFactory?: () => Promise<VerificationDeps>;
    verifier?: Verifier;
    log?: (line: string) => void;
  } = {}
): Promise<number> {
  const log = io.log ?? ((line: string) => console.log(line));
  const depsFactory = io.depsFactory ?? (() => loadVerificationDeps());
  const verify = io.verifier ?? verifyBackfill;

  let deps: VerificationDeps;
  try {
    deps = await depsFactory();
  } catch (error) {
    log(
      `[party-verify] BLOCKED — ${error instanceof Error ? error.message : String(error)}`
    );
    return 1;
  }

  const report = await verify(deps);
  log(renderVerificationReport(report));
  return report.totals.ok ? 0 : 1;
}

// Run only when invoked directly (never on import).
if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
