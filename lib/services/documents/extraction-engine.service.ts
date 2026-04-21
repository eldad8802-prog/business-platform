import { normalizeText } from "./normalize-text.service";
import { extractFields } from "./extract-fields.service";
import { decideCategory } from "./category-decision.service";

export async function runExtractionEngine(
  businessId: number,
  rawText: string
) {
  const normalized = normalizeText(rawText);

  const fields = extractFields(normalized);

  const categoryResult = await decideCategory(
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