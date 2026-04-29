type Confidence = "high" | "medium" | "low";

function hasEnoughLineItems(text: string): boolean {
  const lines = text.split("\n");

  let count = 0;

  for (const line of lines) {
    const numbers = line.match(/\d+/g);

    if (!numbers) continue;

    const valid = numbers
      .map(Number)
      .filter((n) => n > 5 && n < 200);

    if (valid.length > 0) {
      count++;
    }
  }

  return count >= 2;
}

export function validateAmount(
  extractedAmount: number,
  text: string
): {
  finalAmount: number;
  confidenceAdjustment: "keep" | "upgrade" | "downgrade";
} {
  const hasItems = hasEnoughLineItems(text);

  // 🔥 אין מספיק פריטים → לא מורידים confidence
  if (!hasItems) {
    return {
      finalAmount: extractedAmount,
      confidenceAdjustment: "keep",
    };
  }

  // 🔥 בעתיד: חישוב סכום פריטים (כרגע לא)
  return {
    finalAmount: extractedAmount,
    confidenceAdjustment: "keep",
  };
}