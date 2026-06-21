/**
 * Manual Party Backfill entrypoint — T2c gate/parse/report tests (run manually):
 *   npx tsx scripts/party-backfill.test.ts
 *
 * No DB, no real deps: exercises the pure arg parser, the gate, report rendering,
 * and the orchestrator with INJECTED fakes (the real deps factory must never run).
 */
import { Prisma } from "@prisma/client";
import type {
  BackfillDeps,
  BackfillReport,
} from "@/lib/services/party/party-backfill.service";
import {
  REQUIRED_PARTY_MIGRATIONS,
  type BackfillPrismaClient,
} from "@/lib/services/party/party-backfill.deps";
import {
  EXECUTE_CONFIRM_PHRASE,
  evaluateGate,
  loadBackfillDeps,
  main,
  parseArgs,
  renderReport,
  type BackfillRunner,
} from "@/scripts/party-backfill";

/** A minimal mock Prisma client whose recorded migrations are configurable. */
function mockClient(migrations: string[]): BackfillPrismaClient {
  return {
    $queryRawUnsafe: (async () =>
      migrations.map((m) => ({ migration_name: m }))) as BackfillPrismaClient["$queryRawUnsafe"],
    $transaction: (async (fn: (t: Prisma.TransactionClient) => Promise<unknown>) =>
      fn({} as Prisma.TransactionClient)) as BackfillPrismaClient["$transaction"],
    business: { findMany: async () => [] },
    customer: { findMany: async () => [] },
    lead: { findMany: async () => [] },
    party: { findMany: async () => [] },
    partyResolutionClaim: { findMany: async () => [] },
  };
}

let failed = 0;
function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

function fakeReport(overrides: Partial<BackfillReport["totals"]> = {}): BackfillReport {
  return {
    mode: "dry-run",
    startedAt: "2026-06-10T00:00:00.000Z",
    finishedAt: "2026-06-10T00:00:01.000Z",
    totals: {
      businesses: 2,
      failedBusinesses: 1,
      customersRead: 5,
      leadsRead: 2,
      applied: 4,
      noop: 1,
      singleton: 1,
      conflict: 1,
      signalClaims: 3,
      anchorClaims: 2,
      batches: 3,
      batchesFailed: 1,
      ...overrides,
    },
    health: {
      multiPartySignals: 1,
      oversizedParties: 0,
      conflictAnchors: 1,
      anomalyCount: 2,
      anyInvariantViolation: true,
    },
    perBusiness: [],
  };
}

