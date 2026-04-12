type ContextMessage = {
  id: number;
  contentText: string | null;
};

type IntentLabel = "price" | "availability" | "booking" | "unclear";
type StageLabel = "early" | "middle" | "closing";

function normalizeText(text: string) {
  return text.toLowerCase().trim();
}

function includesAny(text: string, keywords: string[]) {
  return keywords.some((keyword) => text.includes(keyword));
}

function buildContextText(contextMessages: ContextMessage[]) {
  return contextMessages
    .map((message) => normalizeText(message.contentText || ""))
    .filter(Boolean)
    .join(" ");
}

function detectDirectIntent(text: string): IntentLabel | null {
  if (includesAny(text, ["כמה", "מחיר", "עולה", "עלות"])) {
    return "price";
  }

  if (includesAny(text, ["מקום", "זמינות", "פנוי", "פנויה", "מתי"])) {
    return "availability";
  }

  if (
    includesAny(text, [
      "לקבוע",
      "תור",
      "להזמין",
      "להגיע",
      "נקבע",
      "לקבוע תור",
    ])
  ) {
    return "booking";
  }

  if (
    includesAny(text, [
      "מתאים לי",
      "סגור",
      "יאללה",
      "בואי נקבע",
      "בוא נקבע",
    ])
  ) {
    return "booking";
  }

  return null;
}

function isResponseMessage(text: string) {
  return includesAny(text, [
    "סבבה",
    "אוקיי",
    "אוקי",
    "מעולה",
    "הבנתי",
    "תודה",
    "סגור",
    "מצוין",
    "בסדר",
    "סבבה תודה",
    "עזוב",
    "אני אחשוב",
    "אני עוד חושב",
    "אני עוד אחשוב",
  ]);
}

function hasPreviousConversation(contextMessages: ContextMessage[]) {
  return contextMessages.some(
    (message) => normalizeText(message.contentText || "").length > 0
  );
}

function detectIntent(
  currentText: string,
  contextMessages: ContextMessage[]
): IntentLabel {
  const text = normalizeText(currentText);
  const directIntent = detectDirectIntent(text);

  if (directIntent) {
    return directIntent;
  }

  if (isResponseMessage(text)) {
    return "unclear";
  }

  const contextText = buildContextText(contextMessages);

  if (!contextText) {
    return "unclear";
  }

  if (
    includesAny(text, ["אפשר", "כן", "אז", "סבבה", "מעולה"]) &&
    includesAny(contextText, ["לקבוע", "תור", "להזמין", "להגיע"])
  ) {
    return "booking";
  }

  if (
    includesAny(text, ["באיזה שעה", "מתי אפשר", "מחר מתאים", "היום מתאים"]) &&
    includesAny(contextText, ["מקום", "זמינות", "פנוי", "פנויה", "מתי"])
  ) {
    return "availability";
  }

  return "unclear";
}

function detectStage(
  currentText: string,
  contextMessages: ContextMessage[],
  intent: IntentLabel
): StageLabel {
  const text = normalizeText(currentText);
  const contextText = buildContextText(contextMessages);
  const hasContext = hasPreviousConversation(contextMessages);

  const directClosing =
    intent === "booking" &&
    includesAny(text, [
      "לקבוע",
      "תור",
      "להזמין",
      "להגיע",
      "מתאים לי",
      "סגור",
      "יאללה",
      "מחר ב",
      "בשעה",
      "אפשר ב",
    ]);

  if (directClosing) {
    return "closing";
  }

  if (!hasContext) {
    if (intent === "price" || intent === "availability") {
      return "early";
    }

    if (intent === "booking") {
      return "closing";
    }

    return "middle";
  }

  if (isResponseMessage(text)) {
    if (
      includesAny(contextText, ["לקבוע", "תור", "להזמין", "להגיע"]) &&
      includesAny(text, ["מתאים לי", "סגור", "יאללה"])
    ) {
      return "closing";
    }

    return "middle";
  }

  if (intent === "booking") {
    return "closing";
  }

  if (intent === "price") {
    return "middle";
  }

  if (intent === "availability") {
    if (
      includesAny(text, ["באיזה שעה", "מתי", "אפשר ב", "מתאים לי"]) ||
      includesAny(contextText, ["כמה", "מחיר", "עולה", "עלות"])
    ) {
      return "middle";
    }

    return "early";
  }

  return "middle";
}

export function analyzeMessage(
  text: string,
  contextMessages: ContextMessage[] = []
) {
  const intent = detectIntent(text, contextMessages);
  const stage = detectStage(text, contextMessages, intent);

  return {
    intent,
    stage,
  };
}