import { prisma } from "@/lib/prisma";

/**
 * Reply Suggestions Rewrite v1 — template-only (no LLM / embeddings).
 *
 * Future tone learning (lightweight, no heavy ML):
 * - Median length of messages the owner actually sends
 * - Emoji rate in sent vs dismissed suggestions
 * - Phrases the owner deletes before send (suggestion text → sent text diff)
 * - DIRECT vs WARM vs CLOSE selection counts per intent
 * - Whether the owner uses the customer name
 * Store later as optional JSON on business settings; adjust templates, not a new agent.
 */

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

/** קצר וישיר | חם ואישי | מקדם סגירה */
type IntentStyle = "DIRECT" | "WARM" | "CLOSE";

type SuggestionDraft = {
  text: string;
  strategyType: string;
  variantType: IntentStyle;
  toneLabel: string;
};

const MAX_SUGGESTION_CHARS = 80;

const CORPORATE_PATTERNS = [
  "תודה שפנית",
  "תודה על פנייתך",
  "בשמחה",
  "כדי שאוכל לעזור",
  "כדי להמשיך נכון",
  "אכוון אותך",
  "אשמח לעזור",
  "מעולה,",
  "מעולה ",
  "כמו שדיברנו",
];

function normalizeText(text: string) {
  return text.toLowerCase().trim();
}

function includesAny(text: string, keywords: string[]) {
  const n = normalizeText(text);
  return keywords.some((keyword) => n.includes(keyword));
}

