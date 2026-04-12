import { RankedSuggestion } from "@/lib/reply-suggestions/rank-suggestions";

type Analysis = {
  intent: string;
  stage: string;
};

export function shouldAutoSend(
  best: RankedSuggestion | null,
  analysis: Analysis
) {
  if (!best) return false;

  if (best.finalScore < 60) return false;

  if (analysis.stage === "late") return false;

  if (analysis.intent === "price") return false;

  if (best.strategyType === "OPEN_CONVERSATION") return true;

  if (best.strategyType === "LOW_FRICTION_BOOKING") return true;

  return false;
}