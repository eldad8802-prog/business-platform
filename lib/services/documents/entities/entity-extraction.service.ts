import type { DocumentStructure } from "../document-structure.service";
import type { DocumentEntities } from "./document-entities.types";

import { extractAmountEntity } from "./amount-entity.service";
import { extractBusinessIdEntities } from "./business-id-entity.service";
import { extractDateEntity } from "./date-entity.service";
import { extractVendorEntity } from "./vendor-entity.service";

import { applyAmountStrategy } from "../amount-strategy.service";
import { applyVendorStrategy } from "../vendor-strategy.service";
import { understandDocument } from "../understanding/document-understanding.service";

export type DocumentUnderstandingResult = ReturnType<typeof understandDocument>;

export type DocumentEntitiesWithUnderstanding = {
  entities: DocumentEntities;
  understanding: DocumentUnderstandingResult;
};

export function extractDocumentEntities(
  cleanedText: string,
  structure: DocumentStructure
): DocumentEntitiesWithUnderstanding {
  const businessIds = extractBusinessIdEntities(cleanedText, structure);

  const rawVendor = extractVendorEntity(
    cleanedText,
    structure,
    businessIds
  );

  const rawAmount = extractAmountEntity(cleanedText);

  const rawDate = extractDateEntity(
    cleanedText,
    structure
  );

  const vendorAfterStrategy = applyVendorStrategy(
    structure,
    businessIds,
    rawVendor
  );

  const amountAfterStrategy = applyAmountStrategy(
    cleanedText,
    rawAmount
  );

  const understanding = understandDocument(cleanedText);

  console.log("DOCUMENT UNDERSTANDING:", understanding);

  return {
    entities: {
      vendor: vendorAfterStrategy,
      businessIds,
      amount: amountAfterStrategy,
      date: rawDate,
    },
    understanding,
  };
}