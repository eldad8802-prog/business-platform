/**
 * העלאת דוחות וקבצים — the database reads behind GET /api/money/uploads. SERVER-ONLY, READ-ONLY.
 *
 * Three reads, each tenant-scoped by the business from the session:
 *   1. bankFileImportState — where the bank card routes (fail-closed: an error is UNKNOWN, never ON/OFF);
 *   2. the import ledger's recent runs — through `listRecentImportRuns`, because import-run-store.ts is the
 *      ledger's only accessor (CI-IL-14);
 *   3. old-path bank uploads — ExternalTransaction rows of source OWNER_UPLOAD whose importBatchId starts
 *      with "upl-" (payables-observation.service.ts `uploadStatement`), grouped per batch. Bank file import
 *      writes "bnk-<runId>" batches, which are already listed through their ImportRun and so excluded here.
 *
 * The grouping selects counts and dates only — never an amount, a description or a counterparty. All the
 * shaping lives in uploads-overview.ts, which is pure and unit-tested.
 */
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { runWithTenantContext } from "@/lib/tenant/context";
import { bankFileImportState } from "@/lib/services/bank-file-import/http";
import { listRecentImportRuns } from "@/lib/data-transfer/import/execute/import-run-store";
import { IMPORT_EXPORT_RELEASED } from "@/components/settings/import-export/import-export-release";
import {
  HISTORY_LIMIT,
  buildUploadsOverview,
  type LegacyBatchInput,
  type UploadsOverview,
} from "./uploads-overview";

/** The old statement upload's batch prefix (`upl-<base36 timestamp>`). */
export const LEGACY_BATCH_PREFIX = "upl-";

async function listLegacyBankBatches(businessId: number, limit: number): Promise<LegacyBatchInput[]> {
  return runWithTenantContext({ businessId }, () =>
    withTenantTransaction(async (tx) => {
      const groups = await tx.externalTransaction.groupBy({
        by: ["importBatchId", "sourceBankAccountId"],
        where: { businessId, source: "OWNER_UPLOAD", importBatchId: { startsWith: LEGACY_BATCH_PREFIX } },
        _count: { _all: true },
        _min: { bookedAt: true, createdAt: true },
        _max: { bookedAt: true },
        orderBy: { _min: { createdAt: "desc" } },
        take: limit,
      });

      // One upload carries one account (or none), so (batch, account) is one batch. The masked label is read
      // the way the payables screens read it: the owner's label and the last four digits, nothing else.
      const accountIds = [...new Set(groups.map((g) => g.sourceBankAccountId).filter((id): id is number => id != null))];
      const accounts = accountIds.length
        ? await tx.businessBankAccount.findMany({
            where: { businessId, id: { in: accountIds } },
            select: { id: true, label: true, accountLast4: true },
          })
        : [];
      const byId = new Map(accounts.map((a) => [a.id, { label: a.label, last4: a.accountLast4 }]));

      return groups
        .filter((g) => g.importBatchId != null && g._min.createdAt != null)
        .map((g) => ({
          importBatchId: g.importBatchId as string,
          lineCount: g._count._all,
          firstBookedAt: g._min.bookedAt,
          lastBookedAt: g._max.bookedAt,
          createdAt: g._min.createdAt as Date,
          account: g.sourceBankAccountId != null ? byId.get(g.sourceBankAccountId) ?? null : null,
        }));
    })
  );
}

/**
 * The three reads are independent: a history read that fails (a missing table, a timeout) must not take the bank
 * card with it — the bank route is the flag's decision alone. bankFileImportState is already fail-closed (an error
 * is UNKNOWN). A failed history read is logged by name only and returned as null → `historyAvailable: false`.
 */
export async function getUploadsOverview(businessId: number, now: Date = new Date()): Promise<UploadsOverview> {
  const [bankState, runs, legacyBatches] = await Promise.all([
    bankFileImportState(businessId),
    listRecentImportRuns(businessId, HISTORY_LIMIT).catch((e: unknown) => historyReadFailed("import runs", e)),
    listLegacyBankBatches(businessId, HISTORY_LIMIT).catch((e: unknown) => historyReadFailed("old bank uploads", e)),
  ]);
  return buildUploadsOverview({ bankState, runs, legacyBatches, now, importAvailable: IMPORT_EXPORT_RELEASED });
}

function historyReadFailed(what: string, e: unknown): null {
  console.error("[money-uploads] history read failed:", what, e instanceof Error ? e.name : "unknown");
  return null;
}
