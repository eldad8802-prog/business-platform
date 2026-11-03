/**
 * Revenue sources — a Z report that may ALREADY be counted elsewhere. READ-ONLY. docs/revenue-report-uploads.md
 * "Owner decisions" D-2 / D-12, and "Z duplicate suspicion".
 *
 * Every overlap carries its BASIS and its EFFECT. Only two bases hold a Z out of the count, and only until the owner
 * decides (a CONFIRMED decision on that Z counts it, a REJECTED one leaves it out — the owner's call, never ours):
 *
 *   Z_DOCUMENT_SAME_DAY   (HOLD, D-2) an approved income document of the Z's business day whose text reads as a Z
 *                         report (revenue-report-guard.ts, the same phrases the documents Z-guard asks about) — i.e.
 *                         "a Z was already recorded as a financial document": further counting stops until resolved.
 *   HISTORY_SAME_DAY      (HOLD, D-12) imported history issued on the Z's day — per Z (register + day), never a
 *                         period. Read only while IMPORTED_HISTORY_OVERLAP_ENABLED (below) is true: it is FALSE.
 *
 *   AMOUNT_SAME_DAY       (QUESTION) an approved income document of that day for exactly the Z's total, whose text
 *                         does NOT read as a Z. Same day + same amount is NOT proof: nothing is held out, nothing is
 *                         removed, nothing is confirmed — both the Z and the document keep counting where they count,
 *                         and the owner is asked (read model warning CLOSE_DUPLICATE_SUSPECTED, preview question).
 *
 * The documents Z-guard answer (`confirmedNotRevenueReport`) is NOT persisted (app/api/documents/[id]/approve reads it
 * and stores nothing), so D-2 is recognised from what IS stored. Nothing here writes, links, decides, merges or deletes
 * anything; an overlap never blocks an upload and never changes a row.
 *
 * Proven on synthetic rows only (revenue-report-core.test.ts, read-model.test.ts, .rru/battery.ts) — the rule, not
 * any real format.
 */
import { HISTORY_OVERLAP_MAX_DAYS, readHistoryOverlapInTx } from "@/lib/data-transfer/historical/historical-overlap-reader";
import { detectRevenueReport } from "@/lib/services/documents/revenue-report-guard";
import type { TenantTxClient } from "@/lib/tenant/tenant-tx";
import { jerusalemDayKey, jerusalemDayUtcHalfOpen } from "@/lib/utils/jerusalem-day";

/**
 * D-12: whether imported history is READ for overlaps. A literal, not an environment variable: switching it on is a
 * reviewed code change after the owner's go (docs "Imported history: the overlap reader"), never a configuration
 * switch. While false, `importedHistory` is always empty and the reader is never reached, in every environment.
 */
export const IMPORTED_HISTORY_OVERLAP_ENABLED = false;

/** An approved income document's record (FinancialRecord, direction income). Amounts are ILS (the record has no currency). */
export type RecordedIncomeEvidence = { financialRecordId: number; documentId: number; day: string; amountMinor: bigint; looksLikeZ: boolean };
/** One imported history document with an issue day (only date, total, currency, source system — the reader's columns). */
export type ImportedHistoryEvidence = {
  historicalDocumentId: number;
  day: string;
  totalMinor: bigint | null;
  currency: string | null;
  sourceSystemCode: string;
};
export type OverlapEvidence = { recordedIncome: RecordedIncomeEvidence[]; importedHistory: ImportedHistoryEvidence[] };

export type CloseOverlapKind = "RECORDED_INCOME_DOCUMENT" | "IMPORTED_HISTORY";
export type CloseOverlapBasis = "Z_DOCUMENT_SAME_DAY" | "AMOUNT_SAME_DAY" | "HISTORY_SAME_DAY";
/** HOLD: the Z waits for the owner (D-2 / D-12). QUESTION: a suspicion only — counted as before, the owner is asked. */
export type CloseOverlapEffect = "HOLD" | "QUESTION";
export type CloseOverlap = { overlap: CloseOverlapKind; basis: CloseOverlapBasis; effect: CloseOverlapEffect; ref: string };

export const OVERLAP_EFFECT: Readonly<Record<CloseOverlapBasis, CloseOverlapEffect>> = Object.freeze({
  Z_DOCUMENT_SAME_DAY: "HOLD",
  HISTORY_SAME_DAY: "HOLD",
  AMOUNT_SAME_DAY: "QUESTION",
});

