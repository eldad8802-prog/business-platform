/**
 * Numbering continuity check — READ-ONLY.
 *
 * The computerized-system rules require a check of the running numbers of internal
 * documents (הוראות ניהול פנקסים, נספח ה' (א)(5)); the ITA booklet "הוראות ניהול
 * ספרים בסביבה ממוחשבת" reads it as an explicit list of the numbers that exist and
 * the numbers that are missing — a sorted list alone is not enough.
 *
 * SERIES. Today a series is (business, document type): BillingDocumentNumberSequence
 * is keyed by (businessId, documentType). Every report row names its series key, so a
 * later series dimension (e.g. a declared opening) slots in without changing callers.
 *
 * WHAT IT CAN AND CANNOT CLAIM.
 *   - The opening number of a series is not recorded anywhere today. Without it the
 *     check can only cover the range from the FIRST issued number to the last one:
 *     a series whose first issued number is 459 is NOT reported as missing 1–458,
 *     and it is NOT declared fully continuous either — the report says the check is
 *     partial (`coverage: "FROM_FIRST_ISSUED"`, `fullyVerified: false`).
 *   - When an opening number is supplied, the range from the opening is checked and a
 *     clean result is `fullyVerified: true`. Numbers below the opening are reported.
 *   - A preserved cancelled number is a number that EXISTS: it is never "missing".
 *     Dubiz has no cancelled status today (BillingDocumentStatus = DRAFT,
 *     PENDING_REVIEW, ISSUED), so the loader passes none; the analysis supports it.
 *
 * It changes nothing: no write, no renumbering, no counter repair, no filling of
 * holes. QUOTE is excluded — not a fiscal document; its number is taken when its
 * PDF is first made. There is no route or screen: today this is an internal
 * service, reachable from server code and the lab only.
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

export type ContinuityCoverage =
  /** Nothing issued, no counter. */
  | "EMPTY"
  /** Checked from the declared opening number to the last issued number. */
  | "FROM_OPENING"
  /** Opening unknown: checked only from the first issued number to the last one. */
  | "FROM_FIRST_ISSUED";

export type SeriesContinuity = {
  /** `${businessId}:${documentType}` — the series identity used today. */
  seriesKey: string;
  documentType: BillingDocumentType;
  coverage: ContinuityCoverage;
  /** The opening number the check started from, when one was supplied. */
  openingNumber: number | null;
  issuedCount: number;
  cancelledCount: number;
  first: number | null;
  last: number | null;
  /** Absent numbers inside the checked range, as ranges. Cancelled numbers are present, not missing. */
  missing: NumberRange[];
  missingCount: number;
  /** Numbers used more than once (issued twice, or issued and cancelled). */
  duplicates: number[];
  /** Issued or cancelled numbers below a supplied opening number. */
  belowOpening: number[];
  /** The counter's next number, or null when the series was never used. */
  counterNext: number | null;
  /** counterNext === highest used + 1 (or both absent / counter = opening before first use). */
  counterConsistent: boolean;
  /** No missing, duplicate or below-opening number, and the counter agrees — within the checked range. */
  consistentInRange: boolean;
  /** consistentInRange AND the range starts at a known opening. Never true when the opening is unknown. */
  fullyVerified: boolean;
};

export type SeriesContinuityInput = {
  businessId: number;
  documentType: BillingDocumentType;
  /** documentNumber of every issued document of the series, any order. */
  issuedNumbers: readonly number[];
  /** Numbers of preserved cancelled documents (none exist in Dubiz today). */
  cancelledNumbers?: readonly number[];
  counterNext: number | null;
  /** The series' declared opening number; null/undefined = unknown (the case today). */
  openingNumber?: number | null;
};

/** Pure. */
export function analyzeSeriesContinuity(input: SeriesContinuityInput): SeriesContinuity {
  const cancelled = input.cancelledNumbers ?? [];
  const opening = input.openingNumber ?? null;
  const counts = new Map<number, number>();
  for (const n of [...input.issuedNumbers, ...cancelled]) counts.set(n, (counts.get(n) ?? 0) + 1);
  const used = [...counts.keys()].sort((a, b) => a - b);
  const duplicates = used.filter((n) => (counts.get(n) ?? 0) > 1);
  const belowOpening = opening === null ? [] : used.filter((n) => n < opening);
  const inRange = opening === null ? used : used.filter((n) => n >= opening);

  const first = used.length ? used[0] : null;
  const last = used.length ? used[used.length - 1] : null;

  const missing: NumberRange[] = [];
  let expected = opening ?? first;
  if (expected !== null) {
    for (const n of inRange) {
      if (n > expected) missing.push({ from: expected, to: n - 1 });
      expected = n + 1;
    }
  }
  const missingCount = missing.reduce((s, r) => s + (r.to - r.from + 1), 0);

  const counterConsistent =
    last === null
      ? input.counterNext === null || (opening !== null && input.counterNext === opening)
      : input.counterNext === last + 1;

  const coverage: ContinuityCoverage =
    last === null && input.counterNext === null ? "EMPTY" : opening !== null ? "FROM_OPENING" : "FROM_FIRST_ISSUED";
  const consistentInRange = missing.length === 0 && duplicates.length === 0 && belowOpening.length === 0 && counterConsistent;

  return {
    seriesKey: `${input.businessId}:${input.documentType}`,
    documentType: input.documentType,
    coverage,
    openingNumber: opening,
    issuedCount: input.issuedNumbers.length,
    cancelledCount: cancelled.length,
    first,
    last,
    missing,
    missingCount,
    duplicates,
    belowOpening,
    counterNext: input.counterNext,
    counterConsistent,
    consistentInRange,
    fullyVerified: consistentInRange && coverage === "FROM_OPENING",
  };
}

/**
 * The report for one business, read inside its tenant transaction. No opening
 * number is recorded anywhere today, so every used series is reported as
 * FROM_FIRST_ISSUED (partial) — never as fully verified.
 */
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

  return CONTINUITY_DOCUMENT_TYPES.map((documentType) =>
    analyzeSeriesContinuity({
      businessId,
      documentType,
      issuedNumbers: issued.filter((d) => d.documentType === documentType).map((d) => d.documentNumber as number),
      counterNext: counters.find((c) => c.documentType === documentType)?.nextNumber ?? null,
      openingNumber: null,
    })
  );
}
