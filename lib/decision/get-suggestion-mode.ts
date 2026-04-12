type AnalysisInput = {
  intent: string;
  stage: string;
};

export type SuggestionMode = "FULL" | "SOFT" | "MINIMAL";

function normalize(text: string) {
  return (text || "").toLowerCase().trim();
}

function isShortReaction(text: string) {
  const t = normalize(text);
  return ["סבבה", "אוקי", "אוקיי", "ok", "👍", "👌", "מעולה"].includes(t);
}

function isClosing(text: string) {
  const t = normalize(text);
  return ["תודה", "תודה רבה", "מעולה תודה", "סבבה תודה"].includes(t);
}

export function getSuggestionMode(
  analysis: AnalysisInput,
  contentText: string
): SuggestionMode {
  const text = normalize(contentText);

  if (!text) return "MINIMAL";

  // 🔥 intents חשובים תמיד FULL
  if (
    analysis.intent === "price" ||
    analysis.intent === "availability" ||
    analysis.intent === "booking"
  ) {
    return "FULL";
  }

  // 🔥 הודעת סיום → לא להציע בכלל
  if (isClosing(text)) {
    return "MINIMAL";
  }

  // 🔥 תגובת ביניים קצרה
  if (isShortReaction(text)) {
    return "SOFT";
  }

  // 🔥 שלב מתקדם אבל לא ברור
  if (analysis.stage === "closing") {
    return "SOFT";
  }

  return "FULL";
}