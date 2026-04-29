import type { AmountEntity } from "../entities/document-entities.types";
import type { SemanticField } from "../semantic-field-mapper.service";
import { classifyAmountLine } from "../amount-classifier.service";

function getSemanticAmounts(semantics: SemanticField[]) {
  return semantics.filter(
    (field) => field.type === "amount" || field.type === "fee"
  );
}

function scoreSemanticAmount(field: SemanticField): number {
  const amountClass = classifyAmountLine(field.raw);

  let score = field.confidence * 100;

  if (amountClass === "total") score += 120;
  if (amountClass === "fee") score += 70;
  if (amountClass === "subtotal") score += 40;
  if (amountClass === "vat") score -= 80;
  if (amountClass === "hours") score -= 300;
  if (amountClass === "id") score -= 400;
  if (amountClass === "noise") score -= 120;

  if (typeof field.value === "number") {
    if (field.value < 10) score -= 100;
    if (field.value >= 100 && field.value <= 100000) score += 20;
  }

  return score;
}

export function resolveFinalAmount(params: {
  extracted: AmountEntity;
  semantics: SemanticField[];
}): AmountEntity {
  const { extracted, semantics } = params;

  const semanticAmounts = getSemanticAmounts(semantics)
    .filter((field) => typeof field.value === "number")
    .map((field) => ({
      field,
      amountClass: classifyAmountLine(field.raw),
      score: scoreSemanticAmount(field),
    }))
    .filter((item) => item.amountClass !== "id")
    .filter((item) => item.amountClass !== "hours")
    .filter((item) => item.score >= 40)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.field.value as number) - (a.field.value as number);
    });

  const bestSemantic = semanticAmounts[0];

  if (!bestSemantic) {
    return extracted;
  }

  const semanticValue = bestSemantic.field.value as number;

  if (extracted.isSuspicious || extracted.confidence < 0.7) {
    return {
      ...extracted,
      value: semanticValue,
      raw: String(semanticValue),
      confidence: bestSemantic.amountClass === "total" ? 0.9 : 0.82,
      source: "validation",
      isSuspicious: false,
      needsReview: bestSemantic.amountClass !== "total",
      signals: [
        ...extracted.signals,
        `decision layer: selected semantic amount class=${bestSemantic.amountClass}`,
        `semantic raw=${bestSemantic.field.raw}`,
      ],
      reason: "Amount selected by decision layer from semantic mapping",
    };
  }

  if (
    bestSemantic.amountClass === "total" &&
    semanticValue > extracted.value * 1.5
  ) {
    return {
      ...extracted,
      value: semanticValue,
      raw: String(semanticValue),
      confidence: 0.92,
      source: "validation",
      isSuspicious: false,
      needsReview: false,
      signals: [
        ...extracted.signals,
        "decision layer: semantic total overrides extracted amount",
        `semantic raw=${bestSemantic.field.raw}`,
      ],
      reason: "Amount overridden by semantic total field",
    };
  }

  return extracted;
}