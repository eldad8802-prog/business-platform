import { prisma } from "@/lib/prisma";

type MessageInput = {
  id: number;
  businessId: number;
  conversationId: number;
};

type AnalysisInput = {
  intent: string;
  stage: string;
};

type ContextMessage = {
  id: number;
  contentText: string | null;
};

type SuggestionDraft = {
  text: string;
  strategyType: string;
  variantType: string;
  toneLabel: string;
};

function normalizeText(text: string) {
  return text.toLowerCase().trim();
}

function includesAny(text: string, keywords: string[]) {
  return keywords.some((keyword) => text.includes(keyword));
}

function getPreviousMessages(
  message: MessageInput,
  contextMessages: ContextMessage[]
) {
  return contextMessages.filter(
    (contextMessage) => contextMessage.id !== message.id
  );
}

function buildContextText(previousMessages: ContextMessage[]) {
  return previousMessages
    .map((message) => normalizeText(message.contentText || ""))
    .filter(Boolean)
    .join(" ");
}

function hasPriceContext(contextText: string) {
  return includesAny(contextText, ["כמה", "מחיר", "עולה", "עלות"]);
}

function hasAvailabilityContext(contextText: string) {
  return includesAny(contextText, ["מקום", "זמינות", "פנוי", "פנויה", "מתי"]);
}

function hasBookingContext(contextText: string) {
  return includesAny(contextText, [
    "לקבוע",
    "תור",
    "להזמין",
    "להגיע",
    "נקבע",
    "מתאים לי",
    "יאללה",
    "סגור",
  ]);
}

function chooseVariantType(stage: string) {
  if (stage === "closing") {
    return "DIRECT";
  }

  if (stage === "middle") {
    return "SAFE";
  }

  return "SOFT";
}

function toneFromVariant(variantType: string) {
  if (variantType === "DIRECT") {
    return "professional";
  }

  if (variantType === "SAFE") {
    return "professional";
  }

  return "friendly";
}

function buildPriceSuggestion(
  analysis: AnalysisInput,
  contextText: string
): SuggestionDraft {
  const variantType = chooseVariantType(analysis.stage);

  if (hasBookingContext(contextText)) {
    return {
      text:
        variantType === "SAFE"
          ? "כמו שדיברנו, המחיר משתנה לפי סוג השירות. רוצה שאדייק לך לפי מה שאתה צריך?"
          : "לפני שממשיכים, אעשה לך סדר ברור במחיר לפי מה שאתה צריך.",
      strategyType: "PRICE_CONTINUE",
      variantType,
      toneLabel: toneFromVariant(variantType),
    };
  }

  if (hasPriceContext(contextText)) {
    return {
      text:
        variantType === "SAFE"
          ? "כמו שדיברנו, המחיר משתנה לפי סוג השירות. רוצה שאדייק לך לפי מה שאתה צריך?"
          : "מעולה, בוא נדייק את המחיר לפי מה שאתה צריך כדי שתהיה תמונה ברורה.",
      strategyType: "PRICE_CONTINUE",
      variantType,
      toneLabel: toneFromVariant(variantType),
    };
  }

  return {
    text:
      variantType === "SOFT"
        ? "בשמחה 😊 המחיר משתנה לפי סוג השירות, רוצה שאדייק לך?"
        : "בשמחה, כדי לדייק לך מחיר צריך להבין בדיוק מה אתה צריך.",
    strategyType: "PRICE_QUALIFY",
    variantType,
    toneLabel: toneFromVariant(variantType),
  };
}

function buildAvailabilitySuggestion(
  analysis: AnalysisInput,
  contextText: string
): SuggestionDraft {
  const variantType = chooseVariantType(analysis.stage);

  if (hasAvailabilityContext(contextText) || hasBookingContext(contextText)) {
    return {
      text:
        variantType === "SAFE"
          ? "כמו שדיברנו, בוא נדייק את הזמינות. איזה יום הכי מתאים לך?"
          : "מעולה, כדי להתקדם צריך לדייק את הזמינות. איזה יום ושעה נוחים לך?",
      strategyType: "AVAILABILITY_CONTINUE",
      variantType,
      toneLabel: toneFromVariant(variantType),
    };
  }

  return {
    text:
      variantType === "SOFT"
        ? "אשמח לבדוק לך זמינות 😊 איזה יום מעניין אותך?"
        : "בשמחה, איזה יום ושעה רלוונטיים לך כדי שאכוון אותך נכון?",
    strategyType: "CHECK_AVAILABILITY",
    variantType,
    toneLabel: toneFromVariant(variantType),
  };
}

