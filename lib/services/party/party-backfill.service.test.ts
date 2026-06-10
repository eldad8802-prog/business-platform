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
  iterateRoleRows,
  runBackfill,
  type BackfillDeps,
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
};

function makeFakeBackfillDb(seed: Seed) {
  const persistent: TxState = {
    parties: [],
    claims: [],
    nextPartyId: 1,
    nextClaimId: 1,
  };

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

  return { deps, persistent };
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
