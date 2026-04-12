import { prisma } from "@/lib/prisma";

export async function updateLearningFromAction(suggestionId: number) {
  const suggestion = await prisma.replySuggestion.findUnique({
    where: { id: suggestionId },
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

  await prisma.replySuggestion.update({
    where: { id: suggestionId },
    data: {
      confidenceScore: (suggestion.confidenceScore ?? 0) + scoreBoost,
    },
  });
}