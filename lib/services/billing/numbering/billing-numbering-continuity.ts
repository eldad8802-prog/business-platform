/**
 * Numbering continuity check — READ-ONLY.
 *
 * The computerized-system rules require a check of the running numbers of internal
 * documents (הוראות ניהול פנקסים, נספח ה' (א)(5)); the ITA booklet "הוראות ניהול
 * ספרים בסביבה ממוחשבת" reads it as an explicit list of the numbers that exist and
 * the numbers that are missing — a sorted list alone is not enough.
 *
 * For every issued fiscal series of one business (one series per document type —
 * BillingDocumentNumberSequence is keyed by (businessId, documentType)) this
 * reports: first and last number, how many were issued, the missing numbers as
 * ranges, duplicated numbers, and whether the counter agrees with what was issued
 * (next number = last issued + 1).
 *
 * It changes nothing: no write, no renumbering, no repair. QUOTE is excluded — a
 * quote is not a fiscal document and its number is taken when its PDF is first made.
 */
import { BillingDocumentStatus, BillingDocumentType } from "@prisma/client";
import { billingTenantTx } from "@/lib/services/billing/billing-tenant-tx";

export const CONTINUITY_DOCUMENT_TYPES = [
  BillingDocumentType.TAX_INVOICE,
  BillingDocumentType.TAX_INVOICE_RECEIPT,
  BillingDocumentType.RECEIPT,
  BillingDocumentType.CREDIT_NOTE,
] as const;

export type NumberRange = { from: number; to: number };

export type SeriesContinuity = {
  documentType: BillingDocumentType;
  issuedCount: number;
  first: number | null;
  last: number | null;
  /** Numbers absent between `first` and `last` — and before `first` when it is not 1 — as ranges. */
  missing: NumberRange[];
  missingCount: number;
  /** Numbers that appear on more than one issued document (the unique index should make this empty). */
  duplicates: number[];
  /** The counter's next number, or null when the series was never used. */
  counterNext: number | null;
  /** counterNext === last + 1 (or both absent). False means numbers were consumed without an issued document, or the reverse. */
  counterConsistent: boolean;
  /** True when nothing is missing, nothing is duplicated and the counter agrees. */
  continuous: boolean;
};

/**
 * Pure. `numbers` = the documentNumber of every issued document of one series, in any order.
 * Missing numbers are counted from 1: a series must start at 1 today (there is no opening
 * number), so a first number above 1 is itself a gap.
 */
export function analyzeSeriesContinuity(
  documentType: BillingDocumentType,
  numbers: readonly number[],
  counterNext: number | null
): SeriesContinuity {
  const counts = new Map<number, number>();
  for (const n of numbers) counts.set(n, (counts.get(n) ?? 0) + 1);
  const distinct = [...counts.keys()].sort((a, b) => a - b);
  const duplicates = distinct.filter((n) => (counts.get(n) ?? 0) > 1);

  const missing: NumberRange[] = [];
  let expected = 1;
  for (const n of distinct) {
    if (n > expected) missing.push({ from: expected, to: n - 1 });
    expected = n + 1;
  }
  const missingCount = missing.reduce((s, r) => s + (r.to - r.from + 1), 0);

  const last = distinct.length ? distinct[distinct.length - 1] : null;
  const counterConsistent = last === null ? counterNext === null : counterNext === last + 1;

  return {
    documentType,
    issuedCount: numbers.length,
    first: distinct.length ? distinct[0] : null,
    last,
    missing,
    missingCount,
    duplicates,
    counterNext,
    counterConsistent,
    continuous: missing.length === 0 && duplicates.length === 0 && counterConsistent,
  };
}

/** The report for one business, read inside its tenant transaction. */
export async function loadNumberingContinuityReport(businessId: number): Promise<SeriesContinuity[]> {
  const { issued, counters } = await billingTenantTx(businessId, async (tx) => ({
    issued: await tx.billingDocument.findMany({
      where: {
        businessId,
        status: BillingDocumentStatus.ISSUED,
        documentType: { in: [...CONTINUITY_DOCUMENT_TYPES] },
        documentNumber: { not: null },
      },
      select: { documentType: true, documentNumber: true },
    }),
    counters: await tx.billingDocumentNumberSequence.findMany({
      where: { businessId, documentType: { in: [...CONTINUITY_DOCUMENT_TYPES] } },
      select: { documentType: true, nextNumber: true },
    }),
  }));

  return CONTINUITY_DOCUMENT_TYPES.map((type) =>
    analyzeSeriesContinuity(
      type,
      issued.filter((d) => d.documentType === type).map((d) => d.documentNumber as number),
      counters.find((c) => c.documentType === type)?.nextNumber ?? null
    )
  );
}
