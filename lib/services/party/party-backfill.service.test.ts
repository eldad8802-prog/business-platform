/**
 * Party Backfill T2a — runner skeleton + dry-run (run manually):
 *   npx tsx lib/services/party/party-backfill.service.test.ts
 */
import {
  PartyClaimConfidence,
  PartyClaimStatus,
  PartyResolutionMethod,
  PartyRoleType,
  PartySignalType,
  Prisma,
} from "@prisma/client";
import {
  backfillBusiness,
  buildHealth,
  iterateRoleRows,
  runBackfill,
  type BackfillDeps,
  type HealthClaim,
  type RoleRowInput,
} from "@/lib/services/party/party-backfill.service";

let failed = 0;
function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

const NOW = new Date("2026-06-10T10:00:00.000Z");

type ClaimRow = {
  id: number;
  businessId: number;
  partyId: number;
  subjectType: PartyRoleType;
  subjectId: number;
  signalType: PartySignalType | null;
  signalValue: string | null;
  confidence: PartyClaimConfidence;
  method: PartyResolutionMethod;
  source: string;
  resolvedByUserId: number | null;
  status: PartyClaimStatus;
  createdAt: Date;
  updatedAt: Date;
};
type PartyRow = {
  id: number;
  businessId: number;
  createdAt: Date;
  updatedAt: Date;
};
type TxState = {
  parties: PartyRow[];
  claims: ClaimRow[];
  nextPartyId: number;
  nextClaimId: number;
};

function buildTx(state: TxState): Prisma.TransactionClient {
  const tx = {
    party: {
      async create(args: { data: { businessId: number } }) {
        const p: PartyRow = {
          id: state.nextPartyId++,
          businessId: args.data.businessId,
          createdAt: NOW,
          updatedAt: NOW,
        };
        state.parties.push(p);
        return p;
      },
      async findFirst(args: { where: { id?: number; businessId?: number } }) {
        return (
          state.parties.find(
            (p) =>
              (args.where.id === undefined || p.id === args.where.id) &&
              (args.where.businessId === undefined ||
                p.businessId === args.where.businessId)
          ) ?? null
        );
      },
    },
    partyResolutionClaim: {
      async findMany(args: {
        where: {
          businessId?: number;
          subjectType?: PartyRoleType;
          subjectId?: number;
          partyId?: number;
          signalType?: PartySignalType;
          signalValue?: string;
          status?: PartyClaimStatus;
        };
      }) {
        return state.claims.filter((c) => {
          const w = args.where;
          if (w.businessId !== undefined && c.businessId !== w.businessId) return false;
          if (w.subjectType !== undefined && c.subjectType !== w.subjectType) return false;
          if (w.subjectId !== undefined && c.subjectId !== w.subjectId) return false;
          if (w.partyId !== undefined && c.partyId !== w.partyId) return false;
          if (w.signalType !== undefined && c.signalType !== w.signalType) return false;
          if (w.signalValue !== undefined && c.signalValue !== w.signalValue) return false;
          if (w.status !== undefined && c.status !== w.status) return false;
          return true;
        });
      },
      async findFirst(args: {
        where: {
          businessId?: number;
          signalType?: PartySignalType;
          signalValue?: string;
          status?: PartyClaimStatus;
        };
      }) {
        const c = state.claims.find((row) => {
          const w = args.where;
          if (w.businessId !== undefined && row.businessId !== w.businessId) return false;
          if (w.signalType !== undefined && row.signalType !== w.signalType) return false;
          if (w.signalValue !== undefined && row.signalValue !== w.signalValue) return false;
          if (w.status !== undefined && row.status !== w.status) return false;
          return true;
        });
        if (!c) return null;
        const party = state.parties.find((p) => p.id === c.partyId);
        return party ? { party } : null;
      },
      async create(args: { data: Omit<ClaimRow, "id" | "createdAt" | "updatedAt"> }) {
        const c: ClaimRow = {
          id: state.nextClaimId++,
          ...args.data,
          createdAt: NOW,
          updatedAt: NOW,
        };
        state.claims.push(c);
        return c;
      },
    },
  };
  return tx as unknown as Prisma.TransactionClient;
}

