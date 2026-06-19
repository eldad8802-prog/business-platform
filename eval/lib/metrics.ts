/**
 * Phase 0 — frozen metric definitions.
 *
 * Per the agreed contract, every measurement is reported with these exact
 * definitions so that future "Before/After" comparisons remain valid.
 */

export type FieldName = "vendor" | "amount" | "date" | "docType" | "direction";

export type RowSegments = {
  source: string; // upload | email | whatsapp | unknown
  docType: string; // coarse engine type or unknown
  ocrQuality: string; // empty | short | medium | long
  amountComplexity: string; // none | single | multiple
  dateComplexity: string; // none | single | multiple
  vendorKey: string; // normalized vendor label (truth-or-predicted) for concentration
};

export type EvalRow = {
  docId: number;
  businessId: number;
  source: "financial_record" | "manual";
  /** Ground-truth value presence per field (null = no label available). */
  truthPresent: Record<FieldName, boolean>;
  /** Did the prediction match ground truth (only meaningful when truthPresent). */
  match: Record<FieldName, boolean>;
  /** Did the engine emit a non-null value for this field (coverage). */
  predictedPresent: Record<FieldName, boolean>;
  /** Engine doc-level confidence gate. */
  needsReview: boolean;
  /** isFinancial classification (predicted vs truth), when truth available. */
  isFinancialTruth: boolean | null;
  isFinancialPredicted: boolean;
  /** Segmentation keys for sliced reporting. */
  segments: RowSegments;
};

export type FieldMetrics = {
  field: FieldName;
  /** Docs that have a ground-truth label for this field. */
  labeled: number;
  /** match / labeled — raw extraction accuracy regardless of needsReview. */
  accuracy: number;
  /** predictedPresent / total — how often any value was produced. */
  coverage: number;
  /**
   * Confident-but-wrong: predicted value present, needsReview=false, and wrong.
   * Counted over labeled docs.
   */
  falsePositives: number;
  /**
   * Missed: a correct answer existed (truthPresent) but the engine either
   * abstained (no value) or flagged needsReview instead of confidently
   * returning the correct value. Counted over labeled docs.
   */
  falseNegatives: number;
};

function rate(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Number((numerator / denominator).toFixed(4));
}

export function computeFieldMetrics(rows: EvalRow[], field: FieldName): FieldMetrics {
  const total = rows.length;
  let labeled = 0;
  let correct = 0;
  let covered = 0;
  let fp = 0;
  let fn = 0;

  for (const row of rows) {
    if (row.predictedPresent[field]) covered += 1;

    if (!row.truthPresent[field]) continue;
    labeled += 1;

    const matched = row.match[field];
    if (matched) correct += 1;

    const confident = row.predictedPresent[field] && row.needsReview === false;

    if (confident && !matched) fp += 1;
    // Missed: correct confident answer NOT achieved although truth existed.
    if (!(confident && matched)) fn += 1;
  }

  return {
    field,
    labeled,
    accuracy: rate(correct, labeled),
    coverage: rate(covered, total),
    falsePositives: fp,
    falseNegatives: fn,
  };
}

export type IsFinancialMetrics = {
  labeled: number;
  accuracy: number;
  falsePositives: number; // predicted financial, truth non-financial
  falseNegatives: number; // predicted non-financial, truth financial
};

export function computeIsFinancialMetrics(rows: EvalRow[]): IsFinancialMetrics {
  let labeled = 0;
  let correct = 0;
  let fp = 0;
  let fn = 0;

  for (const row of rows) {
    if (row.isFinancialTruth === null) continue;
    labeled += 1;
    if (row.isFinancialPredicted === row.isFinancialTruth) correct += 1;
    if (row.isFinancialPredicted && !row.isFinancialTruth) fp += 1;
    if (!row.isFinancialPredicted && row.isFinancialTruth) fn += 1;
  }

  return {
    labeled,
    accuracy: rate(correct, labeled),
    falsePositives: fp,
    falseNegatives: fn,
  };
}

export function computeReviewRate(rows: EvalRow[]): number {
  const flagged = rows.filter((row) => row.needsReview).length;
  return rate(flagged, rows.length);
}

// --- Segmentation -----------------------------------------------------------

export type SegmentReport = {
  segment: string;
  count: number;
  reviewRate: number;
  fields: FieldMetrics[];
};

export function groupRows(
  rows: EvalRow[],
  keyFn: (row: EvalRow) => string
): Map<string, EvalRow[]> {
  const groups = new Map<string, EvalRow[]>();
  for (const row of rows) {
    const key = keyFn(row);
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  return groups;
}

export function computeSegmented(
  rows: EvalRow[],
  keyFn: (row: EvalRow) => string,
  fields: FieldName[]
): SegmentReport[] {
  const groups = groupRows(rows, keyFn);
  const reports: SegmentReport[] = [];
  for (const [segment, segRows] of groups) {
    reports.push({
      segment,
      count: segRows.length,
      reviewRate: computeReviewRate(segRows),
      fields: fields.map((field) => computeFieldMetrics(segRows, field)),
    });
  }
  return reports.sort((a, b) => b.count - a.count);
}

// --- Vendor concentration ---------------------------------------------------

export type VendorConcentration = {
  total: number;
  uniqueVendors: number;
  top5Share: number;
  top10Share: number;
  topVendors: { vendor: string; count: number }[];
  /** Vendor-field accuracy on docs whose vendor recurs in the sample. */
  repeatedVendorAccuracy: number;
  repeatedVendorLabeled: number;
  /** Vendor-field accuracy on docs whose vendor appears once. */
  singletonVendorAccuracy: number;
  singletonVendorLabeled: number;
};

export function computeVendorConcentration(rows: EvalRow[]): VendorConcentration {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.segments.vendorKey || "(none)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const sorted = [...counts.entries()]
    .filter(([key]) => key !== "(none)")
    .sort((a, b) => b[1] - a[1]);

  const total = rows.length;
  const sumTop = (n: number) =>
    sorted.slice(0, n).reduce((acc, [, count]) => acc + count, 0);

  // Vendor-field accuracy split by recurrence.
  let repCorrect = 0;
  let repLabeled = 0;
  let singCorrect = 0;
  let singLabeled = 0;
  for (const row of rows) {
    if (!row.truthPresent.vendor) continue;
    const key = row.segments.vendorKey || "(none)";
    const recurs = (counts.get(key) ?? 0) > 1 && key !== "(none)";
    if (recurs) {
      repLabeled += 1;
      if (row.match.vendor) repCorrect += 1;
    } else {
      singLabeled += 1;
      if (row.match.vendor) singCorrect += 1;
    }
  }

  return {
    total,
    uniqueVendors: sorted.length,
    top5Share: rate(sumTop(5), total),
    top10Share: rate(sumTop(10), total),
    topVendors: sorted.slice(0, 10).map(([vendor, count]) => ({ vendor, count })),
    repeatedVendorAccuracy: rate(repCorrect, repLabeled),
    repeatedVendorLabeled: repLabeled,
    singletonVendorAccuracy: rate(singCorrect, singLabeled),
    singletonVendorLabeled: singLabeled,
  };
}