function clampReply(text: string, max = MAX_SUGGESTION_CHARS): string {
  let t = text.replace(/\s+/g, " ").trim();
  for (const banned of CORPORATE_PATTERNS) {
    t = t.replace(new RegExp(banned, "gi"), "").replace(/\s+/g, " ").trim();
  }
  t = t.replace(/^[,.\s]+|[,.\s]+$/g, "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace >= 18) return cut.slice(0, lastSpace).trim();
  return cut.trim();
}

function toneFromStyle(style: IntentStyle): string {
  if (style === "DIRECT") return "direct";
  if (style === "WARM") return "warm";
  return "close";
}

function draft(
  text: string,
  strategyType: string,
  style: IntentStyle
): SuggestionDraft {
  return {
    text: clampReply(text),
    strategyType,
    variantType: style,
    toneLabel: toneFromStyle(style),
  };
}

function getPreviousMessages(
  message: MessageInput,
  contextMessages: ContextMessage[]
) {
  return contextMessages.filter((m) => m.id !== message.id);
}

function getTriggerText(
  message: MessageInput,
  contextMessages: ContextMessage[]
): string {
  const row =
    contextMessages.find((m) => m.id === message.id) ?? null;
  return (row?.contentText ?? "").trim();
}

function buildContextText(previousMessages: ContextMessage[]) {
  return previousMessages
    .map((m) => normalizeText(m.contentText || ""))
    .filter(Boolean)
    .join(" ");
}

function hasPriceContext(contextText: string, trigger: string) {
  return includesAny(`${contextText} ${trigger}`, [
    "כמה",
    "מחיר",
    "עולה",
    "עלות",
    "₪",
    "שקל",
  ]);
}

function hasAvailabilityContext(contextText: string, trigger: string) {
  return includesAny(`${contextText} ${trigger}`, [
    "מקום",
    "זמינות",
    "פנוי",
    "פנויה",
    "מתי",
    "פנים",
    "יש מקום",
  ]);
}

function hasBookingContext(contextText: string, trigger: string) {
  return includesAny(`${contextText} ${trigger}`, [
    "לקבוע",
    "תור",
    "להזמין",
    "להגיע",
    "נקבע",
    "מתאים לי",
    "יאללה",
    "סגור",
    "לשריין",
  ]);
}

function extractDayHint(text: string): string | null {
  const n = normalizeText(text);
  if (n.includes("מחר")) return "מחר";
  if (n.includes("היום")) return "היום";
  if (n.includes("ראשון")) return "יום ראשון";
  if (n.includes("שני")) return "יום שני";
  if (n.includes("שלישי")) return "יום שלישי";
  if (n.includes("רביעי")) return "יום רביעי";
  if (n.includes("חמישי")) return "יום חמישי";
  if (n.includes("שישי")) return "יום שישי";
  return null;
}

function extractTimeHint(text: string): string | null {
  const n = normalizeText(text);
  const hourMatch = n.match(/\b([01]?\d|2[0-3])(?::[0-5]\d)?\b/);
  if (hourMatch) return hourMatch[0];
  if (n.includes("בוקר")) return "בוקר";
  if (n.includes("צהריים") || n.includes("צהר")) return "צהריים";
  if (n.includes("ערב")) return "ערב";
  return null;
}

function rankStylesForStage(stage: string): IntentStyle[] {
  if (stage === "closing") return ["CLOSE", "DIRECT", "WARM"];
  if (stage === "middle") return ["WARM", "DIRECT", "CLOSE"];
  return ["DIRECT", "WARM", "CLOSE"];
}

function orderDraftsByStage(
  drafts: SuggestionDraft[],
  stage: string
): SuggestionDraft[] {
  const order = rankStylesForStage(stage);
  return [...drafts].sort(
    (a, b) => order.indexOf(a.variantType) - order.indexOf(b.variantType)
  );
}

function buildPriceDrafts(
  analysis: AnalysisInput,
  contextText: string,
  trigger: string
): SuggestionDraft[] {
  const combined = `${contextText} ${normalizeText(trigger)}`;
  const continuing = hasPriceContext(contextText, trigger);
  const booking = hasBookingContext(contextText, trigger);

  if (booking && continuing) {
    return [
      draft("המחיר לפי מה שבחרת — לדייק לפני קביעה?", "PRICE_BOOKING", "DIRECT"),
      draft("יש כמה אפשרויות במחיר — מה הכי מתאים?", "PRICE_BOOKING", "WARM"),
      draft("רוצה הצעה מדויקת ואז נקבע תור?", "PRICE_BOOKING", "CLOSE"),
    ];
  }

  if (continuing) {
    return [
      draft("המחיר תלוי בסוג — מה בדיוק אתה צריך?", "PRICE_CONTINUE", "DIRECT"),
      draft("יש כמה דירוגים — מה הכי קרוב לך?", "PRICE_CONTINUE", "WARM"),
      draft("רוצה שאשלח טווח מחיר עכשיו?", "PRICE_CONTINUE", "CLOSE"),
    ];
  }

  if (includesAny(combined, ["דגם", "סוג", "גודל", "מידה"])) {
    return [
      draft("איזה סוג בדיוק? אגיד מחיר.", "PRICE_QUALIFY", "DIRECT"),
      draft("יש כמה וריאציות — מה מחפש?", "PRICE_QUALIFY", "WARM"),
      draft("רוצה מחיר מדויק? כתוב מה צריך.", "PRICE_QUALIFY", "CLOSE"),
    ];
  }

  return [
    draft("מה השירות? אגיד מחיר.", "PRICE_QUALIFY", "DIRECT"),
    draft("יש כמה אפשרויות — מה הכי מתאים?", "PRICE_QUALIFY", "WARM"),
    draft("רוצה הצעת מחיר עכשיו?", "PRICE_QUALIFY", "CLOSE"),
  ];
}

function buildAvailabilityDrafts(
  analysis: AnalysisInput,
  contextText: string,
  trigger: string
): SuggestionDraft[] {
  const day =
    extractDayHint(trigger) ||
    extractDayHint(contextText) ||
    (includesAny(trigger, ["מחר"]) ? "מחר" : null);
  const time = extractTimeHint(trigger);
  const askingSlot = hasAvailabilityContext(contextText, trigger);

  if (day === "מחר" && askingSlot) {
    return [
      draft("כן, מחר — ב-17 או ב-19?", "AVAILABILITY_DAY", "DIRECT"),
      draft("יש כמה חלונות מחר — מה נוח?", "AVAILABILITY_DAY", "WARM"),
      draft("לשריין לך מקום למחר?", "AVAILABILITY_DAY", "CLOSE"),
    ];
  }

  if (day && time) {
    return [
      draft(`ב${day} ב${time} — לבדוק ולחזור?`, "AVAILABILITY_SLOT", "DIRECT"),
      draft(`ל${day} ב${time} יש אפשרות — מאשר?`, "AVAILABILITY_SLOT", "WARM"),
      draft(`לקבוע ${day} ${time}?`, "AVAILABILITY_SLOT", "CLOSE"),
    ];
  }

  if (day) {
    return [
      draft(`${day} — איזו שעה נוחה?`, "AVAILABILITY_DAY", "DIRECT"),
      draft(`ל${day} יש כמה זמנים — מה מתאים?`, "AVAILABILITY_DAY", "WARM"),
      draft(`לשריין ל${day}?`, "AVAILABILITY_DAY", "CLOSE"),
    ];
  }

  if (askingSlot || hasBookingContext(contextText, trigger)) {
    return [
      draft("איזה יום מעניין?", "CHECK_AVAILABILITY", "DIRECT"),
      draft("יש כמה ימים פנויים — מה נוח?", "CHECK_AVAILABILITY", "WARM"),
      draft("רוצה שאבדוק ואשריין?", "CHECK_AVAILABILITY", "CLOSE"),
    ];
  }

  return [
    draft("לאיזה יום?", "CHECK_AVAILABILITY", "DIRECT"),
    draft("תכתוב יום — אבדוק", "CHECK_AVAILABILITY", "WARM"),
    draft("אחזור עם שעות?", "CHECK_AVAILABILITY", "CLOSE"),
  ];
}

function buildBookingDrafts(
  analysis: AnalysisInput,
  contextText: string,
  trigger: string
): SuggestionDraft[] {
  const day = extractDayHint(trigger) || extractDayHint(contextText);
  const time = extractTimeHint(trigger);
  const hasAvail = hasAvailabilityContext(contextText, trigger);
  const hasPrice = hasPriceContext(contextText, trigger);

  if (analysis.stage === "closing" && day && time) {
    return [
      draft(`${day} ${time} — מאשר?`, "BOOKING_CONFIRM", "DIRECT"),
      draft(`${day} ב${time} מתאים — לסגור?`, "BOOKING_CONFIRM", "WARM"),
      draft(`לשריין ${day} ${time}?`, "BOOKING_CONFIRM", "CLOSE"),
    ];
  }

  if (analysis.stage === "closing" && day) {
    return [
      draft(`${day} — איזו שעה?`, "BOOKING_CLOSE", "DIRECT"),
      draft(`ל${day} יש כמה שעות — מה נוח?`, "BOOKING_CLOSE", "WARM"),
      draft(`לקבוע ל${day}?`, "BOOKING_CLOSE", "CLOSE"),
    ];
  }

  if (analysis.stage === "closing") {
    return [
      draft("איזה יום ושעה?", "BOOKING_CLOSE", "DIRECT"),
      draft("יש כמה זמנים — מה הכי נוח?", "BOOKING_CLOSE", "WARM"),
      draft("לקבוע עכשיו?", "BOOKING_CLOSE", "CLOSE"),
    ];
  }

  if (hasAvail && day) {
    return [
      draft(`${day} — איזו שעה לקביעה?`, "BOOKING_CONTINUE", "DIRECT"),
      draft(`ל${day} מה הכי נוח לך?`, "BOOKING_CONTINUE", "WARM"),
      draft(`לסגור תור ל${day}?`, "BOOKING_CONTINUE", "CLOSE"),
    ];
  }

  if (hasPrice) {
    return [
      draft("קודם מחיר ואז תור — מה אתה צריך?", "BOOKING_PRICE", "DIRECT"),
      draft("אחרי מחיר נקבע זמן — מה מתאים?", "BOOKING_PRICE", "WARM"),
      draft("רוצה הצעה ואז קביעה?", "BOOKING_PRICE", "CLOSE"),
    ];
  }

  if (hasBookingContext(contextText, trigger)) {
    return [
      draft("איזה יום ושעה?", "BOOKING_CONTINUE", "DIRECT"),
      draft("מה הכי נוח — יום ושעה?", "BOOKING_CONTINUE", "WARM"),
      draft("לקבוע תור עכשיו?", "BOOKING_CONTINUE", "CLOSE"),
    ];
  }

  return [
    draft("מתי נוח לך?", "BOOKING_START", "DIRECT"),
    draft("יש כמה זמנים — מה מתאים?", "BOOKING_START", "WARM"),
    draft("רוצה לקבוע תור?", "BOOKING_START", "CLOSE"),
  ];
}

function buildFallbackDrafts(
  analysis: AnalysisInput,
  trigger: string
): SuggestionDraft[] {
  const n = normalizeText(trigger);

  if (!n || n.length < 3) {
    return [
      draft("מה אתה צריך?", "CLARIFY_EMPTY", "DIRECT"),
      draft("תכתוב במשפט אחד", "CLARIFY_EMPTY", "WARM"),
      draft("נקבע שיחה?", "CLARIFY_EMPTY", "CLOSE"),
    ];
  }

  if (analysis.stage === "closing") {
    return [
      draft("מה הכי חשוב לך?", "CLARIFY_CLOSE", "DIRECT"),
      draft("מה דחוף לסגור?", "CLARIFY_CLOSE", "WARM"),
      draft("להתקשר?", "CLARIFY_CLOSE", "CLOSE"),
    ];
  }

  if (includesAny(n, ["?", "איך", "מה", "למה", "האם"])) {
    return [
      draft("מה בדיוק אתה מחפש?", "CLARIFY_TOPIC", "DIRECT"),
      draft("יש כמה אפשרויות — מה מתאים?", "CLARIFY_TOPIC", "WARM"),
      draft("לסגור את זה עכשיו?", "CLARIFY_TOPIC", "CLOSE"),
    ];
  }

  return [
    draft("מה בדיוק אתה צריך?", "CLARIFY_NEED", "DIRECT"),
    draft("תכתוב במשפט אחד", "CLARIFY_NEED", "WARM"),
    draft("להתקשר?", "CLARIFY_NEED", "CLOSE"),
  ];
}

function dedupeDrafts(drafts: SuggestionDraft[]) {
  const seen = new Set<string>();
  return drafts.filter((d) => {
    const key = d.text;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildSuggestionDrafts(
  analysis: AnalysisInput,
  contextText: string,
  trigger: string
): SuggestionDraft[] {
  let drafts: SuggestionDraft[];

  if (analysis.intent === "price") {
    drafts = buildPriceDrafts(analysis, contextText, trigger);
  } else if (analysis.intent === "availability") {
    drafts = buildAvailabilityDrafts(analysis, contextText, trigger);
  } else if (analysis.intent === "booking") {
    drafts = buildBookingDrafts(analysis, contextText, trigger);
  } else {
    drafts = buildFallbackDrafts(analysis, trigger);
  }

  return dedupeDrafts(orderDraftsByStage(drafts, analysis.stage)).slice(0, 3);
}

function getStrategyPriority(
  strategyType: string,
  analysis: AnalysisInput
): number {
  const bookingOrder = [
    "BOOKING_CONFIRM",
    "BOOKING_CLOSE",
    "BOOKING_CONTINUE",
    "BOOKING_PRICE",
    "BOOKING_START",
  ];
  const priceOrder = ["PRICE_BOOKING", "PRICE_CONTINUE", "PRICE_QUALIFY"];
  const availOrder = [
    "AVAILABILITY_SLOT",
    "AVAILABILITY_DAY",
    "CHECK_AVAILABILITY",
  ];
  const clarifyOrder = [
    "CLARIFY_TOPIC",
    "CLARIFY_CLOSE",
    "CLARIFY_NEED",
    "CLARIFY_EMPTY",
  ];

  const lists: Record<string, string[]> = {
    booking: bookingOrder,
    price: priceOrder,
    availability: availOrder,
  };

  const list = lists[analysis.intent] ?? clarifyOrder;
  const idx = list.indexOf(strategyType);
  return idx === -1 ? 50 : idx;
}

function rankSuggestionDrafts(
  drafts: SuggestionDraft[],
  analysis: AnalysisInput
): SuggestionDraft[] {
  const styleOrder = rankStylesForStage(analysis.stage);
  return [...drafts].sort((a, b) => {
    const styleDiff =
      styleOrder.indexOf(a.variantType) - styleOrder.indexOf(b.variantType);
    if (styleDiff !== 0) return styleDiff;
    return (
      getStrategyPriority(a.strategyType, analysis) -
      getStrategyPriority(b.strategyType, analysis)
    );
  });
}

export async function generateReplySuggestions(
  message: MessageInput,
  analysis: AnalysisInput,
  contextMessages: ContextMessage[]
) {
  const previousMessages = getPreviousMessages(message, contextMessages);
  const contextText = buildContextText(previousMessages);
  const trigger = getTriggerText(message, contextMessages);

  const drafts = buildSuggestionDrafts(analysis, contextText, trigger);
  const rankedDrafts = rankSuggestionDrafts(drafts, analysis);

  const created = [];

  for (let i = 0; i < rankedDrafts.length; i++) {
    const draftRow = rankedDrafts[i];

    const item = await prisma.replySuggestion.create({
      data: {
        businessId: message.businessId,
        conversationId: message.conversationId,
        messageId: message.id,
        suggestionType: "AUTO",
        strategyType: draftRow.strategyType,
        variantType: draftRow.variantType,
        variantIndex: i,
        text: draftRow.text,
        toneLabel: draftRow.toneLabel,
        strategyLabel: draftRow.strategyType,
        status: "GENERATED",
      },
    });

    created.push(item);
  }

  return created;
}
