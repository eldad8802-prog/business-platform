import { PartyRoleType, Prisma } from "@prisma/client";
import {
  resolvePartyForRoleRowTx,
  type ResolvePartyForRoleRowTxResult,
} from "@/lib/services/party/party-resolution.service";

/**
 * Party Backfill — runner skeleton, DRY-RUN ONLY (Phase 1, T2a).
 *
 * A thin orchestrator: iterate businesses → role-rows → call the already-built
 * `resolvePartyForRoleRowTx(... source: "BACKFILL")`, accumulate counts, return a
 * report. **All resolution correctness lives in the service.** The runner owns
 * only control flow, per-business iteration, dry-run boundary, and reporting.
 *
 * T2a scope locks:
 *   - DRY-RUN ONLY. No execute mode (T2b/T2c). Dry-run leaves zero persistence.
 *   - Basic counts only. No health metrics / verification queries (T2b).
 *   - Dependency-injected (no live prisma import, no route/intake/Billing wiring).
 *   - No migration run, no backfill run, no production.
 */

export const BACKFILL_SOURCE = "BACKFILL";

export type BackfillMode = "dry-run";

/** Read-only role-row signal carrier (Customer or Lead). */
export type RoleRowInput = {
  id: number;
  phone?: string | null;
  taxId?: string | null; // Customers only; Leads have no taxId
  name?: string | null; // never a signal — read for completeness only
};

/**
 * Injected ports — keep the runner decoupled from the live DB and any route.
 * `runInTx` runs a unit of work in a transaction; `dryRun: true` rolls it back
 * so nothing persists (counts are accumulated out-of-band by the caller).
 */
export type BackfillDeps = {
  listBusinessIds: () => Promise<number[]>;
  loadCustomers: (businessId: number) => Promise<RoleRowInput[]>;
  loadLeads: (businessId: number) => Promise<RoleRowInput[]>;
  runInTx: <T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    opts: { dryRun: boolean }
  ) => Promise<T>;
};

export type BusinessReport = {
  businessId: number;
  customersRead: number;
  leadsRead: number;
  applied: number;
  noop: number;
  singleton: number; // no-signal anchor
  conflict: number;
  signalClaims: number;
  anchorClaims: number;
  partiesTouched: number;
  failed: boolean;
  error?: string;
};

export type BackfillReport = {
  mode: BackfillMode;
  startedAt: string;
  finishedAt: string;
  totals: {
    businesses: number;
    failedBusinesses: number;
    customersRead: number;
    leadsRead: number;
    applied: number;
    noop: number;
    singleton: number;
    conflict: number;
    signalClaims: number;
    anchorClaims: number;
  };
  perBusiness: BusinessReport[];
};

export type RoleRowToProcess = {
  subjectType: PartyRoleType;
  row: RoleRowInput;
};

function emptyBusinessReport(businessId: number): BusinessReport {
  return {
    businessId,
    customersRead: 0,
    leadsRead: 0,
    applied: 0,
    noop: 0,
    singleton: 0,
    conflict: 0,
    signalClaims: 0,
    anchorClaims: 0,
    partiesTouched: 0,
    failed: false,
  };
}

/**
 * Stable processing order for a business: Customers (by id) then Leads (by id).
 * Deterministic order → reproducible runs (exact-match end-state is order-independent).
 */
export async function iterateRoleRows(
  deps: BackfillDeps,
  businessId: number
): Promise<RoleRowToProcess[]> {
  const customers = (await deps.loadCustomers(businessId))
    .slice()
    .sort((a, b) => a.id - b.id);
  const leads = (await deps.loadLeads(businessId))
    .slice()
    .sort((a, b) => a.id - b.id);

  return [
    ...customers.map((row) => ({ subjectType: PartyRoleType.CUSTOMER, row })),
    ...leads.map((row) => ({ subjectType: PartyRoleType.LEAD, row })),
  ];
}

