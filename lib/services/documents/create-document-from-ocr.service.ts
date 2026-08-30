import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { getTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

// D2/P7-W4D: run a single DB step on a short tenant transaction when a tenant
// context is established (all document routes set one); outside a context the
// step runs directly (pure unit tests / offline scripts). Under an
// established context there is NO fallback to the global client.
async function dbStep<T>(
  fn: (db: typeof prisma) => Promise<T>
): Promise<T> {
  if (getTenantContext() !== undefined) {
    // TransactionClient supports the same query surface these callbacks use;
    // the cast keeps precise select/include payload types.
    return withTenantTransaction((tx) => fn(tx as unknown as typeof prisma));
  }
  return fn(prisma);
}
import { runUnifiedDocumentIntelligence } from "@/lib/services/documents/unified-extraction-engine.service";
import { recordExtractionSnapshot } from "@/lib/services/documents/ledger/correction-ledger.service";

export async function createDocumentFromOcrText(params: {
  businessId: number;
  source: "email" | "file" | "whatsapp";
  mimeType: string;
  ocrText: string;
  fileUrl: string;
  /** Duplicate-defense identity of the original bytes (Wave 1B). */
  contentHashSha256?: string | null;
  originalFilename?: string | null;
  sizeBytes?: number | null;
}): Promise<{
  documentId: number;
  extractedDataId: number;
  analysis: {
    documentType: string;
    isFinancial: boolean;
    guardrailRoute: string;
    needsReview: boolean;
    direction: string;
    confidence: number;
  };
}> {
  const extracted = await runUnifiedDocumentIntelligence({
    businessId: params.businessId,
    rawText: params.ocrText,
  });

  const document = await dbStep((db) => db.document.create({
    data: {
      businessId: params.businessId,
      fileUrl: params.fileUrl,
      source: params.source,
      mimeType: params.mimeType,
      status: "needs_review",
      ocrText: params.ocrText,
      contentHashSha256: params.contentHashSha256 ?? null,
      originalFilename: params.originalFilename?.trim().slice(0, 255) || null,
      sizeBytes: params.sizeBytes ?? null,
    },
  }));

  const extractedData = await dbStep((db) => db.extractedData.create({
    data: {
      documentId: document.id,
      amount: extracted.amount,
      vendorName: extracted.vendorName,
      category: extracted.category,
      amountConfidence: extracted.amountConfidence,
      vendorConfidence: extracted.vendorConfidence,
      categoryConfidence: extracted.categoryConfidence,
      direction: extracted.direction,
      date: extracted.date,
      confidenceScore: extracted.confidence,
    },
  }));

  // Phase 1A Correction Ledger — additive, write-only, never throws.
  await recordExtractionSnapshot({
    documentId: document.id,
    businessId: params.businessId,
    sourceChannel: params.source,
    ocrText: params.ocrText,
    extracted,
    // This path always runs extraction to a result (Gap 1 parity).
    extractionOutcome: "ok",
  });

  return {
    documentId: document.id,
    extractedDataId: extractedData.id,
    analysis: {
      documentType: extracted.documentType,
      isFinancial: extracted.isFinancial,
      guardrailRoute: extracted.guardrailRoute,
      needsReview: extracted.needsReview,
      direction: extracted.direction,
      confidence: extracted.confidence,
    },
  };
}