async function runTests() {
  // 1. Default mode is dry-run when no --mode passed.
  {
    const parsed = parseArgs([]);
    ok("default mode = dry-run", parsed.mode === "dry-run" && parsed.errors.length === 0);
    const gate = evaluateGate(parsed, {});
    ok("default → allowed, no persistence", gate.allowed === true && gate.willPersist === false);
  }

  // 2. Explicit dry-run is allowed (non-prod and prod alike).
  {
    const parsed = parseArgs(["--mode", "dry-run"]);
    ok("dry-run allowed non-prod", evaluateGate(parsed, {}).allowed === true);
    ok(
      "dry-run allowed even in prod",
      evaluateGate(parsed, { NODE_ENV: "production" }).allowed === true &&
        evaluateGate(parsed, { NODE_ENV: "production" }).willPersist === false
    );
  }

  // 3. Execute WITHOUT confirm phrase → blocked (fail closed).
  {
    const parsed = parseArgs(["--mode", "execute"]);
    const gate = evaluateGate(parsed, {});
    ok("execute w/o confirm blocked", gate.allowed === false && gate.willPersist === false);
    ok("execute w/o confirm reason", gate.reasons.some((r) => r.includes("confirm-execute")));
  }

  // 4. Execute WITH wrong confirm phrase → blocked.
  {
    const parsed = parseArgs(["--mode", "execute", "--confirm-execute", "NOPE"]);
    ok("execute wrong phrase blocked", evaluateGate(parsed, {}).allowed === false);
  }

  // 5. Execute WITH correct confirm (non-prod) → allowed + persists.
  {
    const parsed = parseArgs(["--mode", "execute", "--confirm-execute", EXECUTE_CONFIRM_PHRASE]);
    const gate = evaluateGate(parsed, {});
    ok("execute confirmed allowed", gate.allowed === true && gate.willPersist === true);
  }

  // 6. Production execute is blocked even with confirm (and even with the prod flag).
  {
    const parsed = parseArgs([
      "--mode",
      "execute",
      "--confirm-execute",
      EXECUTE_CONFIRM_PHRASE,
      "--allow-production-execute",
    ]);
    ok(
      "prod execute blocked (NODE_ENV)",
      evaluateGate(parsed, { NODE_ENV: "production" }).allowed === false
    );
    ok(
      "prod execute blocked (VERCEL_ENV)",
      evaluateGate(parsed, { VERCEL_ENV: "production" }).allowed === false
    );
    ok(
      "prod block reason mentions T2c",
      evaluateGate(parsed, { NODE_ENV: "production" }).reasons.some((r) => r.includes("T2c"))
    );
  }

  // 7. Invalid args → fail closed (unknown flag, bad batch size, bad mode).
  {
    ok("unknown flag fails closed", evaluateGate(parseArgs(["--nope"]), {}).allowed === false);
    ok(
      "bad batch size fails closed",
      evaluateGate(parseArgs(["--batch-size", "0"]), {}).allowed === false
    );
    ok(
      "bad mode fails closed",
      evaluateGate(parseArgs(["--mode", "wat"]), {}).allowed === false
    );
  }

  // 8. Valid optional numeric flags parse.
  {
    const parsed = parseArgs(["--batch-size", "50", "--oversized-threshold", "7"]);
    ok("batch-size parsed", parsed.batchSize === 50 && parsed.errors.length === 0);
    ok("oversized-threshold parsed", parsed.oversizedThreshold === 7);
  }

  // 9. renderReport surfaces all required fields.
  {
    const out = renderReport(fakeReport(), false);
    ok("report: mode", out.includes("mode: dry-run"));
    ok("report: businesses processed", out.includes("businesses processed: 2"));
    ok("report: failed businesses", out.includes("failed businesses: 1"));
    ok("report: batches", out.includes("batches: 3 (failed: 1)"));
    ok("report: totals", out.includes("applied/noop/singleton/conflict: 4/1/1/1"));
    ok("report: health summary", out.includes("anomalies=2"));
    ok("report: invariant violation surfaced", out.includes("INVARIANT VIOLATION"));
    ok("report: dry-run persistence reminder", out.includes("PERSISTENCE: none"));
  }

  // 10. renderReport persistence reminder flips for execute.
  {
    const out = renderReport(fakeReport(), true);
    ok("report: execute persistence reminder", out.includes("PERSISTENCE: COMMITTED"));
    const clean = renderReport({ ...fakeReport(), health: { multiPartySignals: 0, oversizedParties: 0, conflictAnchors: 0, anomalyCount: 0, anyInvariantViolation: false } }, false);
    ok("report: no invariant when clean", clean.includes("invariant violations: none"));
  }

  // 11. main(): blocked path returns 1 and NEVER builds deps / runs.
  {
    let depsBuilt = false;
    let ran = false;
    const code = await main(["--mode", "execute"], {}, {
      depsFactory: async () => {
        depsBuilt = true;
        return {} as BackfillDeps;
      },
      runner: (async () => {
        ran = true;
        return fakeReport();
      }) as unknown as BackfillRunner,
      log: () => {},
    });
    ok("main blocked returns 1", code === 1);
    ok("main blocked builds no deps", depsBuilt === false);
    ok("main blocked runs nothing", ran === false);
  }

  // 12. main(): allowed dry-run path runs via injected fakes and returns 0.
  {
    let usedMode = "";
    const logs: string[] = [];
    const code = await main(["--mode", "dry-run"], {}, {
      depsFactory: async () => ({} as BackfillDeps),
      runner: (async (_deps, opts) => {
        usedMode = opts.mode;
        return fakeReport({ businesses: 1 });
      }) as unknown as BackfillRunner,
      log: (l) => logs.push(l),
    });
    ok("main dry-run returns 0", code === 0);
    ok("main dry-run uses dry-run mode", usedMode === "dry-run");
    ok("main dry-run logs a report", logs.some((l) => l.includes("party backfill report")));
  }

  // 13. T2d: loadBackfillDeps builds deps when migrations are applied (mock client).
  {
    let deps: BackfillDeps | null = null;
    let threw = false;
    try {
      deps = await loadBackfillDeps(mockClient([...REQUIRED_PARTY_MIGRATIONS]));
    } catch {
      threw = true;
    }
    ok("loadBackfillDeps OK with valid migrations", threw === false && deps !== null);
    ok(
      "loadBackfillDeps returns wired deps",
      deps !== null && typeof deps.listBusinessIds === "function" && typeof deps.runInTx === "function"
    );
  }

  // 14. T2d: loadBackfillDeps fails closed when a Party migration is missing.
  {
    let threw = false;
    try {
      await loadBackfillDeps(mockClient([REQUIRED_PARTY_MIGRATIONS[0]])); // second missing
    } catch {
      threw = true;
    }
    ok("loadBackfillDeps blocked on missing migration", threw === true);
  }

  // 15. T2d: production execute is STILL blocked before any deps are built.
  {
    let depsBuilt = false;
    const code = await main(
      ["--mode", "execute", "--confirm-execute", EXECUTE_CONFIRM_PHRASE],
      { NODE_ENV: "production" },
      {
        depsFactory: async () => {
          depsBuilt = true;
          return {} as BackfillDeps;
        },
        runner: (async () => fakeReport()) as unknown as BackfillRunner,
        log: () => {},
      }
    );
    ok("prod execute blocked returns 1", code === 1);
    ok("prod execute builds no deps", depsBuilt === false);
  }

  if (failed > 0) {
    console.error(`\n${failed} party backfill entrypoint check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll party backfill entrypoint checks passed.");
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
