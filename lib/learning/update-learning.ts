import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type TxOptions = { tx?: Prisma.TransactionClient };

// D2/P7-W4B: businessId is now REQUIRED so the confidence-score write is an
// atomic tenant-scoped mutation (updateMany with the tenant predicate) —
// a foreign suggestion id can no longer become a mutation handle.
export async function updateLearningFromAction(
  suggestionId: number,
  businessId: number,
  options?: TxOptions
) {
  const db = options?.tx ?? prisma;
  const suggestion = await db.replySuggestion.findFirst({
    where: { id: suggestionId, businessId },
  });

  if (!suggestion) {
    throw new Error("Suggestion not found for learning update");
  }

  let scoreBoost = 0;

  if (suggestion.selectedAt) {
    scoreBoost += 10;
  }

  if (suggestion.sentAt) {
    scoreBoost += 20;
  }

  if (suggestion.wasEdited) {
    scoreBoost -= 5;
  }

  if (suggestion.customerResponded) {
    scoreBoost += 40;
  }

  if (suggestion.ledToStageAdvance) {
    scoreBoost += 50;
  }

  await db.replySuggestion.updateMany({
    where: { id: suggestionId, businessId },
    data: {
      confidenceScore: (suggestion.confidenceScore ?? 0) + scoreBoost,
    },
  });
}
