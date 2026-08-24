import { normalizeText } from "./normalize-text.service";
import { extractFields } from "./extract-fields.service";
// Business Memory READ-4: comparison-only wrapper over the incumbent decideCategory. Dark by default
// (BUSINESS_MEMORY_READ OFF) => identical to decideCategory; ON => same value + a comparison log only.
import { categorySuggestionWithComparison } from "@/lib/business-memory/read/comparison-read";

export async function runExtractionEngine(
  businessId: number,
  rawText: string
) {
  const normalized = normalizeText(rawText);

  const fields = extractFields(normalized);

  const categoryResult = await categorySuggestionWithComparison(
    businessId,
    fields.vendorName,
    normalized
  );

  return {
    amount: fields.amount,
    vendorName: fields.vendorName,
    date: fields.date,
    category: categoryResult.category,

    amountConfidence: fields.amountConfidence,
    vendorConfidence: fields.vendorConfidence,
    categoryConfidence: categoryResult.confidence,
  };
}