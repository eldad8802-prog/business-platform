/**
 * Israeli VAT rate — the DEFAULT for a new billing line, and a non-blocking
 * check of a line's rate against the rate in force on the document date.
 *
 * Pure: no Prisma, no I/O, no implicit clock (the caller passes the date).
 *
 * SCOPE — deliberately narrow:
 *  - It only chooses what a NEW, empty line is pre-filled with, and whether the
 *    editor should show a warning. It never changes a stored value, never blocks
 *    a save or an issue, and is not used by the server: the server still accepts
 *    any rate 0–100 (billing-line.validation.ts) and computes VAT from the rate
 *    stored on each line.
 *  - Issued documents keep the rate frozen in their snapshot; drafts keep the
 *    rate already stored on their lines until the owner edits them.
 *
 * THE TABLE — standard rate by civil date in Israel (Asia/Jerusalem):
 *    2015-10-01 … 2024-12-31  17%
 *    2025-01-01 …             18%
 * A date before the table's first entry is outside its coverage: the check
 * says nothing about it, and the default falls back to the first entry (the
 * product never creates documents dated that far back).
 *
 * BUSINESS KIND — BusinessProfile.billingBusinessKind:
 *    EXEMPT_DEALER (עוסק פטור)            → does not charge VAT → default 0
 *    AUTHORIZED_DEALER / LTD_COMPANY      → standard rate on the document date
 *    null / unknown (profile not filled)  → standard rate (the common case)
 *
 * Zero-rated supplies by a licensed dealer (e.g. export of services) are legal
 * at 0%; that is why a mismatch is only ever a WARNING the owner may ignore.
 */

export const ISRAEL_TIME_ZONE = "Asia/Jerusalem";

export type VatRatePeriod = {
  /** First civil day (Israel) on which the rate applies, YYYY-MM-DD. */
  fromIsraelDate: string;
  /** Rate as a percent string, as the editor shows it ("18", not "18.00"). */
  ratePercent: string;
};

/** Ascending by `fromIsraelDate`. Each period lasts until the next one starts. */
export const ISRAEL_STANDARD_VAT_RATES: readonly VatRatePeriod[] = Object.freeze([
  Object.freeze({ fromIsraelDate: "2015-10-01", ratePercent: "17" }),
  Object.freeze({ fromIsraelDate: "2025-01-01", ratePercent: "18" }),
]);

export const EXEMPT_DEALER_VAT_RATE_PERCENT = "0";

const israelDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: ISRAEL_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The civil date in Israel (YYYY-MM-DD) at the given instant. */
export function israelCivilDate(instant: Date): string {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw new RangeError("israelCivilDate: invalid date");
  }
  const parts = israelDateFormatter.formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * The standard rate in force on the Israeli civil date of `instant`, or null
 * when the date is before the table's coverage.
 */
export function standardVatRatePercentOn(instant: Date): string | null {
  const day = israelCivilDate(instant);
  let found: string | null = null;
  for (const period of ISRAEL_STANDARD_VAT_RATES) {
    // YYYY-MM-DD strings compare correctly as strings.
    if (period.fromIsraelDate <= day) found = period.ratePercent;
    else break;
  }
  return found;
}

export function isExemptDealer(businessKind: string | null | undefined): boolean {
  return typeof businessKind === "string" && businessKind.trim() === "EXEMPT_DEALER";
}

/** What a NEW line is pre-filled with. Never applied to an existing line. */
export function defaultVatRatePercentFor(input: {
  businessKind: string | null | undefined;
  documentDate: Date;
}): string {
  if (isExemptDealer(input.businessKind)) return EXEMPT_DEALER_VAT_RATE_PERCENT;
  return (
    standardVatRatePercentOn(input.documentDate) ??
    ISRAEL_STANDARD_VAT_RATES[0].ratePercent
  );
}

export type VatRateWarning =
  | {
      kind: "EXEMPT_DEALER_CHARGES_VAT";
      /** The line's rate as entered. */
      ratePercent: string;
    }
  | {
      kind: "DIFFERS_FROM_STANDARD";
      ratePercent: string;
      /** The standard rate in force on the document date. */
      expectedPercent: string;
    };

function parseRate(raw: string): number | null {
  const t = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * A warning for one line's rate, or null when it looks right (or cannot be
 * judged: unparsable input, a date outside the table).
 *
 * Unknown business kind: a 0% line is not flagged (the business may be exempt
 * and simply has not filled its profile); any other rate that differs from the
 * standard one is.
 */
export function vatRateWarningFor(input: {
  businessKind: string | null | undefined;
  documentDate: Date;
  ratePercent: string;
}): VatRateWarning | null {
  const rate = parseRate(input.ratePercent);
  if (rate === null) return null;
  const ratePercent = input.ratePercent.trim();

  if (isExemptDealer(input.businessKind)) {
    return rate === 0 ? null : { kind: "EXEMPT_DEALER_CHARGES_VAT", ratePercent };
  }

  const expected = standardVatRatePercentOn(input.documentDate);
  if (expected === null) return null;
  if (rate === Number(expected)) return null;

  const kindKnown =
    typeof input.businessKind === "string" && input.businessKind.trim() !== "";
  if (!kindKnown && rate === 0) return null;

  return { kind: "DIFFERS_FROM_STANDARD", ratePercent, expectedPercent: expected };
}

/**
 * Document types whose lines are checked. A CREDIT_NOTE is excluded on purpose:
 * it must carry the rate of the invoice it reverses, which may be an older rate.
 */
export function documentTypeGetsVatRateCheck(documentType: string): boolean {
  return documentType !== "CREDIT_NOTE";
}

export type DocumentVatRateSummary =
  | { kind: "EXEMPT_DEALER_CHARGES_VAT"; lineNumbers: number[] }
  | { kind: "DIFFERS_FROM_STANDARD"; expectedPercent: string; lineNumbers: number[] };

/**
 * One summary for a whole document (for the issue dialog): which lines (1-based,
 * in the order given) carry a rate worth checking. Null when nothing to say.
 * For a given business kind and date every warning is of the same kind, so one
 * summary covers them all.
 */
export function summarizeDocumentVatRates(input: {
  businessKind: string | null | undefined;
  documentDate: Date;
  documentType: string;
  ratePercents: readonly string[];
}): DocumentVatRateSummary | null {
  if (!documentTypeGetsVatRateCheck(input.documentType)) return null;
  const lineNumbers: number[] = [];
  let first: VatRateWarning | null = null;
  input.ratePercents.forEach((ratePercent, i) => {
    const w = vatRateWarningFor({
      businessKind: input.businessKind,
      documentDate: input.documentDate,
      ratePercent,
    });
    if (!w) return;
    first ??= w;
    lineNumbers.push(i + 1);
  });
  const w = first as VatRateWarning | null;
  if (!w) return null;
  return w.kind === "EXEMPT_DEALER_CHARGES_VAT"
    ? { kind: w.kind, lineNumbers }
    : { kind: w.kind, expectedPercent: w.expectedPercent, lineNumbers };
}
