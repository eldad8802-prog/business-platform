/**
 * Phase 0 — build the ground-truth Test Set. READ-ONLY against the database.
 *
 * Emits two files under eval/data/ (git-ignored):
 *   1) ground-truth.auto.json     — approved docs joined with FinancialRecord.
 *      FinancialRecord holds human-APPROVED values, so it is real ground truth
 *      for amount / vendor / date / direction (and isFinancial = true).
 *   2) ground-truth.manual.template.json — a representative sample of
 *      non-approved / non-financial docs with EMPTY truth fields, for a human
 *      to label (document type, isFinancial, and optionally amount/vendor/date).
 *
 * This script performs only findMany() reads. It never writes to the DB and
 * never touches production extraction logic. Reversible: delete eval/.
 *
 * Run:  npx tsx eval/build-ground-truth.ts [manualSampleSize]
 */

import fs from "fs";
import path from "path";
import { prisma } from "@/lib/prisma";
import type { GroundTruthFile, GroundTruthItem } from "./lib/types";
import { dateKey } from "./lib/normalize";

const DATA_DIR = path.join(process.cwd(), "eval", "data");

function writeJson(fileName: string, payload: GroundTruthFile): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const filePath = path.join(DATA_DIR, fileName);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`wrote ${payload.count} items → ${filePath}`);
}

async function buildAutoSet(): Promise<void> {
  const docs = await prisma.document.findMany({
    where: { status: "approved", financialRecord: { isNot: null } },
    select: {
      id: true,
      businessId: true,
      source: true,
      ocrText: true,
      financialRecord: {
        select: {
          amount: true,
          vendorName: true,
          date: true,
          direction: true,
        },
      },
    },
  });

  const items: GroundTruthItem[] = [];

  for (const doc of docs) {
    const fr = doc.financialRecord;
    if (!fr) continue;
    if (!doc.ocrText || !doc.ocrText.trim()) continue;

    items.push({
      docId: doc.id,
      businessId: doc.businessId,
      source: "financial_record",
      channel: doc.source ?? null,
      ocrText: doc.ocrText,
      truth: {
        vendor: fr.vendorName ?? null,
        amount: fr.amount ?? null,
        date: dateKey(fr.date),
        // docType is not stored on FinancialRecord — only the manual set covers it.
        docType: null,
        direction:
          fr.direction === "income" || fr.direction === "expense"
            ? fr.direction
            : null,
        // Approved financial records are, by definition, financial documents.
        isFinancial: true,
      },
    });
  }

  writeJson("ground-truth.auto.json", {
    generatedAt: new Date().toISOString(),
    source: "financial_record",
    count: items.length,
    items,
  });
}

async function buildManualTemplate(sampleSize: number): Promise<void> {
  // Representative sample of the NON-approved population: needs_review, rejected,
  // non-financial. These have no human-confirmed truth yet, so we emit a template
  // with empty fields for manual labeling. We do not filter by type to keep it
  // representative of what the engine actually faces.
  const docs = await prisma.document.findMany({
    where: { status: { not: "approved" } },
    orderBy: { id: "desc" },
    take: sampleSize,
    select: { id: true, businessId: true, source: true, ocrText: true },
  });

  const items: GroundTruthItem[] = docs
    .filter((doc) => doc.ocrText && doc.ocrText.trim())
    .map((doc) => ({
      docId: doc.id,
      businessId: doc.businessId,
      source: "manual",
      channel: doc.source ?? null,
      ocrText: doc.ocrText as string,
      truth: {
        vendor: null,
        amount: null,
        date: null,
        docType: null,
        direction: null,
        isFinancial: null,
      },
    }));

  writeJson("ground-truth.manual.template.json", {
    generatedAt: new Date().toISOString(),
    source: "manual_template",
    count: items.length,
    items,
  });

  console.log(
    "\nNEXT (human step): copy ground-truth.manual.template.json → " +
      "ground-truth.manual.json and fill in the `truth` fields. " +
      "Leave a field null if it does not apply / is not present in the document."
  );
}

async function main(): Promise<void> {
  const sampleSize = Number(process.argv[2] ?? "60");

  await buildAutoSet();
  await buildManualTemplate(Number.isFinite(sampleSize) ? sampleSize : 60);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
