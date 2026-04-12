export type Suggestion = {
  id: number;
  strategyType: string;
  variantType: string;
  text: string;
  toneLabel?: string | null;
  confidenceScore?: number | null;
};

export type RankedSuggestion = Suggestion & {
  finalScore: number;
};

export function rankSuggestions(
  suggestions: Suggestion[],
  analysis: any
): RankedSuggestion[] {
  return suggestions
    .map((s) => {
      let score = 0;

      // 🎯 STAGE
      if (analysis.stage === "early" && s.variantType === "SOFT") score += 20;
      if (analysis.stage === "middle" && s.variantType === "SAFE") score += 20;
      if (analysis.stage === "late" && s.variantType === "DIRECT") score += 30;

      // ✂️ LENGTH
      if (s.text.length < 120) score += 10;

      // 🧠 LEARNING
      if (s.confidenceScore) {
        score += s.confidenceScore * 0.3;
      }

      return {
        ...s,
        finalScore: score,
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore);
}