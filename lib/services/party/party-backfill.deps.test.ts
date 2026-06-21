/**
 * Party Backfill Prisma deps + migrations guard — T2d (run manually):
 *   npx tsx lib/services/party/party-backfill.deps.test.ts
 *
 * Uses a MOCK Prisma client only — no real DB, no migration run, no backfill run.
 */
import { PartyRoleType, PartySignalType, Prisma } from "@prisma/client";
import {
  BACKFILL_TX_OPTIONS,
  REQUIRED_PARTY_MIGRATIONS,
  assertMigrationsApplied,
  buildPrismaBackfillDeps,
  buildPrismaVerificationDeps,
  listAppliedMigrations,
  type BackfillPrismaClient,
} from "@/lib/services/party/party-backfill.deps";

let failed = 0;
function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

type MockSeed = {
  migrations?: string[];
  customers?: Record<number, Array<{ id: number; phone: string | null; taxId: string | null; name: string | null }>>;
  leads?: Record<number, Array<{ id: number; phone: string | null; customerName: string | null }>>;
  parties?: Record<number, Array<{ id: number; businessId: number }>>;
  claims?: Record<
    number,
    Array<{
      partyId: number;
      subjectType: PartyRoleType;
      subjectId: number;
      signalType: PartySignalType | null;
      signalValue: string | null;
      source: string;
      status?: string;
    }>
  >;
  businessIds?: number[];
};

type TxObservation = {
  calls: number;
  lastThrew: boolean;
  lastOpts?: { maxWait?: number; timeout?: number };
};

function makeMockClient(seed: MockSeed) {
  const tx: TxObservation = { calls: 0, lastThrew: false };
  const whereBusinessId = (args: { where?: Record<string, unknown> }) =>
    Number(args.where?.businessId);

  const client: BackfillPrismaClient = {
    $queryRawUnsafe: (async () => {
      const applied = seed.migrations ?? [...REQUIRED_PARTY_MIGRATIONS];
      return applied.map((m) => ({ migration_name: m }));
    }) as BackfillPrismaClient["$queryRawUnsafe"],
    $transaction: (async (
      fn: (t: Prisma.TransactionClient) => Promise<unknown>,
      opts?: { maxWait?: number; timeout?: number }
    ) => {
      tx.calls += 1;
      tx.lastThrew = false;
      tx.lastOpts = opts;
      try {
        return await fn({} as Prisma.TransactionClient);
      } catch (err) {
        tx.lastThrew = true;
        throw err;
      }
    }) as BackfillPrismaClient["$transaction"],
    business: {
      findMany: async () => (seed.businessIds ?? []).map((id) => ({ id })),
    },
    customer: {
      findMany: async (args) => seed.customers?.[whereBusinessId(args)] ?? [],
    },
    lead: {
      findMany: async (args) => seed.leads?.[whereBusinessId(args)] ?? [],
    },
    party: {
      findMany: async (args) => seed.parties?.[whereBusinessId(args)] ?? [],
    },
    partyResolutionClaim: {
      findMany: async (args) => {
        const rows = seed.claims?.[whereBusinessId(args)] ?? [];
        // mirror the ACTIVE-status filter the wiring requests
        const status = (args.where?.status as string) ?? undefined;
        return rows
          .filter((r) => status === undefined || (r.status ?? "ACTIVE") === status)
          .map((r) => ({
            partyId: r.partyId,
            subjectType: r.subjectType,
            subjectId: r.subjectId,
            signalType: r.signalType,
            signalValue: r.signalValue,
            source: r.source,
          }));
      },
    },
  };
  return { client, tx };
}

