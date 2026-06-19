/**
 * Phase 0 — Baseline runner. READ-ONLY.
 *
 * Loads the Test Set (ground-truth.auto.json + optional ground-truth.manual.json),
 * RE-RUNS the current production engine (runUnifiedDocumentIntelligence) on each
 * stored ocrText, and scores the output against ground truth using the frozen
 * metric definitions. Writes:
 *   - eval/data/baseline-report.json   (full per-doc detail + aggregates)
 *   - eval/BASELINE-REPORT.md          (human-readable reference point)
 *
 * It calls the engine exactly as production does, but persists NOTHING and changes
 * NO decision. The engine's only DB access is a vendorLearning read (safe).
 *
 * Run:  npx tsx eval/run-baseline.ts
 */

import fs from "fs";
import path from "path";
import { prisma } from "@/lib/prisma";
import { runUnifiedDocumentIntelligence } from "@/lib/services/documents/unified-extraction-engine.service";
import type { GroundTruthFile, GroundTruthItem } from "./lib/types";
import {
  amountMatches,
  dateKey,
  dateMatches,
  normalizeVendorKey,
  stringMatches,
  vendorMatchesLenient,
  vendorMatchesStrict,
} from "./lib/normalize";
import {
  computeFieldMetrics,
  computeIsFinancialMetrics,
  computeReviewRate,
  computeSegmented,
  computeVendorConcentration,
  type EvalRow,
  type FieldName,
  type RowSegments,
  type SegmentReport,
} from "./lib/metrics";
import {
  amountCandidateCount,
  coarseDocType,
  complexityFromCount,
  dateCandidateCount,
  INDISTINGUISHABLE_TYPES,
  ocrQuality,
  sourceLabel,
} from "./lib/segments";

const DATA_DIR = path.join(process.cwd(), "eval", "data");
const FIELDS: FieldName[] = ["vendor", "amount", "date", "docType", "direction"];

function loadSet(fileName: string): GroundTruthItem[] {
  const filePath = path.join(DATA_DIR, fileName);
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as GroundTruthFile;
  return parsed.items ?? [];
}

function vendorIsPresent(name: string | null): boolean {
  const v = String(name ?? "").trim();
  return v.length > 0 && v !== "לא ידוע";
}

/** Silence the engine's verbose console output during one async call. */
async function withSilencedConsole<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
}

type DetailRow = {
  docId: number;
  source: GroundTruthItem["source"];
  truth: GroundTruthItem["truth"];
  predicted: {
    vendor: string | null;
    amount: number | null;
    date: string | null;
    docType: string;
    direction: string;
    isFinancial: boolean;
    needsReview: boolean;
    confidence: number;
  };
  match: Record<FieldName, boolean>;
  vendorLenientMatch: boolean;
  segments: RowSegments;
};

