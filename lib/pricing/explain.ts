import type { PricingResult } from "./types";

export function buildExplanation(result: PricingResult): string {
  return `העלות הכוללת שלך היא ${result.fullCost.toFixed(
    2
  )}. מחיר מינימום שומר שלא תפסיד. המחיר המומלץ נותן רווח תקין. המחיר הגבוה מתאים למצבים שבהם ניתן לתמחר גבוה יותר.`;
}