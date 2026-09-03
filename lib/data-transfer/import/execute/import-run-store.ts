/**
 * The execution ledger's only accessor.
 *
 * Two tables, one job: make a bulk import replay-safe. Everything here is
 * tenant-scoped through the D2/P7 substrate, and every row it writes is an id,
 * a hash, an enum, a short code or a timestamp — never a value from the file.
 *
 * # The idempotency chain, top to bottom
 *
 *   ImportRun      unique on (businessId, contentHash, mappingHash, decisionsHash)
 *                  Re-submitting the same file with the same mapping and the
 *                  same decisions RESOLVES to the run that already exists.
 *   ImportRunRow   primary key (importRunId, sourceRowNumber)
 *                  Written in the SAME transaction as the business record, so a
 *                  record without its marker, or a marker without its record,
 *                  cannot exist.
 *
 * Together those mean a replay re-executes nothing: it finds the run, reads the
 * markers, and has no rows left to do.
 *
 * # Why creating the run races safely
 *
 * Two requests can reach `openOrResumeRun` at once. Both attempt the INSERT;
 * the unique index lets exactly one win, and the loser's P2002 is turned back
 * into a lookup. It is deliberately not a read-then-write, which would have a
 * window between the two.
 */

import { Prisma } from "@prisma/client";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction, type TenantTx } from "@/lib/tenant/transaction";
import type { DataTransferDomainId } from "@/lib/data-transfer/domains";
import type { RowErrorCode } from "@/lib/data-transfer/import/execute/execution-semantics";
import type { RunCounts, TerminalRunStatus } from "@/lib/data-transfer/import/execute/execution-semantics";

export type RunIdentity = {
  businessId: number;
  userId: number;
  domain: DataTransferDomainId;
  contentHash: string;
  mappingHash: string;
  decisionsHash: string;
  sheetName: string | null;
  totalRows: number;
};

export type OpenedRun = {
  id: number;
  status: "EXECUTING" | "COMPLETED" | "PARTIAL" | "FAILED";
  /** True when this call created the run; false when it resolved to one. */
  created: boolean;
  startedAt: Date;
  counts: {
    createdCount: number | null;
    skippedCount: number | null;
    failedCount: number | null;
  };
};

/**
 * Find the run for this exact (file, mapping, decisions), or create it.
 *
 * The returned `created: false` with a terminal status is the replay case, and
 * the caller reports the original outcome rather than doing anything again.
 */
export async function openOrResumeRun(
  identity: RunIdentity
): Promise<OpenedRun> {
  return runWithTenantContext({ businessId: identity.businessId }, async () => {
    const where = {
      businessId_contentHash_mappingHash_decisionsHash: {
        businessId: identity.businessId,
        contentHash: identity.contentHash,
        mappingHash: identity.mappingHash,
        decisionsHash: identity.decisionsHash,
      },
    };

    try {
      const run = await withTenantTransaction((tx) =>
        tx.importRun.create({
          data: {
            businessId: identity.businessId,
            userId: identity.userId,
            domain: identity.domain,
            contentHash: identity.contentHash,
            mappingHash: identity.mappingHash,
            decisionsHash: identity.decisionsHash,
            sheetName: identity.sheetName,
            totalRows: identity.totalRows,
          },
        })
      );
      return { ...toOpened(run), created: true };
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2002"
      ) {
        throw error;
      }
      // Lost the race, or this is a replay. Either way the run already exists.
      const existing = await withTenantTransaction((tx) =>
        tx.importRun.findUnique({ where })
      );
      if (!existing) {
        // The unique index rejected the insert, so a row matching it exists —
        // unless it belongs to another tenant, in which case RLS hides it and
        // the caller must not be told anything about it.
        throw new Error("Import run conflict could not be resolved");
      }
      return { ...toOpened(existing), created: false };
    }
  });
}

