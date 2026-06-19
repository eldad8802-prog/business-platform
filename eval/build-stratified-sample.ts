/**
 * Phase 0 (expanded) — stratified manual-sample builder. READ-ONLY.
 *
 * Picks which NON-approved documents a human should label, deliberately
 * over-sampling HARD cases so the manual Test Set is not just easy docs:
 *   - weak / short OCR
 *   - multiple amount candidates
 *   - multiple date candidates
 *   - credit-note / tax-invoice-receipt wording
 *   - non-financial
 *   - unfamiliar vendors (not in VendorLearning)
 *   - each channel: upload / email / whatsapp
 *
 * It only READS (findMany) and emits a template with EMPTY truth fields plus
 * `strata` metadata explaining why each doc was chosen. Labels are still filled
 * by a human. Reversible: delete the output file.
 *
 * Run:  npx tsx eval/build-stratified-sample.ts [poolSize=400] [sampleSize=60] [perBucket=8]
 * Then: rename eval/data/ground-truth.manual.stratified.template.json
 *       → eval/data/ground-truth.manual.json and fill `truth` fields.
 */

import fs from "fs";
import path from "path";
import { prisma } from "@/lib/prisma";
import { getVendorCandidates } from "@/lib/services/documents/field-candidates.service";
import { cleanOCRText } from "@/lib/services/documents/text-cleaner.service";
import type { GroundTruthFile, GroundTruthItem } from "./lib/types";
import { normalizeVendorKey } from "./lib/normalize";
import {
  amountCandidateCount,
  coarseDocType,
  dateCandidateCount,
  keywordFlags,
  ocrQuality,
  sourceLabel,
} from "./lib/segments";

const DATA_DIR = path.join(process.cwd(), "eval", "data");

type Pooled = {
  item: GroundTruthItem;
  buckets: string[];
};

function classifyBuckets(
  strata: NonNullable<GroundTruthItem["strata"]>,
  unfamiliarVendor: boolean
): string[] {
  const buckets: string[] = [];
  if (strata.ocrQuality === "short" || strata.ocrQuality === "empty") {
    buckets.push("weak_ocr");
  }
  if (strata.amountCandidateCount >= 2) buckets.push("multiple_amounts");
  if (strata.dateCandidateCount >= 2) buckets.push("multiple_dates");
  if (strata.coarseDocType === "non_financial") buckets.push("non_financial");
  if (strata.keywordFlags.includes("credit_note_wording")) {
    buckets.push("credit_note");
  }
  if (strata.keywordFlags.includes("tax_invoice_receipt_wording")) {
    buckets.push("tax_invoice_receipt");
  }
  if (unfamiliarVendor) buckets.push("unfamiliar_vendor");
  buckets.push(`channel_${sourceLabel(strata.channel)}`);
  return buckets;
}

async function main(): Promise<void> {
  const poolSize = Number(process.argv[2] ?? "400");
  const sampleSize = Number(process.argv[3] ?? "60");
  const perBucket = Number(process.argv[4] ?? "8");

  // Known vendors (read-only) to flag "unfamiliar vendor" hard cases.
  const learned = await prisma.vendorLearning.findMany({
    select: { vendorName: true },
  });
  const knownVendorKeys = new Set(
    learned.map((v) => normalizeVendorKey(v.vendorName))
  );

  const docs = await prisma.document.findMany({
    where: { status: { not: "approved" } },
    orderBy: { id: "desc" },
    take: Number.isFinite(poolSize) ? poolSize : 400,
    select: { id: true, businessId: true, source: true, ocrText: true },
  });

  const pooled: Pooled[] = [];

  for (const doc of docs) {
    if (!doc.ocrText || !doc.ocrText.trim()) continue;

    const strata: NonNullable<GroundTruthItem["strata"]> = {
      channel: doc.source ?? null,
      coarseDocType: coarseDocType(doc.ocrText),
      ocrQuality: ocrQuality(doc.ocrText),
      amountCandidateCount: amountCandidateCount(doc.ocrText),
      dateCandidateCount: dateCandidateCount(doc.ocrText),
      keywordFlags: keywordFlags(doc.ocrText),
    };

    const guessedVendor =
      getVendorCandidates(cleanOCRText(doc.ocrText))[0]?.value ?? "";
    const unfamiliarVendor =
      guessedVendor.trim().length > 0 &&
      !knownVendorKeys.has(normalizeVendorKey(guessedVendor));

    const item: GroundTruthItem = {
      docId: doc.id,
      businessId: doc.businessId,
      source: "manual",
      channel: doc.source ?? null,
      ocrText: doc.ocrText,
      truth: {
        vendor: null,
        amount: null,
        date: null,
        docType: null,
        direction: null,
        isFinancial: null,
      },
      strata,
    };

    pooled.push({ item, buckets: classifyBuckets(strata, unfamiliarVendor) });
  }

  // Fill quotas per hard bucket, then dedupe and cap.
  const selected = new Map<number, GroundTruthItem>();
  const bucketCounts = new Map<string, number>();

  const allBuckets = Array.from(
    new Set(pooled.flatMap((p) => p.buckets))
  ).sort();

  for (const bucket of allBuckets) {
    for (const p of pooled) {
      if (selected.size >= sampleSize) break;
      if (!p.buckets.includes(bucket)) continue;
      if ((bucketCounts.get(bucket) ?? 0) >= perBucket) break;
      if (selected.has(p.item.docId)) continue;
      selected.set(p.item.docId, p.item);
      for (const b of p.buckets) {
        bucketCounts.set(b, (bucketCounts.get(b) ?? 0) + 1);
      }
    }
  }

  const items = [...selected.values()];

  const payload: GroundTruthFile = {
    generatedAt: new Date().toISOString(),
    source: "manual_template",
    count: items.length,
    items,
  };

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const outPath = path.join(
    DATA_DIR,
    "ground-truth.manual.stratified.template.json"
  );
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");

  console.log(`pool: ${pooled.length} candidate docs`);
  console.log(
    "bucket coverage:",
    Object.fromEntries([...bucketCounts.entries()].sort())
  );
  console.log(`selected ${items.length} → ${outPath}`);
  console.log(
    "\nNEXT (human): rename to eval/data/ground-truth.manual.json and fill `truth` " +
      "fields. `strata` is sampling metadata only — never used as truth."
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