type Seed = {
  businessIds: number[];
  customers: Record<number, RoleRowInput[]>;
  leads: Record<number, RoleRowInput[]>;
  failCustomersFor?: number;
  /** 1-indexed runInTx call number that should throw (simulated batch failure). */
  failTxCall?: number;
};

function makeFakeBackfillDb(seed: Seed) {
  const persistent: TxState = {
    parties: [],
    claims: [],
    nextPartyId: 1,
    nextClaimId: 1,
  };
  const txCalls: { dryRun: boolean }[] = [];
  let txCallCount = 0;

  const deps: BackfillDeps = {
    listBusinessIds: async () => seed.businessIds,
    loadCustomers: async (businessId) => {
      if (seed.failCustomersFor === businessId) {
        throw new Error(`load customers failed for business ${businessId}`);
      }
      return seed.customers[businessId] ?? [];
    },
    loadLeads: async (businessId) => seed.leads[businessId] ?? [],
    runInTx: async (fn, { dryRun }) => {
      txCallCount += 1;
      txCalls.push({ dryRun });
      // Simulate a transaction (batch) failure: roll back, propagate to caller.
      if (seed.failTxCall === txCallCount) {
        throw new Error(`simulated tx failure on call ${txCallCount}`);
      }
      const scratch: TxState = {
        parties: [...persistent.parties],
        claims: [...persistent.claims],
        nextPartyId: persistent.nextPartyId,
        nextClaimId: persistent.nextClaimId,
      };
      const result = await fn(buildTx(scratch));
      if (!dryRun) {
        persistent.parties = scratch.parties;
        persistent.claims = scratch.claims;
        persistent.nextPartyId = scratch.nextPartyId;
        persistent.nextClaimId = scratch.nextClaimId;
      }
      return result;
    },
  };

  return { deps, persistent, txCalls };
}

