type AnalysisInput = {
  intent: string;
  stage: string;
};

export type SuggestionMode = "FULL" | "SOFT" | "MINIMAL";

function normalizeText(text: string) {
  return text.toLowerCase().trim();
}

function includesAny(text: string, keywords: string[]) {
  return keywords.some((keyword) => text.includes(keyword));
}

function isBusinessAction(intent: string) {
  return intent === "price" || intent === "availability" || intent === "booking";
}

function isProgressMessage(text: string) {
  const normalized = normalizeText(text);

  return includesAny(normalized, [
    "מתאים לי",
    "יאללה",
    "סגור",
    "בוא נקבע",
    "בואי נקבע",
    "אפשר להתקדם",
    "בוא נתקדם",
    "בואי נתקדם",
    "סבבה אפשר",
    "סבבה בוא",
    "אפשר לסגור",
  ]);
}

function isPassiveMessage(text: string) {
  const normalized = normalizeText(text);

  return includesAny(normalized, [
    "סבבה",
    "תודה",
    "הבנתי",
    "👍",
    "בדיקה",
    "...",
    "חח",
    "אוקי",
    "אוקיי",
    "בסדר",
    "מעולה",
  ]);
}

export function getSuggestionMode(
  analysis: AnalysisInput,
  text?: string
): SuggestionMode {
  const currentText = normalizeText(text || "");

  // 1. intent עסקי → FULL
  if (isBusinessAction(analysis.intent)) {
    return "FULL";
  }

  // 2. הודעת התקדמות → FULL
  if (isProgressMessage(currentText)) {
    return "FULL";
  }

  // 3. closing → SOFT (אם לא פסיבי)
  if (analysis.stage === "closing" && !isPassiveMessage(currentText)) {
    return "SOFT";
  }

  // 4. הודעות פסיביות → MINIMAL
  if (isPassiveMessage(currentText)) {
    return "MINIMAL";
  }

  // 5. fallback → SOFT
  return "SOFT";
}