function signalsForRow(
  subjectType: PartyRoleType,
  row: RoleRowInput
): { phone?: string | null; taxId?: string | null } {
  // Customers carry phone + taxId; Leads carry phone only (no taxId field).
  return subjectType === PartyRoleType.CUSTOMER
    ? { phone: row.phone, taxId: row.taxId }
    : { phone: row.phone };
}

function tally(
  report: BusinessReport,
  partyIds: Set<number>,
  result: ResolvePartyForRoleRowTxResult
): void {
  switch (result.outcome) {
    case "APPLIED":
      report.applied += 1;
      break;
    case "NOOP":
      report.noop += 1;
      break;
    case "SINGLETON":
      report.singleton += 1;
      break;
    case "CONFLICT":
      report.conflict += 1;
      break;
  }
  for (const claim of result.claims) {
    if (claim.signalType === null) {
      report.anchorClaims += 1;
    } else {
      report.signalClaims += 1;
    }
  }
  partyIds.add(result.party.id);
}

/**
 * Resolve all role-rows of one business inside a single transaction.
 * In dry-run, the transaction is rolled back (zero persistence); the report is
 * accumulated in memory and survives the rollback.
 */
export async function backfillBusiness(
  deps: BackfillDeps,
  businessId: number,
  mode: BackfillMode
): Promise<BusinessReport> {
  const report = emptyBusinessReport(businessId);
  const partyIds = new Set<number>();

  const rows = await iterateRoleRows(deps, businessId);
  report.customersRead = rows.filter(
    (r) => r.subjectType === PartyRoleType.CUSTOMER
  ).length;
  report.leadsRead = rows.filter(
    (r) => r.subjectType === PartyRoleType.LEAD
  ).length;

  await deps.runInTx(
    async (tx) => {
      for (const { subjectType, row } of rows) {
        const result = await resolvePartyForRoleRowTx(tx, {
          businessId,
          subjectType,
          subjectId: row.id,
          signals: signalsForRow(subjectType, row),
          source: BACKFILL_SOURCE,
        });
        tally(report, partyIds, result);
      }
    },
    { dryRun: mode === "dry-run" }
  );

  report.partiesTouched = partyIds.size;
  return report;
}

/**
 * Top-level orchestrator. Processes businesses one-by-one; a failure in one
 * business is isolated (recorded, never mixed into another) and the run continues.
 */
export async function runBackfill(
  deps: BackfillDeps,
  opts: { mode: BackfillMode }
): Promise<BackfillReport> {
  const startedAt = new Date().toISOString();
  const businessIds = await deps.listBusinessIds();
  const perBusiness: BusinessReport[] = [];

  for (const businessId of businessIds) {
    try {
      perBusiness.push(await backfillBusiness(deps, businessId, opts.mode));
    } catch (error) {
      const failed = emptyBusinessReport(businessId);
      failed.failed = true;
      failed.error = error instanceof Error ? error.message : String(error);
      perBusiness.push(failed);
    }
  }

  const totals = perBusiness.reduce(
    (acc, b) => {
      acc.customersRead += b.customersRead;
      acc.leadsRead += b.leadsRead;
      acc.applied += b.applied;
      acc.noop += b.noop;
      acc.singleton += b.singleton;
      acc.conflict += b.conflict;
      acc.signalClaims += b.signalClaims;
      acc.anchorClaims += b.anchorClaims;
      if (b.failed) acc.failedBusinesses += 1;
      return acc;
    },
    {
      businesses: perBusiness.length,
      failedBusinesses: 0,
      customersRead: 0,
      leadsRead: 0,
      applied: 0,
      noop: 0,
      singleton: 0,
      conflict: 0,
      signalClaims: 0,
      anchorClaims: 0,
    }
  );

  return {
    mode: opts.mode,
    startedAt,
    finishedAt: new Date().toISOString(),
    totals,
    perBusiness,
  };
}