async function runTests() {
  // 1. Reads per business + stable order (customers by id, then leads by id).
  {
    const seed: Seed = {
      businessIds: [1],
      customers: { 1: [{ id: 30, phone: "0503333333" }, { id: 10, phone: "0501111111" }] },
      leads: { 1: [{ id: 25, phone: "0502222222" }, { id: 5, phone: "0505555555" }] },
    };
    const { deps } = makeFakeBackfillDb(seed);
    const order = await iterateRoleRows(deps, 1);
    ok(
      "stable order: customers by id then leads by id",
      order.map((r) => `${r.subjectType}:${r.row.id}`).join(",") ===
        "CUSTOMER:10,CUSTOMER:30,LEAD:5,LEAD:25"
    );
    const report = await backfillBusiness(deps, 1, "dry-run");
    ok("customersRead counted", report.customersRead === 2);
    ok("leadsRead counted", report.leadsRead === 2);
  }

  // 2. Dry-run leaves NO persistence, but counts are collected.
  {
    const seed: Seed = {
      businessIds: [1],
      customers: { 1: [{ id: 10, phone: "0501111111", taxId: "514777888" }] },
      leads: { 1: [{ id: 20, name: "No Signal Lead" }] },
    };
    const { deps, persistent } = makeFakeBackfillDb(seed);
    const report = await runBackfill(deps, { mode: "dry-run" });

    ok("dry-run persists no parties", persistent.parties.length === 0);
    ok("dry-run persists no claims", persistent.claims.length === 0);
    ok("counts collected: signal claims > 0", report.totals.signalClaims > 0);
    ok("counts collected: anchor claims > 0", report.totals.anchorClaims > 0);
    ok("no-signal lead tallied as singleton", report.totals.singleton === 1);
  }

  // 3. Existing service is driven: same phone in one business -> one party.
  {
    const seed: Seed = {
      businessIds: [1],
      customers: { 1: [{ id: 10, phone: "050-111-1111" }] },
      leads: { 1: [{ id: 20, phone: "0501111111" }] },
    };
    const { deps } = makeFakeBackfillDb(seed);
    const report = await backfillBusiness(deps, 1, "dry-run");
    ok("same phone -> one party touched", report.partiesTouched === 1);
    ok("both rows applied via service", report.applied === 2);
    ok("two signal claims created", report.signalClaims === 2);
  }

  // 4. Tenant scoping: same phone in two businesses -> independent parties.
  {
    const seed: Seed = {
      businessIds: [1, 2],
      customers: {
        1: [{ id: 10, phone: "0501111111" }],
        2: [{ id: 11, phone: "0501111111" }],
      },
      leads: {},
    };
    const { deps } = makeFakeBackfillDb(seed);
    const report = await runBackfill(deps, { mode: "dry-run" });
    const b1 = report.perBusiness.find((b) => b.businessId === 1)!;
    const b2 = report.perBusiness.find((b) => b.businessId === 2)!;
    ok("two businesses reported separately", report.perBusiness.length === 2);
    ok("business 1 resolved independently", b1.applied === 1 && b1.partiesTouched === 1);
    ok("business 2 resolved independently (not linked across tenant)", b2.applied === 1 && b2.partiesTouched === 1);
  }

  // 5. Failure isolation: one business failing does not affect the others.
  {
    const seed: Seed = {
      businessIds: [1, 2, 3],
      customers: {
        1: [{ id: 10, phone: "0501111111" }],
        3: [{ id: 30, phone: "0503333333" }],
      },
      leads: {},
      failCustomersFor: 2,
    };
    const { deps } = makeFakeBackfillDb(seed);
    const report = await runBackfill(deps, { mode: "dry-run" });
    const b2 = report.perBusiness.find((b) => b.businessId === 2)!;
    ok("all three businesses present in report", report.perBusiness.length === 3);
    ok("failed business is marked failed", b2.failed === true && !!b2.error);
    ok("failed business count in totals", report.totals.failedBusinesses === 1);
    ok(
      "other businesses processed despite failure",
      report.perBusiness.find((b) => b.businessId === 1)!.applied === 1 &&
        report.perBusiness.find((b) => b.businessId === 3)!.applied === 1
    );
  }

  // 6. Mode → runInTx dryRun flag (dry-run:true, execute:false).
  {
    const seed: Seed = {
      businessIds: [1],
      customers: { 1: [{ id: 10, phone: "0501111111" }] },
      leads: {},
    };
    const dry = makeFakeBackfillDb(seed);
    await runBackfill(dry.deps, { mode: "dry-run" });
    ok("dry-run uses runInTx dryRun:true", dry.txCalls.every((c) => c.dryRun === true) && dry.txCalls.length > 0);

    const exe = makeFakeBackfillDb(seed);
    await runBackfill(exe.deps, { mode: "execute" });
    ok("execute uses runInTx dryRun:false", exe.txCalls.every((c) => c.dryRun === false) && exe.txCalls.length > 0);
  }

  // 7. Execute mode persists; dry-run did not.
  {
    const seed: Seed = {
      businessIds: [1],
      customers: { 1: [{ id: 10, phone: "0501111111" }, { id: 11, phone: "0502222222" }] },
      leads: {},
    };
    const { deps, persistent } = makeFakeBackfillDb(seed);
    const report = await runBackfill(deps, { mode: "execute" });
    ok("execute persists parties", persistent.parties.length === 2);
    ok("execute persists claims", persistent.claims.length === 2);
    ok("execute counts applied", report.totals.applied === 2);
  }

  // 8. Batch size divides rows correctly (5 rows, batchSize 2 → 3 batches).
  {
    const seed: Seed = {
      businessIds: [1],
      customers: {
        1: [
          { id: 1, phone: "0500000001" },
          { id: 2, phone: "0500000002" },
          { id: 3, phone: "0500000003" },
          { id: 4, phone: "0500000004" },
          { id: 5, phone: "0500000005" },
        ],
      },
      leads: {},
    };
    const { deps, persistent } = makeFakeBackfillDb(seed);
    const report = await runBackfill(deps, { mode: "execute", batchSize: 2 });
    const b1 = report.perBusiness[0];
    ok("execute splits into ceil(5/2)=3 batches", b1.batches === 3);
    ok("all 5 rows persisted across batches", persistent.claims.length === 5);
    ok("totals.batches aggregated", report.totals.batches === 3);
  }

  // 9. Failed batch is isolated: prior committed batches survive, run continues.
  {
    const seed: Seed = {
      businessIds: [1],
      customers: {
        1: [
          { id: 1, phone: "0500000001" },
          { id: 2, phone: "0500000002" },
          { id: 3, phone: "0500000003" },
        ],
      },
      leads: {},
      failTxCall: 2, // batchSize 1 → 3 batches; batch 2 (row id 2) fails
    };
    const { deps, persistent } = makeFakeBackfillDb(seed);
    const report = await runBackfill(deps, { mode: "execute", batchSize: 1 });
    const b1 = report.perBusiness[0];
    ok("failed batch recorded", b1.batchesFailed === 1 && b1.batchErrors.length === 1);
    ok("committed batches survive (rows 1 & 3 persisted)", persistent.claims.length === 2);
    ok("failed batch's row not persisted", !persistent.claims.some((c) => c.subjectId === 2));
    ok("successful batches still counted", b1.applied === 2);
  }

  // 10. Execute rerun is idempotent (second run all-NOOP, no new rows).
  {
    const seed: Seed = {
      businessIds: [1],
      customers: { 1: [{ id: 10, phone: "0501111111" }, { id: 11, phone: "0502222222" }] },
      leads: {},
    };
    const { deps, persistent } = makeFakeBackfillDb(seed);
    await runBackfill(deps, { mode: "execute" });
    const claimsAfterFirst = persistent.claims.length;
    const partiesAfterFirst = persistent.parties.length;
    const second = await runBackfill(deps, { mode: "execute" });
    ok("rerun: all NOOP", second.totals.applied === 0 && second.totals.noop === 2);
    ok("rerun: no new claims", persistent.claims.length === claimsAfterFirst);
    ok("rerun: no new parties", persistent.parties.length === partiesAfterFirst);
  }

  // ── T2b-2 Health metrics ────────────────────────────────────────────────

  function claim(
    partyId: number,
    subjectId: number,
    signalType: HealthClaim["signalType"],
    signalValue: string | null,
    subjectType: PartyRoleType = PartyRoleType.CUSTOMER
  ): HealthClaim {
    return { partyId, subjectType, subjectId, signalType, signalValue };
  }

  // 11. buildHealth: multi-party signal is flagged as an invariant violation.
  {
    // Same PHONE value mapped to two different parties (1 and 2).
    const h = buildHealth(
      [
        claim(1, 10, PartySignalType.PHONE, "+972500000000"),
        claim(2, 11, PartySignalType.PHONE, "+972500000000"),
      ],
      0
    );
    ok("multi-party signal counted", h.multiPartySignals === 1);
    ok("multi-party signal → invariantViolation true", h.invariantViolation === true);
    ok("multi-party signal sampled", h.multiPartySignalSamples.length === 1);
    ok("multi-party signal in anomalyCount", h.anomalyCount === 1);
  }

  // 12. buildHealth: clean exact-match data → no invariant violation.
  {
    // Same phone → one party (legitimate unification); distinct phones → distinct.
    const h = buildHealth(
      [
        claim(1, 10, PartySignalType.PHONE, "+972500000000"),
        claim(1, 11, PartySignalType.PHONE, "+972500000000"),
        claim(2, 12, PartySignalType.PHONE, "+972511111111"),
      ],
      0
    );
    ok("clean data: no multi-party signal", h.multiPartySignals === 0);
    ok("clean data: invariantViolation false", h.invariantViolation === false);
  }

  // 13. buildHealth: histogram buckets computed correctly.
  {
    // party 1: 1 member · party 2: 2 · party 3: 4 (3-5) · party 4: 8 (6-10) · party 5: 12 (>10)
    const claims: HealthClaim[] = [];
    const sizes: Record<number, number> = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 12 };
    let subjectId = 1;
    for (const [pid, n] of Object.entries(sizes)) {
      for (let i = 0; i < n; i++) {
        claims.push(claim(Number(pid), subjectId++, null, null));
      }
    }
    const h = buildHealth(claims, 0);
    ok("histogram bucket 1", h.memberHistogram["1"] === 1);
    ok("histogram bucket 2", h.memberHistogram["2"] === 1);
    ok("histogram bucket 3-5", h.memberHistogram["3-5"] === 1);
    ok("histogram bucket 6-10", h.memberHistogram["6-10"] === 1);
    ok("histogram bucket >10", h.memberHistogram[">10"] === 1);
  }

  // 14. buildHealth: top outliers sorted by member count, threshold honored.
  {
    const claims: HealthClaim[] = [];
    let subjectId = 1;
    const sizes: Record<number, number> = { 1: 2, 2: 9, 3: 5 };
    for (const [pid, n] of Object.entries(sizes)) {
      for (let i = 0; i < n; i++) {
        claims.push(claim(Number(pid), subjectId++, null, null));
      }
    }
    const h = buildHealth(claims, 0, 4); // threshold 4 → parties with >4 members
    ok("top outlier is largest party", h.topOutliers[0].partyId === 2 && h.topOutliers[0].memberCount === 9);
    ok("outliers sorted desc", h.topOutliers[1].memberCount === 5);
    ok("oversized counted (>threshold)", h.oversizedParties === 2); // 9 and 5
    ok("oversizedThreshold reported", h.oversizedThreshold === 4);
  }

  // 15. buildHealth: conflict anchors flow into anomaly count.
  {
    const h = buildHealth([claim(1, 10, null, null)], 3);
    ok("conflict anchors reported", h.conflictAnchors === 3);
    ok("conflict anchors in anomaly count", h.anomalyCount === 3);
    ok("conflict anchors alone → no invariant violation", h.invariantViolation === false);
  }

  // 16. Runner: dry-run and execute both produce a health report.
  {
    const seed: Seed = {
      businessIds: [1],
      customers: { 1: [{ id: 10, phone: "0501111111" }] },
      leads: {},
    };
    const dry = makeFakeBackfillDb(seed);
    const dryReport = await runBackfill(dry.deps, { mode: "dry-run" });
    ok("dry-run report has health", dryReport.health !== undefined && dryReport.perBusiness[0].health !== undefined);

    const exe = makeFakeBackfillDb(seed);
    const exeReport = await runBackfill(exe.deps, { mode: "execute" });
    ok("execute report has health", exeReport.health !== undefined && exeReport.perBusiness[0].health !== undefined);
  }

  // 17. Runner: oversized party is an observational anomaly, NOT a failed business.
  {
    // 3 customers share one phone → one party with 3 members; threshold 2 → oversized.
    const seed: Seed = {
      businessIds: [1],
      customers: {
        1: [
          { id: 1, phone: "0509999999" },
          { id: 2, phone: "0509999999" },
          { id: 3, phone: "0509999999" },
        ],
      },
      leads: {},
    };
    const { deps } = makeFakeBackfillDb(seed);
    const report = await runBackfill(deps, { mode: "execute", oversizedThreshold: 2 });
    const b = report.perBusiness[0];
    ok("oversized party detected", b.health.oversizedParties === 1);
    ok("oversized business NOT failed", b.failed === false && report.totals.failedBusinesses === 0);
    ok("oversized counted in run-level health", report.health.oversizedParties === 1);
  }

  // 18. Runner: conflict outcome counted as conflict anchor in health.
  {
    // c1 phone P → party A; c2 taxId T → party B; c3 phone P + taxId T → CONFLICT.
    const seed: Seed = {
      businessIds: [1],
      customers: {
        1: [
          { id: 1, phone: "0508888888" },
          { id: 2, taxId: "514000000" },
          { id: 3, phone: "0508888888", taxId: "514000000" },
        ],
      },
      leads: {},
    };
    const { deps } = makeFakeBackfillDb(seed);
    const report = await runBackfill(deps, { mode: "execute" });
    const b = report.perBusiness[0];
    ok("conflict outcome recorded", b.conflict === 1);
    ok("conflict anchor in business health", b.health.conflictAnchors === 1);
    ok("conflict anchor in run-level health", report.health.conflictAnchors === 1);
    ok("conflict business NOT failed", b.failed === false);
  }

  if (failed > 0) {
    console.error(`\n${failed} party backfill T2a check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll party backfill T2a checks passed.");
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
