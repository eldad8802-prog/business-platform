import { RankedSuggestion } from "./rank-suggestions";

export function selectBestSuggestion(
  suggestions: RankedSuggestion[]
): RankedSuggestion | null {
  if (!suggestions.length) return null;

  return suggestions[0];
}