function buildBookingSuggestion(
  analysis: AnalysisInput,
  contextText: string
): SuggestionDraft {
  const variantType = chooseVariantType(analysis.stage);

  if (analysis.stage === "closing" && hasAvailabilityContext(contextText)) {
    return {
      text: "מעולה, אז נתקדם לפי הזמינות שכבר בדקנו. איזה שעה נוחה לך?",
      strategyType: "ADVANCE_BOOKING",
      variantType: "DIRECT",
      toneLabel: toneFromVariant("DIRECT"),
    };
  }

  if (analysis.stage === "closing" && hasPriceContext(contextText)) {
    return {
      text: "מעולה, בוא נתקדם לקביעת תור. איזה יום נוח לך?",
      strategyType: "ADVANCE_BOOKING",
      variantType: "DIRECT",
      toneLabel: toneFromVariant("DIRECT"),
    };
  }

  if (analysis.stage === "closing") {
    return {
      text: "מעולה, בוא נתקדם. איזה יום ושעה נוחים לך?",
      strategyType: "ADVANCE_BOOKING",
      variantType: "DIRECT",
      toneLabel: toneFromVariant("DIRECT"),
    };
  }

  if (hasAvailabilityContext(contextText)) {
    return {
      text:
        variantType === "SAFE"
          ? "מעולה, נמשיך מהזמינות שדיברנו עליה. איזה שעה נוחה לך?"
          : "מעולה, בוא נסגור את זה לפי הזמינות שדיברנו עליה. איזה שעה מתאימה לך?",
      strategyType: "BOOKING_CONTINUE",
      variantType,
      toneLabel: toneFromVariant(variantType),
    };
  }

  if (hasPriceContext(contextText)) {
    return {
      text:
        variantType === "SAFE"
          ? "מעולה, נמשיך מכאן לקביעת תור. איזה יום נוח לך?"
          : "מעולה, אחרי שסגרנו את הכיוון, בוא נתקדם לקביעה. איזה יום מתאים לך?",
      strategyType: "BOOKING_CONTINUE",
      variantType,
      toneLabel: toneFromVariant(variantType),
    };
  }

  if (hasBookingContext(contextText)) {
    return {
      text:
        variantType === "SAFE"
          ? "מעולה, נמשיך לקדם את הקביעה. איזה יום ושעה נוחים לך?"
          : "בוא נתקדם עם הקביעה. איזה יום ושעה מתאימים לך?",
      strategyType: "BOOKING_CONTINUE",
      variantType,
      toneLabel: toneFromVariant(variantType),
    };
  }

  return {
    text:
      variantType === "SOFT"
        ? "בשמחה 😊 איזה יום ושעה נוחים לך?"
        : "בשמחה, בוא נקדם את זה. איזה יום ושעה הכי מתאימים לך?",
    strategyType: "BOOKING_START",
    variantType,
    toneLabel: toneFromVariant(variantType),
  };
}

function buildFallbackSuggestion(analysis: AnalysisInput): SuggestionDraft {
  const variantType = chooseVariantType(analysis.stage);

  if (analysis.stage === "closing") {
    return {
      text: "מעולה, כדי להתקדם נכון אני צריך רק עוד חידוד קטן על מה שאתה מחפש.",
      strategyType: "CLARIFY_CONTINUE",
      variantType: "DIRECT",
      toneLabel: toneFromVariant("DIRECT"),
    };
  }

  if (analysis.stage === "middle") {
    return {
      text: "כדי להמשיך נכון, תוכל לכתוב לי קצת יותר מה אתה צריך בדיוק?",
      strategyType: "CLARIFY_CONTINUE",
      variantType: "SAFE",
      toneLabel: toneFromVariant("SAFE"),
    };
  }

  return {
    text: "בשמחה 😊 תוכל לכתוב לי קצת יותר מה אתה מחפש כדי שאכוון אותך נכון?",
    strategyType: "CLARIFY_NEED",
    variantType: "SOFT",
    toneLabel: toneFromVariant("SOFT"),
  };
}

