import type { DocumentStructure } from "../document-structure.service";
import type { DocumentEntities } from "./document-entities.types";

import { extractAmountEntity } from "./amount-entity.service";
import { extractBusinessIdEntities } from "./business-id-entity.service";
import { extractDateEntity } from "./date-entity.service";
import { extractVendorEntity } from "./vendor-entity.service";

import { applyAmountStrategy } from "../amount-strategy.service";
import { applyVendorStrategy } from "../vendor-strategy.service";
import { understandDocument } from "../understanding/document-understanding.service";
import {
  isOwnName,
  isOwnTaxId,
  readIssuer,
  type IssuerReading,
  type OwnBusinessIdentity,
} from "../issuer/issuer-reading";

export type DocumentUnderstandingResult = ReturnType<typeof understandDocument>;

export type DocumentEntitiesWithUnderstanding = {
  entities: DocumentEntities;
  understanding: DocumentUnderstandingResult;
  /** Only when the business's own identity was given (document supplier linking ON); otherwise null. */
  issuer: IssuerReading | null;
};

/**
 * `own` (optional): the business's own name and tax id. When given, they are the RECIPIENT and never the
 * vendor — its tax ids are not vendor anchors and its name is not a vendor candidate — and the issuer
 * reading is returned. Without it the extraction is exactly as before and `issuer` is null.
 */
export function extractDocumentEntities(
  cleanedText: string,
  structure: DocumentStructure,
  own?: OwnBusinessIdentity | null
): DocumentEntitiesWithUnderstanding {
  const businessIds = extractBusinessIdEntities(cleanedText, structure);

  let ownNameExcluded = false;
  const exclude = own
    ? (name: string) => {
        const hit = isOwnName(own, name);
        if (hit) ownNameExcluded = true;
        return hit;
      }
    : undefined;
  const vendorBusinessIds = own
    ? businessIds.filter((id) => !isOwnTaxId(own, id.value))
    : businessIds;

  const rawVendor = extractVendorEntity(
    cleanedText,
    structure,
    vendorBusinessIds,
    exclude
  );

  const rawAmount = extractAmountEntity(cleanedText);

  const rawDate = extractDateEntity(
    cleanedText,
    structure
  );

  const strategyVendor = applyVendorStrategy(
    structure,
    vendorBusinessIds,
    rawVendor,
    exclude
  );

  const issuer = own
    ? readIssuer({
        businessIds,
        vendor: strategyVendor,
        headerLines: structure.headerLines,
        allLines: structure.allLines,
        own,
        ownNameExcluded,
      })
    : null;

  // The business's own details were on the document and were kept out: the vendor that is left was not
  // chosen with them, so it is never presented as certain.
  const vendorAfterStrategy =
    issuer?.ownBusinessExcluded && !strategyVendor.needsReview
      ? {
          ...strategyVendor,
          needsReview: true,
          confidence: Math.min(strategyVendor.confidence, 0.8),
          signals: [...strategyVendor.signals, "own business details excluded from vendor"],
          reason: "Vendor requires confirmation: the business's own details appear on the document",
        }
      : strategyVendor;

  const amountAfterStrategy = applyAmountStrategy(
    cleanedText,
    rawAmount
  );

  const understanding = understandDocument(cleanedText);

  // Privacy: counts only — the understanding object holds the document's lines,
  // amounts and vendor candidates.
  console.log("DOCUMENT UNDERSTANDING:", {
    lineCount: understanding.lines.length,
    semanticFieldCount: understanding.semanticFields.length,
    amountCount: understanding.amounts.length,
    vendorCount: understanding.vendors.length,
    dateCount: understanding.dates.length,
  });

  return {
    entities: {
      vendor: vendorAfterStrategy,
      businessIds,
      amount: amountAfterStrategy,
      date: rawDate,
    },
    understanding,
    issuer,
  };
}