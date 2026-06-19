/**
 * Amount Slice — Shadow comparison vs the legacy engine. READ-ONLY, eval-only.
 *   npx tsx --env-file=.env eval/amount-shadow.ts
 *
 * Runs the full structural Amount Slice (T1→T6) on real ingested document FILES
 * and compares the structural AmountReadout to the legacy engine's `amount`.
 * It persists nothing, changes no decision, touches no production/DB writes.
 * The only DB access is the legacy engine's vendorLearning read.
 *
 * Truth is QA-contaminated, so accuracy-vs-truth is NOT measured. Metrics are
 * internal consistency (closure found) + agreement/disagreement vs legacy.
 */

import fs from "fs";
import path from "path";
import { prisma } from "@/lib/prisma";
import { runGoogleVisionOCRWithGeometry } from "@/lib/services/documents/google-vision-ocr.service";
import { runUnifiedDocumentIntelligence } from "@/lib/services/documents/unified-extraction-engine.service";
import { buildRepresentationFromOcr } from "@/lib/services/documents/representation/document-representation";
import { groupTokensGeometrically } from "@/lib/services/documents/representation/document-grouping";
import { findAmountRelationsFromMoneyAmounts } from "@/lib/services/documents/representation/document-amount-relations";
import { deriveMoneyAmounts } from "@/lib/services/documents/representation/document-money-amount";
import { deriveAmountRoles } from "@/lib/services/documents/representation/document-amount-roles";
import { readAmount } from "@/lib/services/documents/representation/document-amount-readout";

const DOC_ROOTS = [
  path.join("storage", "documents"),
  path.join("storage", "platform"),
];

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function isMedia(file: string): boolean {
  const l = file.toLowerCase();
  return l.endsWith(".jpg") || l.endsWith(".jpeg") || l.endsWith(".png") || l.endsWith(".pdf");
}

function isIngestedDocument(file: string): boolean {
  // only files under a .../documents/... path (excludes billing-pdf output)
  return isMedia(file) && /[\\/]documents[\\/]/.test(file);
}

/** Sample real uploaded documents from public/uploads (spread across the timeline). */
function sampleUploads(cap: number): string[] {
  const all = walk(path.join("public", "uploads")).filter(isMedia).sort();
  if (all.length === 0) return [];
  const stride = Math.max(1, Math.floor(all.length / cap));
  return all.filter((_, i) => i % stride === 0).slice(0, cap);
}

function mimeFor(file: string): string {
  const l = file.toLowerCase();
  if (l.endsWith(".pdf")) return "application/pdf";
  if (l.endsWith(".png")) return "image/png";
  return "image/jpeg";
}

function businessIdFor(file: string): number {
  const norm = file.replace(/\\/g, "/");
  const m =
    norm.match(/storage\/documents\/(\d+)\//) ||
    norm.match(/storage\/platform\/biz\/(\d+)\//);
  return m ? Number(m[1]) : 1;
}

async function silence<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = err;
  }
}

type Row = {
  file: string;
  businessId: number;
  geometryAvailable: boolean;
  tokenCount: number;
  moneyCount: number;
  closureCount: number;
  relationType: string;
  closureFound: boolean;
  sliceState: string;
  sliceValue: number | null;
  sliceBasis: string | null;
  legacyAmount: number | null;
  legacyNeedsReview: boolean;
  legacyType: string;
  classification: string;
  error?: string;
};

function classify(
  sliceState: string,
  sliceValue: number | null,
  legacyAmount: number | null
): string {
  const sliceResolved = sliceState === "resolved" && sliceValue !== null;
  const legacyHas = legacyAmount !== null && Number.isFinite(legacyAmount);
  if (sliceResolved && legacyHas) {
    return Math.abs(sliceValue! - legacyAmount!) <= 0.01 ? "agreement" : "disagreement";
  }
  if (sliceResolved && !legacyHas) return "slice_resolves_legacy_abstains";
  if (!sliceResolved && legacyHas) return "slice_abstains_legacy_guesses";
  return "both_abstain";
}

