/**
 * The revenue overlap READER over imported history — one narrow, read-only accessor. docs/revenue-report-uploads.md
 * D-12 / "Imported history: the overlap reader".
 *
 * WHAT IT IS FOR
 *   A Z report the owner uploads may cover a day the business's PREVIOUS system already recorded (imported history).
 *   To stop counting such a Z until the owner decides (D-12), the revenue side needs to know, for ONE business and a
 *   SHORT day range, which history documents were issued on which day, for how much, from which source system.
 *   That and nothing else is what this file returns.
 *
 * WHY IT IS SAFE TO LIST IN THE CONSUMER FIREWALL (historical-fiscal-persistence.verify.test.ts)
 *   - one verb: `findMany`, no create / update / upsert / delete, no raw write;
 *   - five columns: id, issue date, total, currency, source system code — never a customer snapshot, a document
 *     number, an allocation number, a document link or a reversal;
 *   - one business: the `where` names `businessId`, and the caller's transaction must carry THAT business's tenant
 *     GUC (checked first, fail-closed) — so row-level security evaluates the same tenant the query names;
 *   - a bounded range (at most HISTORY_OVERLAP_MAX_DAYS days, at most HISTORY_OVERLAP_MAX_ROWS rows);
 *   - no global client: it is handed the caller's tenant transaction.
 *   The verifier holds this file to each of those rules by reading its source.
 *
 * NOT ACTIVE: the only caller (lib/revenue-sources/overlap.ts) reaches it only while IMPORTED_HISTORY_OVERLAP_ENABLED
 * is true, and that constant is `false` on this branch — a literal, not an environment variable, so turning it on
 * is a reviewed code change (the owner's go), never a configuration switch. Until then imported history is not read
 * by any revenue code path in any environment.
 */
import type { TenantTxClient } from "@/lib/tenant/tenant-tx";

/** At most this many calendar days per read (an upload / a read-model window is days, never years). */
export const HISTORY_OVERLAP_MAX_DAYS = 62;
/** At most this many rows per read; more is refused, never truncated silently. */
export const HISTORY_OVERLAP_MAX_ROWS = 5000;

export type HistoryOverlapRow = {
  id: number;
  /** The ORIGINAL issue day, `YYYY-MM-DD` (the column holds UTC midnight of that day — historical-date.ts). */
  issueDay: string;
  /** The total exactly as imported (decimal text), or null when the source recorded none. */
  totalAmount: string | null;
  currency: string | null;
  sourceSystemCode: string;
};

export class HistoryOverlapReadError extends Error {
  constructor(public readonly code: "BUSINESS_INVALID" | "RANGE_INVALID" | "RANGE_TOO_LONG" | "NOT_IN_TENANT" | "TOO_MANY_ROWS") {
    super(code);
    this.name = "HistoryOverlapReadError";
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const utcMidnight = (day: string) => new Date(`${day}T00:00:00.000Z`);

/**
 * The history documents of ONE business issued on a day in [fromDay, toDay] (inclusive calendar days), inside the
 * caller's tenant transaction for that business. Read only.
 */
export async function readHistoryOverlapInTx(
  tx: TenantTxClient,
  businessId: number,
  range: { fromDay: string; toDay: string }
): Promise<HistoryOverlapRow[]> {
  if (!Number.isInteger(businessId) || businessId <= 0) throw new HistoryOverlapReadError("BUSINESS_INVALID");
  if (!DAY.test(range.fromDay) || !DAY.test(range.toDay)) throw new HistoryOverlapReadError("RANGE_INVALID");
  const from = utcMidnight(range.fromDay);
  const toExclusive = new Date(utcMidnight(range.toDay).getTime() + 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(toExclusive.getTime()) || toExclusive <= from) throw new HistoryOverlapReadError("RANGE_INVALID");
  if ((toExclusive.getTime() - from.getTime()) / 86_400_000 > HISTORY_OVERLAP_MAX_DAYS) throw new HistoryOverlapReadError("RANGE_TOO_LONG");

  // The transaction must be THIS business's tenant transaction: the GUC row-level security evaluates.
  const guc = await tx.$queryRaw<Array<{ b: string | null }>>`SELECT current_setting('app.current_business_id', true) AS b`;
  if (guc[0]?.b !== String(businessId)) throw new HistoryOverlapReadError("NOT_IN_TENANT");

  const rows = await tx.historicalFiscalDocument.findMany({
    where: { businessId, originalIssueDate: { gte: from, lt: toExclusive } },
    select: { id: true, originalIssueDate: true, totalAmount: true, currency: true, sourceSystemCode: true },
    orderBy: { id: "asc" },
    take: HISTORY_OVERLAP_MAX_ROWS + 1,
  });
  if (rows.length > HISTORY_OVERLAP_MAX_ROWS) throw new HistoryOverlapReadError("TOO_MANY_ROWS");
  return rows.map((row) => ({
    id: row.id,
    issueDay: row.originalIssueDate!.toISOString().slice(0, 10),
    totalAmount: row.totalAmount === null ? null : row.totalAmount.toFixed(2),
    currency: row.currency,
    sourceSystemCode: row.sourceSystemCode,
  }));
}
