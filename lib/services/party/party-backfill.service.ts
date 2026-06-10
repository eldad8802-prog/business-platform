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

export type BackfillMode = "dry-run" | "execute";

/** Default rows per committed batch in execute mode. */
export const DEFAULT_BATCH_SIZE = 200;

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
  batches: number;
  batchesFailed: number;
  batchErrors: string[];
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
    batches: number;
    batchesFailed: number;
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
    batches: 0,
    batchesFailed: 0,
    batchErrors: [],
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

type BatchTally = {
  applied: number;
  noop: number;
  singleton: number;
  conflict: number;
  signalClaims: number;
  anchorClaims: number;
  partyIds: number[];
};

function emptyBatchTally(): BatchTally {
  return {
    applied: 0,
    noop: 0,
    singleton: 0,
    conflict: 0,
    signalClaims: 0,
    anchorClaims: 0,
    partyIds: [],
  };
}

function tallyResult(
  t: BatchTally,
  result: ResolvePartyForRoleRowTxResult
): void {
  switch (result.outcome) {
    case "APPLIED":
      t.applied += 1;
      break;
    case "NOOP":
      t.noop += 1;
      break;
    case "SINGLETON":
      t.singleton += 1;
      break;
    case "CONFLICT":
      t.conflict += 1;
      break;
  }
  for (const claim of result.claims) {
    if (claim.signalType === null) {
      t.anchorClaims += 1;
    } else {
      t.signalClaims += 1;
    }
  }
  t.partyIds.push(result.party.id);
}

function mergeBatchTally(
  report: BusinessReport,
  partyIds: Set<number>,
  t: BatchTally
): void {
  report.applied += t.applied;
  report.noop += t.noop;
  report.singleton += t.singleton;
  report.conflict += t.conflict;
  report.signalClaims += t.signalClaims;
  report.anchorClaims += t.anchorClaims;
  for (const id of t.partyIds) partyIds.add(id);
}

function chunkRows(
  rows: RoleRowToProcess[],
  size: number
): RoleRowToProcess[][] {
  if (size <= 0) return [rows];
  const out: RoleRowToProcess[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    out.push(rows.slice(i, i + size));
  }
  return out;
}

/** Resolve one batch of role-rows; returns the batch tally (merged on success only). */
async function resolveBatch(
  tx: Prisma.TransactionClient,
  businessId: number,
  batch: RoleRowToProcess[]
): Promise<BatchTally> {
  const t = emptyBatchTally();
  for (const { subjectType, row } of batch) {
    const result = await resolvePartyForRoleRowTx(tx, {
      businessId,
      subjectType,
      subjectId: row.id,
      signals: signalsForRow(subjectType, row),
      source: BACKFILL_SOURCE,
    });
    tallyResult(t, result);
  }
  return t;
}

/**
 * Resolve all role-rows of one business.
 *
 *  - dry-run: a single rolled-back transaction over the whole business (accurate
 *    cross-row unification, zero persistence).
 *  - execute: one committed transaction PER BATCH (size = batchSize). A failed
 *    batch rolls back atomically and is recorded; previously committed batches are
 *    never lost, and the next batch sees committed data (cross-batch unification).
 *
 * Idempotency, conflict fail-safe, and anchors are delegated to
 * `resolvePartyForRoleRowTx` (unchanged). A failed batch's tally is NOT merged.
 */
export async function backfillBusiness(
  deps: BackfillDeps,
  businessId: number,
  mode: BackfillMode,
  batchSize: number = DEFAULT_BATCH_SIZE
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

  const dryRun = mode === "dry-run";
  // dry-run = single batch (whole business) so unification within the rolled-back
  // transaction is accurate; execute = per-batch committed transactions.
  const batches = dryRun ? [rows] : chunkRows(rows, batchSize);
  report.batches = batches.length;

  for (const batch of batches) {
    try {
      const batchTally = await deps.runInTx(
        (tx) => resolveBatch(tx, businessId, batch),
        { dryRun }
      );
      mergeBatchTally(report, partyIds, batchTally);
    } catch (error) {
      report.batchesFailed += 1;
      report.batchErrors.push(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  report.partiesTouched = partyIds.size;
  return report;
}

/**
 * Top-level orchestrator. Processes businesses one-by-one; a failure in one
 * business is isolated (recorded, never mixed into another) and the run continues.
 */
export async function runBackfill(
  deps: BackfillDeps,
  opts: { mode: BackfillMode; batchSize?: number }
): Promise<BackfillReport> {
  const startedAt = new Date().toISOString();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const businessIds = await deps.listBusinessIds();
  const perBusiness: BusinessReport[] = [];

  for (const businessId of businessIds) {
    try {
      perBusiness.push(
        await backfillBusiness(deps, businessId, opts.mode, batchSize)
      );
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
      acc.batches += b.batches;
      acc.batchesFailed += b.batchesFailed;
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
      batches: 0,
      batchesFailed: 0,
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