async function processFile(file: string): Promise<Row> {
  const businessId = businessIdFor(file);
  const mimeType = mimeFor(file);
  try {
    const ocr = await silence(() =>
      runGoogleVisionOCRWithGeometry(path.resolve(file), mimeType)
    );
    const rep = buildRepresentationFromOcr(ocr);
    const grouping = groupTokensGeometrically(rep);
    const moneyAmounts = deriveMoneyAmounts(rep);
    const relation = findAmountRelationsFromMoneyAmounts(moneyAmounts, grouping);
    const roles = deriveAmountRoles(relation, grouping);
    const readout = readAmount(roles, moneyAmounts);

    const legacy = await silence(() =>
      runUnifiedDocumentIntelligence({ businessId, rawText: ocr.text })
    );

    return {
      file,
      businessId,
      geometryAvailable: ocr.geometryAvailable,
      tokenCount: ocr.tokens.length,
      moneyCount: moneyAmounts.length,
      closureCount: relation.closures.length,
      relationType: relation.relationType,
      closureFound: relation.closures.length > 0,
      sliceState: readout.resolutionState,
      sliceValue: readout.value,
      sliceBasis: readout.basis,
      legacyAmount: legacy.amount,
      legacyNeedsReview: legacy.needsReview,
      legacyType: legacy.documentType,
      classification: classify(readout.resolutionState, readout.value, legacy.amount),
    };
  } catch (e) {
    return {
      file,
      businessId,
      geometryAvailable: false,
      tokenCount: 0,
      moneyCount: 0,
      closureCount: 0,
      relationType: "error",
      closureFound: false,
      sliceState: "error",
      sliceValue: null,
      sliceBasis: null,
      legacyAmount: null,
      legacyNeedsReview: false,
      legacyType: "error",
      classification: "error",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function main() {
  const storageDocs = Array.from(new Set(DOC_ROOTS.flatMap(walk))).filter(
    isIngestedDocument
  );
  const uploads = sampleUploads(40);
  const files = [...storageDocs, ...uploads];
  console.log(`corpus: ${storageDocs.length} storage + ${uploads.length} uploads = ${files.length}`);

  const rows: Row[] = [];
  for (const file of files) rows.push(await processFile(file));

  const count = (pred: (r: Row) => boolean) => rows.filter(pred).length;

  console.log("==================== AMOUNT SLICE — SHADOW REPORT ====================");
  console.log("documents run:", rows.length);
  console.log("geometry available:", count((r) => r.geometryAvailable));
  console.log("errors:", count((r) => r.classification === "error"));
  console.log("");
  console.log("slice resolution:");
  console.log("  resolved:  ", count((r) => r.sliceState === "resolved"));
  console.log("  ambiguous: ", count((r) => r.sliceState === "ambiguous"));
  console.log("  unresolved:", count((r) => r.sliceState === "unresolved"));
  console.log("  arithmetic closure found:", count((r) => r.closureFound));
  console.log("");
  console.log("vs legacy:");
  console.log("  agreement:                  ", count((r) => r.classification === "agreement"));
  console.log("  disagreement:               ", count((r) => r.classification === "disagreement"));
  console.log("  slice resolves, legacy abstains:", count((r) => r.classification === "slice_resolves_legacy_abstains"));
  console.log("  slice abstains, legacy guesses: ", count((r) => r.classification === "slice_abstains_legacy_guesses"));
  console.log("  both abstain:               ", count((r) => r.classification === "both_abstain"));
  console.log("");
  console.log("---- per document ----");
  for (const r of rows) {
    console.log(
      JSON.stringify({
        file: r.file.replace(/\\/g, "/").replace("storage/", ""),
        biz: r.businessId,
        geo: r.geometryAvailable,
        tokens: r.tokenCount,
        money: r.moneyCount,
        closures: r.closureCount,
        rel: r.relationType,
        slice: r.sliceState,
        sliceVal: r.sliceValue,
        basis: r.sliceBasis,
        legacy: r.legacyAmount,
        legacyType: r.legacyType,
        class: r.classification,
        ...(r.error ? { error: r.error } : {}),
      })
    );
  }
  console.log("");
  console.log("---- disagreement / divergence examples (manual review) ----");
  const diverge = rows.filter((r) =>
    ["disagreement", "slice_resolves_legacy_abstains", "slice_abstains_legacy_guesses"].includes(
      r.classification
    )
  );
  for (const r of diverge.slice(0, 10)) {
    console.log(
      JSON.stringify({
        file: r.file.replace(/\\/g, "/").replace("storage/", ""),
        sliceVal: r.sliceValue,
        sliceState: r.sliceState,
        basis: r.sliceBasis,
        legacy: r.legacyAmount,
        class: r.classification,
      })
    );
  }
}

main()
  .catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
