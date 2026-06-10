import {
  PartyClaimStatus,
  PartyRoleType,
  PartySignalType,
  Prisma,
} from "@prisma/client";
import type { BackfillDeps } from "@/lib/services/party/party-backfill.service";
import type { VerificationDeps } from "@/lib/services/party/party-verification.service";

/**
 * Prisma wiring for the Party backfill runner + verification — Phase 1 T2d.
 *
 * Pure factories over an injected client: NO prisma instance is created here and
 * NOTHING runs at import. The manual entrypoint injects the real `prisma`; tests
 * inject a mock. This is **wiring only** — it does not run a backfill, a dry-run,
 * a migration, or any query by itself.
 *
 * The migrations-applied guard is the fail-closed gate: before any run we prove
 * both Party migrations are applied in the target DB, otherwise we refuse.
 */

/** Both Party migrations that MUST be applied before any backfill run. */
export const REQUIRED_PARTY_MIGRATIONS = [
  "20260610140000_party_resolution_foundation_t1",
  "20260610150000_party_anchor_claim_t2_readiness",
] as const;

type FindManyArgs = {
  where?: Record<string, unknown>;
  select?: Record<string, boolean>;
};

/**
 * The minimal slice of `PrismaClient` the backfill/verification wiring needs.
 * Structural, so the real client (cast) and a test mock both satisfy it.
 */
export interface BackfillPrismaClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  business: { findMany(args: FindManyArgs): Promise<Array<{ id: number }>> };
  customer: {
    findMany(args: FindManyArgs): Promise<
      Array<{
        id: number;
        phone: string | null;
        taxId: string | null;
        name: string | null;
      }>
    >;
  };
  lead: {
    findMany(args: FindManyArgs): Promise<
      Array<{ id: number; phone: string | null; customerName: string | null }>
    >;
  };
  party: {
    findMany(args: FindManyArgs): Promise<Array<{ id: number; businessId: number }>>;
  };
  partyResolutionClaim: {
    findMany(args: FindManyArgs): Promise<
      Array<{
        partyId: number;
        subjectType: PartyRoleType;
        subjectId: number;
        signalType: PartySignalType | null;
        signalValue: string | null;
        source: string;
      }>
    >;
  };
}

/** Read the names of migrations recorded as fully applied in `_prisma_migrations`. */
export async function listAppliedMigrations(
  client: BackfillPrismaClient
): Promise<string[]> {
  const rows = await client.$queryRawUnsafe<Array<{ migration_name: string }>>(
    "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL"
  );
  return rows.map((r) => r.migration_name);
}

/**
 * Fail-closed guard: throws unless BOTH Party migrations are applied. Never
 * silently bypassed — a missing migration aborts before any run.
 */
export async function assertMigrationsApplied(
  client: BackfillPrismaClient
): Promise<void> {
  const applied = new Set(await listAppliedMigrations(client));
  const missing = REQUIRED_PARTY_MIGRATIONS.filter((m) => !applied.has(m));
  if (missing.length > 0) {
    throw new Error(
      `[party-backfill] Party migrations not applied in target DB: ` +
        `${missing.join(", ")}. Apply them before any run (fail-closed).`
    );
  }
}

/** Sentinel used to force a dry-run transaction to roll back. */
class DryRunRollback extends Error {
  constructor() {
    super("party-backfill dry-run rollback (expected)");
    this.name = "DryRunRollback";
  }
}

/**
 * Build the runner `BackfillDeps` over a Prisma client.
 *  - reads are `businessId`-scoped (tenant isolation by construction);
 *  - `runInTx` dry-run runs inside a transaction then throws a sentinel to ROLL
 *    BACK (zero persistence) while still returning the work's result; execute is
 *    an ordinary committed transaction.
 */
export function buildPrismaBackfillDeps(
  client: BackfillPrismaClient
): BackfillDeps {
  return {
    listBusinessIds: async () =>
      (await client.business.findMany({ select: { id: true } })).map((b) => b.id),

    loadCustomers: async (businessId) =>
      (
        await client.customer.findMany({
          where: { businessId },
          select: { id: true, phone: true, taxId: true, name: true },
        })
      ).map((c) => ({ id: c.id, phone: c.phone, taxId: c.taxId, name: c.name })),

    loadLeads: async (businessId) =>
      (
        await client.lead.findMany({
          where: { businessId },
          select: { id: true, phone: true, customerName: true },
        })
      ).map((l) => ({ id: l.id, phone: l.phone, name: l.customerName })),

    runInTx: async (fn, { dryRun }) => {
      if (!dryRun) {
        return client.$transaction((tx) => fn(tx));
      }
      let result: Awaited<ReturnType<typeof fn>> | undefined;
      let captured = false;
      try {
        await client.$transaction(async (tx) => {
          result = await fn(tx);
          captured = true;
          throw new DryRunRollback();
        });
      } catch (err) {
        if (!(err instanceof DryRunRollback)) throw err;
      }
      if (!captured) {
        throw new Error("party-backfill dry-run transaction did not complete");
      }
      return result as Awaited<ReturnType<typeof fn>>;
    },
  };
}

/** Build the read-only `VerificationDeps` over a Prisma client (ACTIVE claims). */
export function buildPrismaVerificationDeps(
  client: BackfillPrismaClient
): VerificationDeps {
  return {
    listBusinessIds: async () =>
      (await client.business.findMany({ select: { id: true } })).map((b) => b.id),

    loadCustomers: async (businessId) =>
      (
        await client.customer.findMany({
          where: { businessId },
          select: { id: true },
        })
      ).map((c) => ({ id: c.id })),

    loadLeads: async (businessId) =>
      (
        await client.lead.findMany({
          where: { businessId },
          select: { id: true },
        })
      ).map((l) => ({ id: l.id })),

    loadParties: async (businessId) =>
      (
        await client.party.findMany({
          where: { businessId },
          select: { id: true, businessId: true },
        })
      ).map((p) => ({ id: p.id, businessId: p.businessId })),

    loadActiveClaims: async (businessId) =>
      (
        await client.partyResolutionClaim.findMany({
          where: { businessId, status: PartyClaimStatus.ACTIVE },
          select: {
            partyId: true,
            subjectType: true,
            subjectId: true,
            signalType: true,
            signalValue: true,
            source: true,
          },
        })
      ).map((c) => ({
        partyId: c.partyId,
        subjectType: c.subjectType,
        subjectId: c.subjectId,
        signalType: c.signalType,
        signalValue: c.signalValue,
        source: c.source,
      })),
  };
}
