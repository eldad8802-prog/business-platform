import {
  clampConfidence,
  confidenceToLabel,
  DocumentEntities,
  DocumentExtractionDecision,
} from "./document-entities.types";
import { validateDocumentEntities } from "./entity-validation.service";

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function decideDocumentExtraction(
  entities: DocumentEntities
): DocumentExtractionDecision {
  const validation = validateDocumentEntities(entities);

  const baseConfidence = average([
    entities.amount.confidence,
    entities.vendor.confidence,
    entities.date.confidence,
  ]);

  const confidenceScore = clampConfidence(
    baseConfidence + validation.confidenceAdjustment
  );

  const reviewReasons = [...validation.reviewReasons];

  if (entities.amount.needsReview) {
    reviewReasons.push("שדה הסכום דורש אישור");
  }

  if (entities.vendor.needsReview) {
    reviewReasons.push("שדה הספק דורש אישור");
  }

  if (entities.date.needsReview) {
    reviewReasons.push("שדה התאריך דורש אישור");
  }

  const needsReview =
    confidenceScore < 0.85 ||
    entities.amount.needsReview ||
    entities.vendor.needsReview ||
    entities.date.needsReview ||
    reviewReasons.length > 0;

  return {
    amount: entities.amount.value,
    vendorName: entities.vendor.name ?? "לא ידוע",
    date: entities.date.value,
    amountConfidence: confidenceToLabel(entities.amount.confidence),
    vendorConfidence: confidenceToLabel(entities.vendor.confidence),
    dateConfidence: confidenceToLabel(entities.date.confidence),
    confidenceScore,
    needsReview,
    reviewReasons: Array.from(new Set(reviewReasons)),
  };
}