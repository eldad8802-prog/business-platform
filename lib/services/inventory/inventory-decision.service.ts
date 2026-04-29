export function decideInventoryAction(matches: any[]) {
  if (!matches || matches.length === 0) {
    return {
      recommendedAction: "CREATE_NEW",
      confidence: 0.9,
      reason: "No matches found",
    };
  }

  const topMatch = matches[0];

  if (topMatch.matchScore >= 90) {
    return {
      recommendedAction: "MERGE",
      recommendedItemId: topMatch.itemId,
      confidence: 0.95,
      reason: "Exact or near-exact match",
    };
  }

  if (topMatch.matchScore < 60) {
    return {
      recommendedAction: "CREATE_NEW",
      confidence: 0.7,
      reason: "Low similarity",
    };
  }

  return {
    recommendedAction: "REVIEW",
    recommendedItemId: topMatch.itemId,
    confidence: 0.6,
    reason: "Possible match requires confirmation",
  };
}