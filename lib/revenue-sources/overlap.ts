/**
 * Revenue sources — a Z report that may ALREADY be counted elsewhere. READ-ONLY. docs/revenue-report-uploads.md
 * "Owner decisions" D-2 / D-12.
 *
 *   D-2   A Z the owner already recorded as an income document (the documents inbox, approved as income — e.g. after
 *         answering the Z-guard question "not a Z — record anyway"). That answer is NOT persisted anywhere
 *         (app/api/documents/[id]/approve reads `confirmedNotRevenueReport` and stores nothing), so the overlap is
 *         recognised from what IS stored: an approved income FinancialRecord on the Z's business day whose document
 *         text reads as a Z report (revenue-report-guard.ts, the same phrases the guard asks about), or whose amount
 *         equals the Z's total exactly.
 *   D-12  Imported history issued on the Z's business day. History carries no register, so this is per Z (register +
 *         day) — never a whole period blocked because dates overlap. The RULE is here (closeOverlapsOf); the loader
 *         does NOT read the imported-history table: that table has a consumer firewall (only its import and erasure
 *         contracts may name it — historical-fiscal-persistence.verify.test.ts), and a new reader is its own owner
 *         decision. Until then `importedHistory` is always empty in production code.
 *
 * An overlap does not block the upload and changes no row: the Z is recorded as evidence, and the read model leaves
 * it uncounted (CLOSE_OVERLAP_UNRESOLVED) until the owner's CONFIRMED decision on that Z resolves it. Nothing here
 * writes, merges or deletes anything.
 *
 * Proven on synthetic rows only (revenue-report-core.test.ts, .rru/battery.ts) — the rule, not any real format.
 */
import { detectRevenueReport } from "@/lib/services/documents/revenue-report-guard";
import type { TenantTxClient } from "@/lib/tenant/tenant-tx";
import { jerusalemDayKey, jerusalemDayUtcHalfOpen } from "@/lib/utils/jerusalem-day";

/** An approved income document's record (FinancialRecord, direction income). Amounts are ILS (the record has no currency). */
export type RecordedIncomeEvidence = { financialRecordId: number; documentId: number; day: string; amountMinor: bigint; looksLikeZ: boolean };
/** One imported history document with an issue date (supplied by a caller; not loaded here — see D-12 above). */
export type ImportedHistoryEvidence = { historicalDocumentId: number; day: string; sourceSystemCode: string };
export type OverlapEvidence = { recordedIncome: RecordedIncomeEvidence[]; importedHistory: ImportedHistoryEvidence[] };

export type CloseOverlapKind = "RECORDED_INCOME_DOCUMENT" | "IMPORTED_HISTORY";
export type CloseOverlap = { overlap: CloseOverlapKind; ref: string };

/** What a Z overlaps (empty: nothing). Pure. */
export function closeOverlapsOf(
  close: { businessDay: string; currency: string; totalMinor: bigint },
  evidence: OverlapEvidence
): CloseOverlap[] {
  const out: CloseOverlap[] = [];
  for (const r of evidence.recordedIncome) {
    if (r.day !== close.businessDay) continue;
    // Exact equality only: no tolerance (D-8). A record has no currency of its own — compared as ILS only.
    if (r.looksLikeZ || (close.currency === "ILS" && r.amountMinor === close.totalMinor)) {
      out.push({ overlap: "RECORDED_INCOME_DOCUMENT", ref: `document:${r.documentId}` });
    }
  }
  for (const h of evidence.importedHistory) {
    if (h.day === close.businessDay) out.push({ overlap: "IMPORTED_HISTORY", ref: `history:${h.historicalDocumentId}` });
  }
  return out;
}

/** A record's amount (a Float of shekels) in agorot. */
function agorot(amount: number): bigint {
  return BigInt(Math.round(amount * 100));
}

/**
 * The overlap evidence on these business days, inside the caller's tenant transaction. SELECT only.
 * Approved income records only; imported history is not read (D-12, the history table's consumer firewall).
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
    importedHistory: [],
  };
}
