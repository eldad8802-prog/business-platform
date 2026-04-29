import type { DocumentEntities } from "./document-entities.types";

export type EntityValidationResult = {
  confidenceAdjustment: number;
  reviewReasons: string[];
};

export function validateDocumentEntities(
  entities: DocumentEntities
): EntityValidationResult {
  const reviewReasons: string[] = [];
  let confidenceAdjustment = 0;

  if (!entities.vendor.name) {
    reviewReasons.push("לא זוהה ספק בצורה אמינה");
    confidenceAdjustment -= 0.15;
  }

  if (entities.vendor.confidence < 0.65) {
    reviewReasons.push("ביטחון נמוך בזיהוי הספק");
    confidenceAdjustment -= 0.1;
  }

  if (entities.amount.value <= 0) {
    reviewReasons.push("לא זוהה סכום תקין");
    confidenceAdjustment -= 0.2;
  }

  if (entities.amount.value > 1_000_000) {
    reviewReasons.push("הסכום מעל מיליון ודורש בדיקה");
    confidenceAdjustment -= 0.2;
  }

  if (entities.amount.isSuspicious) {
    reviewReasons.push("הסכום חשוד ודורש אישור");
    confidenceAdjustment -= 0.12;
  }

  if (!entities.date.value) {
    reviewReasons.push("לא זוהה תאריך מסמך");
    confidenceAdjustment -= 0.08;
  }

  if (entities.businessIds.length === 0) {
    reviewReasons.push("לא זוהה ח.פ / ע.מ / מזהה עסקי");
    confidenceAdjustment -= 0.05;
  }

  if (
    entities.vendor.businessId &&
    entities.businessIds.length > 0 &&
    !entities.businessIds.some((id) => id.value === entities.vendor.businessId)
  ) {
    reviewReasons.push("יש חוסר התאמה בין הספק למזהה העסקי");
    confidenceAdjustment -= 0.15;
  }

  return {
    confidenceAdjustment,
    reviewReasons,
  };
}