async function evaluateItem(
  item: GroundTruthItem
): Promise<{ row: EvalRow; detail: DetailRow }> {
  const result = await withSilencedConsole(() =>
    runUnifiedDocumentIntelligence({
      businessId: item.businessId,
      rawText: item.ocrText,
    })
  );

  const predictedDateKey = dateKey(result.date);

  const match: Record<FieldName, boolean> = {
    vendor: vendorMatchesStrict(item.truth.vendor, result.vendorName),
    amount: amountMatches(item.truth.amount, result.amount),
    date: dateMatches(item.truth.date, result.date),
    docType: stringMatches(item.truth.docType, result.documentType),
    direction: stringMatches(item.truth.direction, result.direction),
  };

  const truthPresent: Record<FieldName, boolean> = {
    vendor: item.truth.vendor !== null,
    amount: item.truth.amount !== null,
    date: item.truth.date !== null,
    docType: item.truth.docType !== null,
    direction: item.truth.direction !== null,
  };

  const predictedPresent: Record<FieldName, boolean> = {
    vendor: vendorIsPresent(result.vendorName),
    amount: result.amount !== null,
    date: result.date !== null,
    docType: Boolean(result.documentType),
    direction: result.direction === "income" || result.direction === "expense",
  };

  // Vendor key for concentration: prefer ground-truth vendor, else predicted.
  const vendorKey = normalizeVendorKey(item.truth.vendor ?? result.vendorName);

  const segments: RowSegments = {
    source: sourceLabel(item.channel),
    docType: coarseDocType(item.ocrText),
    ocrQuality: ocrQuality(item.ocrText),
    amountComplexity: complexityFromCount(amountCandidateCount(item.ocrText)),
    dateComplexity: complexityFromCount(dateCandidateCount(item.ocrText)),
    vendorKey,
  };

  const row: EvalRow = {
    docId: item.docId,
    businessId: item.businessId,
    source: item.source,
    truthPresent,
    match,
    predictedPresent,
    needsReview: result.needsReview,
    isFinancialTruth: item.truth.isFinancial,
    isFinancialPredicted: result.isFinancial,
    segments,
  };

  const detail: DetailRow = {
    docId: item.docId,
    source: item.source,
    truth: item.truth,
    predicted: {
      vendor: result.vendorName ?? null,
      amount: result.amount,
      date: predictedDateKey,
      docType: result.documentType,
      direction: result.direction,
      isFinancial: result.isFinancial,
      needsReview: result.needsReview,
      confidence: result.confidence,
    },
    match,
    vendorLenientMatch: vendorMatchesLenient(item.truth.vendor, result.vendorName),
    segments,
  };

  return { row, detail };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function fieldAcc(report: SegmentReport, field: FieldName): string {
  const m = report.fields.find((f) => f.field === field);
  if (!m || m.labeled === 0) return "—";
  return pct(m.accuracy);
}

/**
 * Render a segmentation dimension as a table. Columns show the headline fields
 * (vendor/amount/date) so failures are not hidden inside a global average.
 */
function renderSegment(title: string, reports: SegmentReport[]): string[] {
  const lines: string[] = [];
  lines.push(`### By ${title}`);
  lines.push("");
  lines.push(
    "| Segment | N | Review Rate | Vendor Acc | Amount Acc | Date Acc |"
  );
  lines.push("|---|---|---|---|---|---|");
  for (const r of reports) {
    lines.push(
      `| ${r.segment} | ${r.count} | ${pct(r.reviewRate)} | ${fieldAcc(r, "vendor")} | ${fieldAcc(r, "amount")} | ${fieldAcc(r, "date")} |`
    );
  }
  lines.push("");
  lines.push(
    "_Per-segment full metrics (coverage, FP, FN, docType, direction) are in the JSON report._"
  );
  lines.push("");
  return lines;
}

function buildMarkdown(
  rows: EvalRow[],
  details: DetailRow[]
): string {
  const fieldMetrics = FIELDS.map((field) => computeFieldMetrics(rows, field));
  const isFinancial = computeIsFinancialMetrics(rows);
  const reviewRate = computeReviewRate(rows);
  const vendorLenientLabeled = rows.filter((r) => r.truthPresent.vendor).length;
  const vendorLenientCorrect = details.filter(
    (d) => d.truth.vendor !== null && d.vendorLenientMatch
  ).length;
  const vendorLenientAcc =
    vendorLenientLabeled === 0
      ? 0
      : vendorLenientCorrect / vendorLenientLabeled;

  const lines: string[] = [];
  lines.push("# Phase 0 — Baseline Report (FROZEN reference point)");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`Total documents evaluated: **${rows.length}**`);
  lines.push(
    `- from FinancialRecord (auto): ${rows.filter((r) => r.source === "financial_record").length}`
  );
  lines.push(
    `- from manual labels: ${rows.filter((r) => r.source === "manual").length}`
  );
  lines.push("");
  lines.push(`Engine: \`runUnifiedDocumentIntelligence\` (current production).`);
  lines.push(`Doc-level **Review Rate**: ${pct(reviewRate)}`);
  lines.push("");
  lines.push("## Per-field metrics");
  lines.push("");
  lines.push(
    "| Field | Labeled | Accuracy | Coverage | False Positives | False Negatives |"
  );
  lines.push("|---|---|---|---|---|---|");
  for (const m of fieldMetrics) {
    lines.push(
      `| ${m.field} | ${m.labeled} | ${pct(m.accuracy)} | ${pct(m.coverage)} | ${m.falsePositives} | ${m.falseNegatives} |`
    );
  }
  lines.push("");
  lines.push(
    `Vendor accuracy (lenient containment, secondary): ${pct(vendorLenientAcc)} over ${vendorLenientLabeled} labeled.`
  );
  lines.push("");
  lines.push("## isFinancial classification");
  lines.push("");
  lines.push(
    `Labeled: ${isFinancial.labeled} · Accuracy: ${pct(isFinancial.accuracy)} · ` +
      `FP (said financial, isn't): ${isFinancial.falsePositives} · ` +
      `FN (missed financial): ${isFinancial.falseNegatives}`
  );
  lines.push("");

  // --- Segmented views (the whole point of the expansion) ---
  lines.push("## Segmented metrics");
  lines.push("");
  lines.push(
    "Averages hide where the engine actually fails. These slices expose it."
  );
  lines.push("");
  lines.push(
    ...renderSegment("source channel", computeSegmented(rows, (r) => r.segments.source, FIELDS))
  );
  lines.push(
    ...renderSegment("coarse document type", computeSegmented(rows, (r) => r.segments.docType, FIELDS))
  );
  lines.push("");
  lines.push(
    "> Types the engine **cannot** distinguish at Phase 0 (NOT invented as buckets): " +
      INDISTINGUISHABLE_TYPES.join("; ") +
      "."
  );
  lines.push("");
  lines.push(
    ...renderSegment("OCR quality (by length)", computeSegmented(rows, (r) => r.segments.ocrQuality, FIELDS))
  );
  lines.push(
    ...renderSegment("amount complexity (# amount candidates)", computeSegmented(rows, (r) => r.segments.amountComplexity, FIELDS))
  );
  lines.push(
    ...renderSegment("date complexity (# date candidates)", computeSegmented(rows, (r) => r.segments.dateComplexity, FIELDS))
  );

  // --- Vendor concentration ---
  const conc = computeVendorConcentration(rows);
  lines.push("## Vendor concentration");
  lines.push("");
  lines.push(`Unique vendors: ${conc.uniqueVendors} over ${conc.total} docs.`);
  lines.push(`Top 5 vendor share: **${pct(conc.top5Share)}** · Top 10: **${pct(conc.top10Share)}**`);
  lines.push("");
  lines.push(
    `Vendor-field accuracy on **recurring** vendors: ${pct(conc.repeatedVendorAccuracy)} (${conc.repeatedVendorLabeled} labeled)`
  );
  lines.push(
    `Vendor-field accuracy on **one-off** vendors: ${pct(conc.singletonVendorAccuracy)} (${conc.singletonVendorLabeled} labeled)`
  );
  lines.push("");
  lines.push(
    "A large gap (recurring >> one-off) means apparent accuracy is propped up by repeated vendor templates, not generalization."
  );
  lines.push("");
  lines.push("## Limitations (read before trusting any number)");
  lines.push("");
  lines.push(
    "- **Original AI accuracy is NOT measurable until Phase 1/2.** Approve overwrites `ExtractedData`, so the AI's value at ingestion is gone; we only re-run today's engine vs human-approved truth."
  );
  lines.push(
    "- **Approved docs do not necessarily reflect original AI output** — some were corrected by a user before approval; the correction is unrecorded."
  );
  lines.push(
    "- **Missing from the auto set:** docs still in `needs_review`, rejected, or that failed OCR. The auto set is approved+financial only → skewed toward easy/legible cases."
  );
  lines.push(
    "- **Empty-OCR blind spot:** all three intake paths reject empty OCR before creating a Document, so empty-OCR docs are unmeasurable here by construction."
  );
  lines.push(
    "- **Finer Israeli doc types** (חשבונית מס / חשבונית מס קבלה / זיכוי) are not modeled by the classifier and are not bucketed — only the 6 coarse classes + unknown."
  );
  lines.push(
    "- **Date candidate count** is a local regex approximation (eval-only), not the engine's internal date parser."
  );
  lines.push("");

  lines.push("## Metric definitions (frozen)");
  lines.push("");
  lines.push("- **Accuracy** = matched / labeled (raw extraction, ignores needsReview).");
  lines.push("- **Coverage** = produced-a-value / total.");
  lines.push("- **Review Rate** = needsReview=true / total (doc-level).");
  lines.push(
    "- **False Positive** = value present AND needsReview=false AND wrong."
  );
  lines.push(
    "- **False Negative** = truth existed but engine did not confidently return the correct value."
  );
  lines.push("");
  lines.push(
    "Per-doc detail (including every mismatch) is in `eval/data/baseline-report.json`."
  );
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const auto = loadSet("ground-truth.auto.json");
  const manual = loadSet("ground-truth.manual.json"); // optional, after labeling
  const items = [...auto, ...manual];

  if (items.length === 0) {
    console.error(
      "No ground-truth items found. Run `npx tsx eval/build-ground-truth.ts` first " +
        "(and optionally fill ground-truth.manual.json)."
    );
    process.exitCode = 1;
    return;
  }

  const rows: EvalRow[] = [];
  const details: DetailRow[] = [];

  for (const item of items) {
    const { row, detail } = await evaluateItem(item);
    rows.push(row);
    details.push(detail);
  }

  const reportJson = {
    generatedAt: new Date().toISOString(),
    total: rows.length,
    reviewRate: computeReviewRate(rows),
    fields: FIELDS.map((field) => computeFieldMetrics(rows, field)),
    isFinancial: computeIsFinancialMetrics(rows),
    segmented: {
      bySource: computeSegmented(rows, (r) => r.segments.source, FIELDS),
      byDocType: computeSegmented(rows, (r) => r.segments.docType, FIELDS),
      byOcrQuality: computeSegmented(rows, (r) => r.segments.ocrQuality, FIELDS),
      byAmountComplexity: computeSegmented(rows, (r) => r.segments.amountComplexity, FIELDS),
      byDateComplexity: computeSegmented(rows, (r) => r.segments.dateComplexity, FIELDS),
    },
    indistinguishableTypes: INDISTINGUISHABLE_TYPES,
    vendorConcentration: computeVendorConcentration(rows),
    details,
  };

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DATA_DIR, "baseline-report.json"),
    JSON.stringify(reportJson, null, 2),
    "utf8"
  );

  const md = buildMarkdown(rows, details);
  fs.writeFileSync(path.join(process.cwd(), "eval", "BASELINE-REPORT.md"), md, "utf8");

  console.log(md);
  console.log("\nwrote eval/data/baseline-report.json and eval/BASELINE-REPORT.md");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