/** What a Z overlaps (empty: nothing). Pure. */
export function closeOverlapsOf(
  close: { businessDay: string; currency: string; totalMinor: bigint },
  evidence: OverlapEvidence
): CloseOverlap[] {
  const out: CloseOverlap[] = [];
  const add = (overlap: CloseOverlapKind, basis: CloseOverlapBasis, ref: string) => out.push({ overlap, basis, effect: OVERLAP_EFFECT[basis], ref });
  for (const r of evidence.recordedIncome) {
    if (r.day !== close.businessDay) continue;
    if (r.looksLikeZ) add("RECORDED_INCOME_DOCUMENT", "Z_DOCUMENT_SAME_DAY", `document:${r.documentId}`);
    // Exact equality only: no tolerance (D-8). A record has no currency of its own — compared as ILS only.
    // A suspicion, never proof: QUESTION (see the header).
    else if (close.currency === "ILS" && r.amountMinor === close.totalMinor) add("RECORDED_INCOME_DOCUMENT", "AMOUNT_SAME_DAY", `document:${r.documentId}`);
  }
  for (const h of evidence.importedHistory) {
    if (h.day === close.businessDay) add("IMPORTED_HISTORY", "HISTORY_SAME_DAY", `history:${h.historicalDocumentId}`);
  }
  return out;
}

/** True when an overlap holds the Z out of the count until the owner decides. */
export function holdsClose(overlaps: readonly Pick<CloseOverlap, "effect">[]): boolean {
  return overlaps.some((o) => o.effect === "HOLD");
}

/** A record's amount (a Float of shekels) in agorot. */
function agorot(amount: number): bigint {
  return BigInt(Math.round(amount * 100));
}

/** A history total (decimal text, two places) in minor units; null when the source recorded none. */
function historyMinor(total: string | null): bigint | null {
  if (total === null) return null;
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(total);
  if (!m) return null;
  const v = BigInt(m[2]) * BigInt(100) + BigInt(m[3]);
  return m[1] ? -v : v;
}

/**
 * D-12: imported history of these days, through the one narrow reader (five columns, this business, this tenant
 * transaction). Reached from loadOverlapEvidenceInTx ONLY while IMPORTED_HISTORY_OVERLAP_ENABLED; exported so the lab
 * battery can prove its isolation without switching anything on.
 */
export async function loadImportedHistoryEvidenceInTx(tx: TenantTxClient, businessId: number, days: readonly string[]): Promise<ImportedHistoryEvidence[]> {
  const wanted = new Set(days);
  if (wanted.size === 0) return [];
  const sorted = [...wanted].sort();
  // Windows the reader accepts (at most HISTORY_OVERLAP_MAX_DAYS calendar days each), in order.
  const rows: Awaited<ReturnType<typeof readHistoryOverlapInTx>> = [];
  for (let i = 0; i < sorted.length; ) {
    const start = sorted[i];
    const limit = Date.parse(`${start}T00:00:00Z`) + (HISTORY_OVERLAP_MAX_DAYS - 1) * 86_400_000;
    let j = i;
    while (j + 1 < sorted.length && Date.parse(`${sorted[j + 1]}T00:00:00Z`) <= limit) j++;
    rows.push(...(await readHistoryOverlapInTx(tx, businessId, { fromDay: start, toDay: sorted[j] })));
    i = j + 1;
  }
  return rows
    .filter((r) => wanted.has(r.issueDay))
    .map((r) => ({ historicalDocumentId: r.id, day: r.issueDay, totalMinor: historyMinor(r.totalAmount), currency: r.currency, sourceSystemCode: r.sourceSystemCode }));
}

/**
 * The overlap evidence on these business days, inside the caller's tenant transaction. SELECT only.
 * Approved income records; imported history only while IMPORTED_HISTORY_OVERLAP_ENABLED (false).
 */
export async function loadOverlapEvidenceInTx(tx: TenantTxClient, businessId: number, days: readonly string[]): Promise<OverlapEvidence> {
  const wanted = new Set(days);
  if (wanted.size === 0) return { recordedIncome: [], importedHistory: [] };
  const sorted = [...wanted].sort();
  const instants = { gte: jerusalemDayUtcHalfOpen(sorted[0]).from, lt: jerusalemDayUtcHalfOpen(sorted[sorted.length - 1]).toExclusive };
  const records = await tx.financialRecord.findMany({
    where: { businessId, direction: "income", date: instants },
    select: { id: true, documentId: true, amount: true, date: true, document: { select: { ocrText: true } } },
  });
  return {
    recordedIncome: records
      .map((r) => ({
        financialRecordId: r.id,
        documentId: r.documentId,
        day: jerusalemDayKey(r.date),
        amountMinor: agorot(r.amount),
        looksLikeZ: detectRevenueReport(r.document?.ocrText)?.kind === "z_report",
      }))
      .filter((r) => wanted.has(r.day)),
    importedHistory: IMPORTED_HISTORY_OVERLAP_ENABLED ? await loadImportedHistoryEvidenceInTx(tx, businessId, [...wanted]) : [],
  };
}
