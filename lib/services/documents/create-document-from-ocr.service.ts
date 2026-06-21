import { prisma } from "@/lib/prisma";
import { runUnifiedDocumentIntelligence } from "@/lib/services/documents/unified-extraction-engine.service";
import { recordExtractionSnapshot } from "@/lib/services/documents/ledger/correction-ledger.service";

export async function createDocumentFromOcrText(params: {
  businessId: number;
  source: "email" | "file" | "whatsapp";
  mimeType: string;
  ocrText: string;
  fileUrl: string;
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

  const document = await prisma.document.create({
    data: {
      businessId: params.businessId,
      fileUrl: params.fileUrl,
      source: params.source,
      mimeType: params.mimeType,
      status: "needs_review",
      ocrText: params.ocrText,
    },
  });

  const extractedData = await prisma.extractedData.create({
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
  });

  // Phase 1A Correction Ledger — additive, write-only, never throws.
  await recordExtractionSnapshot({
    documentId: document.id,
    businessId: params.businessId,
    sourceChannel: params.source,
    ocrText: params.ocrText,
    extracted,
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

