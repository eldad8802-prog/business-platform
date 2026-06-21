/**
 * Manual Party Backfill VERIFICATION entrypoint — T2e tests (run manually):
 *   npx tsx scripts/party-verify-backfill.test.ts
 *
 * No DB: exercises the migrations guard, deps build, report rendering, and the
 * orchestrator with INJECTED fakes (the real prisma must never be imported).
 */
import { PartyRoleType, PartySignalType, Prisma } from "@prisma/client";
import type {
  VerificationDeps,
  VerificationReport,
} from "@/lib/services/party/party-verification.service";
import {
  REQUIRED_PARTY_MIGRATIONS,
  type BackfillPrismaClient,
} from "@/lib/services/party/party-backfill.deps";
import {
  loadVerificationDeps,
  main,
  renderVerificationReport,
  type Verifier,
} from "@/scripts/party-verify-backfill";

let failed = 0;
function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

/** Mock Prisma client with configurable applied migrations + seed data. */
function mockClient(migrations: string[]): BackfillPrismaClient {
  return {
    $queryRawUnsafe: (async () =>
      migrations.map((m) => ({ migration_name: m }))) as BackfillPrismaClient["$queryRawUnsafe"],
    $transaction: (async (fn: (t: Prisma.TransactionClient) => Promise<unknown>) =>
      fn({} as Prisma.TransactionClient)) as BackfillPrismaClient["$transaction"],
    business: { findMany: async () => [{ id: 1 }] },
    customer: { findMany: async () => [{ id: 10, phone: "p", taxId: null, name: "A" }] },
    lead: { findMany: async () => [] },
    party: { findMany: async () => [{ id: 100, businessId: 1 }] },
    partyResolutionClaim: {
      findMany: async () => [
        {
          partyId: 100,
          subjectType: PartyRoleType.CUSTOMER,
          subjectId: 10,
          signalType: PartySignalType.PHONE,
          signalValue: "p",
          source: "BACKFILL",
        },
      ],
    },
  };
}

function fakeReport(ok: boolean): VerificationReport {
  return {
    perBusiness: [
      {
        businessId: 1,
        customers: 2,
        leads: 1,
        parties: 3,
        claims: 3,
        signalClaims: 2,
        anchorClaims: 1,
        conflicts: 0,
        missingSubjects: ok ? 0 : 1,
        missingSubjectSamples: ok ? [] : ["CUSTOMER:99"],
        tenantViolations: 0,
        tenantViolationSamples: [],
        signalInvariantViolations: 0,
        signalInvariantSamples: [],
        totalityHolds: ok,
        tenantIsolationHolds: true,
        noSignalInvariantViolation: true,
        ok,
      },
    ],
    totals: {
      businesses: 1,
      customers: 2,
      leads: 1,
      parties: 3,
      claims: 3,
      signalClaims: 2,
      anchorClaims: 1,
      conflicts: 0,
      missingSubjects: ok ? 0 : 1,
      tenantViolations: 0,
      signalInvariantViolations: 0,
      totalityHolds: ok,
      tenantIsolationHolds: true,
      noSignalInvariantViolation: true,
      ok,
    },
  };
}

async function runTests() {
  // 1. Migrations missing → loadVerificationDeps fails closed.
  {
    let threw = false;
    try {
      await loadVerificationDeps(mockClient([REQUIRED_PARTY_MIGRATIONS[0]])); // second missing
    } catch {
      threw = true;
    }
    ok("missing migration → blocked", threw === true);
  }

  // 2. Migrations applied → builds read-only verification deps.
  {
    const deps = await loadVerificationDeps(mockClient([...REQUIRED_PARTY_MIGRATIONS]));
    ok("applied migrations → deps built", deps !== null && typeof deps.loadActiveClaims === "function");
    const keys = Object.keys(deps);
    ok("deps are read-only (list/load only)", keys.every((k) => k.startsWith("list") || k.startsWith("load")));
    ok("deps expose no write port", !keys.some((k) => /create|update|delete|upsert|write/i.test(k)));
    // smoke: the wired deps actually read through the mock client
    const claims = await deps.loadActiveClaims(1);
    ok("deps read claims via client", claims.length === 1 && claims[0].subjectId === 10);
  }

  // 3. main(): migrations missing → returns 1, verifier NOT called.
  {
    let verified = false;
    const code = await main({
      depsFactory: async () => {
        throw new Error("migrations not applied");
      },
      verifier: (async () => {
        verified = true;
        return fakeReport(true);
      }) as unknown as Verifier,
      log: () => {},
    });
    ok("main blocked returns 1", code === 1);
    ok("main blocked does not verify", verified === false);
  }

  // 4. main(): applied → calls verifyBackfill, prints report, returns 0 when ok.
  {
    let verified = false;
    const logs: string[] = [];
    const code = await main({
      depsFactory: async () => ({} as VerificationDeps),
      verifier: (async () => {
        verified = true;
        return fakeReport(true);
      }) as unknown as Verifier,
      log: (l) => logs.push(l),
    });
    ok("main ok returns 0", code === 0);
    ok("main calls verifier", verified === true);
    ok("main prints a report", logs.some((l) => l.includes("party backfill verification")));
    ok("main prints OK verdict", logs.some((l) => l.includes("VERDICT: OK")));
  }

  // 5. main(): NOT OK verdict → returns 1.
  {
    const code = await main({
      depsFactory: async () => ({} as VerificationDeps),
      verifier: (async () => fakeReport(false)) as unknown as Verifier,
      log: () => {},
    });
    ok("main not-ok returns 1", code === 1);
  }

  // 6. renderVerificationReport surfaces every required field.
  {
    const okReport = renderVerificationReport(fakeReport(true));
    ok("render: verdict ok", okReport.includes("VERDICT: OK"));
    ok("render: totals businesses", okReport.includes("businesses: 1"));
    ok("render: tenant violations", okReport.includes("tenant violations: 0"));
    ok("render: signal invariant violations", okReport.includes("signal invariant violations: 0"));
    ok("render: missing subjects", okReport.includes("missing subjects: 0"));
    ok("render: conflicts", okReport.includes("conflicts: 0"));
    ok("render: per-business line", okReport.includes("business 1:"));
    ok("render: includes json", okReport.includes("full report (json)"));

    const badReport = renderVerificationReport(fakeReport(false));
    ok("render: NOT OK verdict", badReport.includes("VERDICT: NOT OK"));
    ok("render: totality FAILED", badReport.includes("totality: FAILED"));
    ok("render: missing subjects 1", badReport.includes("missing subjects: 1"));
  }

  if (failed > 0) {
    console.error(`\n${failed} party verify entrypoint T2e check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll party verify entrypoint T2e checks passed.");
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
