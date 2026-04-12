type RankedSuggestion = {
  strategyType: string;
  variantType: string;
  finalScore: number;
};

type Analysis = {
  intent: string;
  stage: string;
};

export function explainDecision(
  best: RankedSuggestion | null,
  analysis: Analysis,
  autoSend: boolean
) {
  if (!best) {
    return {
      bestSuggestionReason: "לא נבחרה תשובה כי לא נמצאה הצעה מתאימה.",
      autoSendReason: "לא נשלח אוטומטית כי לא נבחרה הצעה.",
    };
  }

  let bestSuggestionReason = `נבחרה האסטרטגיה ${best.strategyType} עם וריאנט ${best.variantType} כי היא קיבלה ציון ${best.finalScore}.`;

  if (analysis.intent === "booking") {
    bestSuggestionReason += " הלקוח נמצא בכוונת קביעת תור.";
  }

  if (analysis.intent === "availability") {
    bestSuggestionReason += " הלקוח שואל על זמינות.";
  }

  if (analysis.intent === "price") {
    bestSuggestionReason += " הלקוח שואל על מחיר.";
  }

  if (analysis.stage === "early") {
    bestSuggestionReason += " שלב השיחה מוקדם.";
  }

  if (analysis.stage === "middle") {
    bestSuggestionReason += " שלב השיחה באמצע.";
  }

  if (analysis.stage === "late") {
    bestSuggestionReason += " שלב השיחה מתקדם.";
  }

  const autoSendReason = autoSend
    ? "המערכת אישרה שליחה אוטומטית לפי score, intent ו-stage."
    : "המערכת לא אישרה שליחה אוטומטית לפי חוקי הבטיחות.";

  return {
    bestSuggestionReason,
    autoSendReason,
  };
}