function dedupeDrafts(drafts: SuggestionDraft[]) {
  const seen = new Set<string>();

  return drafts.filter((draft) => {
    const key = `${draft.strategyType}__${draft.text}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function buildPriceSuggestionDrafts(
  analysis: AnalysisInput,
  contextText: string
): SuggestionDraft[] {
  const primary = buildPriceSuggestion(analysis, contextText);

  const drafts: SuggestionDraft[] = [primary];

  if (primary.strategyType === "PRICE_CONTINUE") {
    drafts.push({
      text: "אם נוח לך, אני יכול לעשות לך סדר מהיר לפי מה שאתה צריך.",
      strategyType: "PRICE_CLARIFY",
      variantType: "SAFE",
      toneLabel: "professional",
    });

    drafts.push({
      text: "אפשר גם להתקדם צעד־צעד ולדייק את המחיר לפי השירות שמתאים לך.",
      strategyType: "PRICE_ADVANCE",
      variantType: "SOFT",
      toneLabel: "friendly",
    });
  } else {
    drafts.push({
      text: "אני יכול לתת לך כיוון מהיר למחיר, רק צריך להבין מה בדיוק רלוונטי לך.",
      strategyType: "PRICE_ANCHOR",
      variantType: "DIRECT",
      toneLabel: "professional",
    });

    drafts.push({
      text: "אם תרצה, נתקדם בכמה שאלות קצרות ואדייק לך את המחיר.",
      strategyType: "PRICE_ADVANCE",
      variantType: "SOFT",
      toneLabel: "friendly",
    });
  }

  return dedupeDrafts(drafts);
}

function buildAvailabilitySuggestionDrafts(
  analysis: AnalysisInput,
  contextText: string
): SuggestionDraft[] {
  const primary = buildAvailabilitySuggestion(analysis, contextText);

  const drafts: SuggestionDraft[] = [primary];

  if (primary.strategyType === "AVAILABILITY_CONTINUE") {
    drafts.push({
      text: "אם אתה רוצה, נוכל לצמצם את זה ליום שהכי נוח לך.",
      strategyType: "AVAILABILITY_NARROW",
      variantType: "SAFE",
      toneLabel: "professional",
    });

    drafts.push({
      text: "אפשר גם כבר להתקדם לפי היום שמתאים לך ולסגור את זה.",
      strategyType: "AVAILABILITY_ADVANCE",
      variantType: "SOFT",
      toneLabel: "friendly",
    });
  } else {
    drafts.push({
      text: "יש לי אפשרות לבדוק לך מהר לפי יום או שעה שמעניינים אותך.",
      strategyType: "AVAILABILITY_OFFER",
      variantType: "SAFE",
      toneLabel: "professional",
    });

    drafts.push({
      text: "אם יש לך כיוון ליום מסוים, אפשר כבר להתקדם ממנו הלאה.",
      strategyType: "AVAILABILITY_ADVANCE",
      variantType: "SOFT",
      toneLabel: "friendly",
    });
  }

  return dedupeDrafts(drafts);
}

function buildBookingSuggestionDrafts(
  analysis: AnalysisInput,
  contextText: string
): SuggestionDraft[] {
  const primary = buildBookingSuggestion(analysis, contextText);

  const drafts: SuggestionDraft[] = [primary];

  if (
    primary.strategyType === "ADVANCE_BOOKING" ||
    primary.strategyType === "BOOKING_CONTINUE"
  ) {
    drafts.push({
      text: "מעולה, בוא נסגור את זה מסודר. איזה יום הכי נוח לך?",
      strategyType: "BOOKING_CLOSE",
      variantType: "DIRECT",
      toneLabel: "professional",
    });

    drafts.push({
      text: "אפשר להתקדם בקצב שלך 😊 איזה יום מתאים לך יותר?",
      strategyType: "BOOKING_SOFT",
      variantType: "SOFT",
      toneLabel: "friendly",
    });
  } else {
    drafts.push({
      text: "אם נוח לך, נתחיל מיום שמתאים לך ומשם נתקדם.",
      strategyType: "BOOKING_GUIDE",
      variantType: "SAFE",
      toneLabel: "professional",
    });

    drafts.push({
      text: "אפשר גם להתחיל בקטן — איזה יום הכי נוח לך כרגע?",
      strategyType: "BOOKING_SOFT",
      variantType: "SOFT",
      toneLabel: "friendly",
    });
  }

  return dedupeDrafts(drafts);
}

function buildFallbackSuggestionDrafts(
  analysis: AnalysisInput
): SuggestionDraft[] {
  const primary = buildFallbackSuggestion(analysis);

  const drafts: SuggestionDraft[] = [
    primary,
    {
      text: "רק כדי לדייק אותך נכון, מה הכי חשוב לך כרגע?",
      strategyType: "CLARIFY_FOCUS",
      variantType: "SAFE",
      toneLabel: "professional",
    },
  ];

  if (analysis.stage !== "closing") {
    drafts.push({
      text: "אפשר לכתוב לי במשפט קצר מה אתה מחפש ואני אכוון אותך משם.",
      strategyType: "CLARIFY_SOFT",
      variantType: "SOFT",
      toneLabel: "friendly",
    });
  }

  return dedupeDrafts(drafts);
}

function buildSuggestionDrafts(
  analysis: AnalysisInput,
  contextText: string
): SuggestionDraft[] {
  if (analysis.intent === "price") {
    return buildPriceSuggestionDrafts(analysis, contextText);
  }

  if (analysis.intent === "availability") {
    return buildAvailabilitySuggestionDrafts(analysis, contextText);
  }

  if (analysis.intent === "booking") {
    return buildBookingSuggestionDrafts(analysis, contextText);
  }

  return buildFallbackSuggestionDrafts(analysis);
}

function getStrategyPriority(
  strategyType: string,
  analysis: AnalysisInput
): number {
  if (analysis.intent === "booking" && analysis.stage === "closing") {
    if (strategyType === "ADVANCE_BOOKING") return 1;
    if (strategyType === "BOOKING_CLOSE") return 2;
    if (strategyType === "BOOKING_SOFT") return 3;
    if (strategyType === "BOOKING_CONTINUE") return 4;
    if (strategyType === "BOOKING_GUIDE") return 5;
    if (strategyType === "BOOKING_START") return 6;
  }

  if (analysis.intent === "booking") {
    if (strategyType === "BOOKING_CONTINUE") return 1;
    if (strategyType === "ADVANCE_BOOKING") return 2;
    if (strategyType === "BOOKING_CLOSE") return 3;
    if (strategyType === "BOOKING_SOFT") return 4;
    if (strategyType === "BOOKING_GUIDE") return 5;
    if (strategyType === "BOOKING_START") return 6;
  }

  if (analysis.intent === "price") {
    if (strategyType === "PRICE_CONTINUE") return 1;
    if (strategyType === "PRICE_QUALIFY") return 2;
    if (strategyType === "PRICE_CLARIFY") return 3;
    if (strategyType === "PRICE_ANCHOR") return 4;
    if (strategyType === "PRICE_ADVANCE") return 5;
  }

  if (analysis.intent === "availability") {
    if (strategyType === "AVAILABILITY_CONTINUE") return 1;
    if (strategyType === "CHECK_AVAILABILITY") return 2;
    if (strategyType === "AVAILABILITY_NARROW") return 3;
    if (strategyType === "AVAILABILITY_OFFER") return 4;
    if (strategyType === "AVAILABILITY_ADVANCE") return 5;
  }

  if (strategyType === "CLARIFY_CONTINUE") return 1;
  if (strategyType === "CLARIFY_FOCUS") return 2;
  if (strategyType === "CLARIFY_NEED") return 3;
  if (strategyType === "CLARIFY_SOFT") return 4;

  return 999;
}

function rankSuggestionDrafts(
  drafts: SuggestionDraft[],
  analysis: AnalysisInput
): SuggestionDraft[] {
  return [...drafts].sort((a, b) => {
    const priorityA = getStrategyPriority(a.strategyType, analysis);
    const priorityB = getStrategyPriority(b.strategyType, analysis);

    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }

    return 0;
  });
}

export async function generateReplySuggestions(
  message: MessageInput,
  analysis: AnalysisInput,
  contextMessages: ContextMessage[]
) {
  const previousMessages = getPreviousMessages(message, contextMessages);
  const contextText = buildContextText(previousMessages);

  const drafts = buildSuggestionDrafts(analysis, contextText);
  const rankedDrafts = rankSuggestionDrafts(drafts, analysis);

  const created = [];

  for (let i = 0; i < rankedDrafts.length; i++) {
    const draft = rankedDrafts[i];

    const item = await prisma.replySuggestion.create({
      data: {
        businessId: message.businessId,
        conversationId: message.conversationId,
        messageId: message.id,
        suggestionType: "AUTO",
        strategyType: draft.strategyType,
        variantType: draft.variantType,
        variantIndex: i,
        text: draft.text,
        toneLabel: draft.toneLabel,
        strategyLabel: draft.strategyType,
        status: "GENERATED",
      },
    });

    created.push(item);
  }

  return created;
}