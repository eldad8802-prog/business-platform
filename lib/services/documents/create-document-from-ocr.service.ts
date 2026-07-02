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
  extractedDataId: number | null;
  analysis: {
    documentType: string;
    isFinancial: boolean;
    guardrailRoute: string;
    needsReview: boolean;
    direction: string;
    confidence: number;
  } | null;
}> {
  // SEC-24: extraction is best-effort ENRICHMENT. Its failure MUST NOT discard
  // the already-persisted artifact — so extraction runs inside try/catch and the
  // needs_review Document is created regardless. On extraction failure we skip
  // ExtractedData (mirrors the upload / Gmail bare-document fallback), and the
  // document surfaces in the Review Station for manual completion. This is the
  // shared choke point for the WhatsApp and Gmail import paths.
  let extracted: Awaited<
    ReturnType<typeof runUnifiedDocumentIntelligence>
  > | null = null;
  try {
    extracted = await runUnifiedDocumentIntelligence({
      businessId: params.businessId,
      rawText: params.ocrText,
    });
  } catch (extractionError) {
    console.error("CREATE_DOCUMENT_EXTRACTION_FAILED:", extractionError);
    extracted = null;
  }

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

  // Extraction unavailable → bare needs_review Document (no ExtractedData).
  if (!extracted) {
    return { documentId: document.id, extractedDataId: null, analysis: null };
  }

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