type RunRecord = {
  id: number;
  status: string;
  startedAt: Date;
  createdCount: number | null;
  skippedCount: number | null;
  failedCount: number | null;
};

function toOpened(run: RunRecord): Omit<OpenedRun, "created"> {
  return {
    id: run.id,
    status: run.status as OpenedRun["status"],
    startedAt: run.startedAt,
    counts: {
      createdCount: run.createdCount,
      skippedCount: run.skippedCount,
      failedCount: run.failedCount,
    },
  };
}

/**
 * Row numbers already marked for this run.
 *
 * Read from the MARKERS, never from the run counters: the counters are written
 * once at terminalization and say nothing about a run that was interrupted
 * before it got there.
 */
export async function loadExecutedRowNumbers(
  businessId: number,
  importRunId: number
): Promise<Set<number>> {
  return runWithTenantContext({ businessId }, async () => {
    const rows = await withTenantTransaction((tx) =>
      tx.importRunRow.findMany({
        where: { importRunId },
        select: { sourceRowNumber: true },
      })
    );
    return new Set(rows.map((r) => r.sourceRowNumber));
  });
}

export type MarkerInput = {
  importRunId: number;
  sourceRowNumber: number;
  action: "CREATE" | "SKIP";
  status: "CREATED" | "SKIPPED" | "FAILED";
  errorCode?: RowErrorCode | null;
};

/**
 * Write one row marker INSIDE the caller's transaction.
 *
 * Taking `tx` rather than opening its own is the entire point: the marker and
 * the business record it describes must commit or roll back together. A version
 * of this that opened its own transaction would silently break that, so there
 * deliberately is no such version.
 */
export async function markRow(tx: TenantTx, marker: MarkerInput): Promise<void> {
  await tx.importRunRow.create({
    data: {
      importRunId: marker.importRunId,
      sourceRowNumber: marker.sourceRowNumber,
      action: marker.action,
      status: marker.status,
      errorCode: marker.errorCode ?? null,
    },
  });
}

/**
 * Record a row that failed deterministically, in its own transaction.
 *
 * Safe precisely because there is nothing to be atomic with: the batch that
 * would have carried this row was rolled back, so no business record exists.
 * The marker records a finished outcome, which is why the table has no UPDATE
 * policy and why nothing ever needs one.
 */
export async function markFailedRow(
  businessId: number,
  marker: Omit<MarkerInput, "status">
): Promise<void> {
  await runWithTenantContext({ businessId }, () =>
    withTenantTransaction((tx) => markRow(tx, { ...marker, status: "FAILED" }))
  );
}

/**
 * Write the terminal status and the aggregate counts, once.
 *
 * After this the run can still report what it did even when its markers are
 * gone — which they will be, at the end of the 30-day retry window. The counts
 * are an audit snapshot and are never read to decide whether a row executes.
 */
export async function terminalizeRun(
  businessId: number,
  importRunId: number,
  status: TerminalRunStatus,
  counts: RunCounts
): Promise<void> {
  await runWithTenantContext({ businessId }, () =>
    withTenantTransaction((tx) =>
      tx.importRun.update({
        where: { id: importRunId },
        data: {
          status,
          createdCount: counts.createdCount,
          skippedCount: counts.skippedCount,
          failedCount: counts.failedCount,
          completedAt: new Date(),
        },
      })
    )
  );
}

/** The per-row outcomes of a finished run, for the owner's report. */
export async function loadRunRows(
  businessId: number,
  importRunId: number
): Promise<
  { sourceRowNumber: number; action: string; status: string; errorCode: string | null }[]
> {
  return runWithTenantContext({ businessId }, () =>
    withTenantTransaction((tx) =>
      tx.importRunRow.findMany({
        where: { importRunId },
        select: {
          sourceRowNumber: true,
          action: true,
          status: true,
          errorCode: true,
        },
        orderBy: { sourceRowNumber: "asc" },
      })
    )
  );
}