async function runTests() {
  // 1. Migrations applied → guard passes.
  {
    const { client } = makeMockClient({ migrations: [...REQUIRED_PARTY_MIGRATIONS, "other_migration"] });
    let threw = false;
    try {
      await assertMigrationsApplied(client);
    } catch {
      threw = true;
    }
    ok("migrations applied → no throw", threw === false);
    const list = await listAppliedMigrations(client);
    ok("listAppliedMigrations returns names", list.includes(REQUIRED_PARTY_MIGRATIONS[0]));
  }

  // 2. Missing a Party migration → guard fails closed.
  {
    const { client } = makeMockClient({ migrations: [REQUIRED_PARTY_MIGRATIONS[0]] }); // second missing
    let message = "";
    try {
      await assertMigrationsApplied(client);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    ok("missing migration → throws", message.length > 0);
    ok("missing migration named in error", message.includes(REQUIRED_PARTY_MIGRATIONS[1]));
  }

  // 3. No migrations at all → fail closed.
  {
    const { client } = makeMockClient({ migrations: [] });
    let threw = false;
    try {
      await assertMigrationsApplied(client);
    } catch {
      threw = true;
    }
    ok("no migrations → throws", threw === true);
  }

  // 4. runInTx dry-run rolls back (throws inside tx) yet returns the result.
  {
    const { client, tx } = makeMockClient({});
    const deps = buildPrismaBackfillDeps(client);
    const result = await deps.runInTx(async () => "WORK_DONE", { dryRun: true });
    ok("dry-run returns work result", result === "WORK_DONE");
    ok("dry-run forced a rollback (tx threw)", tx.lastThrew === true);
    ok("dry-run used a transaction", tx.calls === 1);
    ok(
      "dry-run passes extended tx timeout",
      tx.lastOpts?.timeout === BACKFILL_TX_OPTIONS.timeout &&
        tx.lastOpts?.maxWait === BACKFILL_TX_OPTIONS.maxWait
    );
  }

  // 5. runInTx execute commits (no rollback throw).
  {
    const { client, tx } = makeMockClient({});
    const deps = buildPrismaBackfillDeps(client);
    const result = await deps.runInTx(async () => 42, { dryRun: false });
    ok("execute returns work result", result === 42);
    ok("execute did NOT roll back", tx.lastThrew === false);
    ok("execute used a transaction", tx.calls === 1);
    ok(
      "execute passes extended tx timeout",
      tx.lastOpts?.timeout === BACKFILL_TX_OPTIONS.timeout &&
        tx.lastOpts?.maxWait === BACKFILL_TX_OPTIONS.maxWait
    );
  }

  // 6. Backfill loaders filter by businessId.
  {
    const { client } = makeMockClient({
      businessIds: [1, 2],
      customers: {
        1: [{ id: 10, phone: "p1", taxId: "t1", name: "A" }],
        2: [{ id: 20, phone: "p2", taxId: null, name: "B" }],
      },
      leads: {
        1: [{ id: 11, phone: "lp1", customerName: "L1" }],
      },
    });
    const deps = buildPrismaBackfillDeps(client);
    ok("listBusinessIds", JSON.stringify(await deps.listBusinessIds()) === "[1,2]");
    const c1 = await deps.loadCustomers(1);
    ok("loadCustomers business 1", c1.length === 1 && c1[0].id === 10 && c1[0].taxId === "t1");
    const c2 = await deps.loadCustomers(2);
    ok("loadCustomers business 2", c2.length === 1 && c2[0].id === 20 && c2[0].name === "B");
    const l1 = await deps.loadLeads(1);
    ok("loadLeads maps customerName → name", l1.length === 1 && l1[0].name === "L1" && l1[0].phone === "lp1");
    const l2 = await deps.loadLeads(2);
    ok("loadLeads empty business", l2.length === 0);
  }

  // 7. Verification loaders filter by businessId + ACTIVE status.
  {
    const { client } = makeMockClient({
      businessIds: [1],
      customers: { 1: [{ id: 10, phone: "p", taxId: null, name: "A" }] },
      leads: { 1: [{ id: 11, phone: "lp", customerName: "L" }] },
      parties: { 1: [{ id: 100, businessId: 1 }] },
      claims: {
        1: [
          { partyId: 100, subjectType: PartyRoleType.CUSTOMER, subjectId: 10, signalType: PartySignalType.PHONE, signalValue: "p", source: "BACKFILL", status: "ACTIVE" },
          { partyId: 100, subjectType: PartyRoleType.LEAD, subjectId: 11, signalType: null, signalValue: null, source: "BACKFILL", status: "RETRACTED" },
        ],
      },
    });
    const vdeps = buildPrismaVerificationDeps(client);
    const subjects = await vdeps.loadCustomers(1);
    ok("verification loadCustomers ids only", subjects.length === 1 && subjects[0].id === 10);
    const parties = await vdeps.loadParties(1);
    ok("verification loadParties", parties.length === 1 && parties[0].businessId === 1);
    const claims = await vdeps.loadActiveClaims(1);
    ok("verification loadActiveClaims filters RETRACTED", claims.length === 1 && claims[0].subjectId === 10);
    ok("verification claim carries source", claims[0].source === "BACKFILL");
  }

  if (failed > 0) {
    console.error(`\n${failed} party backfill deps T2d check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll party backfill deps T2d checks passed.");
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
