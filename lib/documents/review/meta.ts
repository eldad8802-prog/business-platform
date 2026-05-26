import type { ApiExtracted, ExtractionConfidenceMeta } from "./types";

export function buildExtractionMeta(
  extracted: ApiExtracted | null
): ExtractionConfidenceMeta | null {
  if (!extracted) return null;
  return {
    amountConfidence: extracted.amountConfidence ?? null,
    vendorConfidence: extracted.vendorConfidence ?? null,
    categoryConfidence: extracted.categoryConfidence ?? null,
    confidenceScore:
      typeof extracted.confidenceScore === "number" ? extracted.confidenceScore : null,
  };
}
