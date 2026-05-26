/**
 * Bot Control Layer v1 — work modes, boundaries, human takeover.
 * Stored in `BusinessBotSettings.handoffRules` JSON (no schema migration).
 */

export type BotWorkMode = "MANUAL" | "SMART_DRAFTS" | "AUTO_OPENING_FUTURE";

export type BotBoundaryPresets = {
  priceQuestions: boolean;
  customerRequestsAgent: boolean;
  unclearMessage: boolean;
  angryCustomer: boolean;
  afterMessageCount: boolean;
  afterMessageCountThreshold: number;
  lowConfidence: boolean;
};

export type BotControlHandoffRules = {
  version?: number;
  workMode?: BotWorkMode;
  boundaries?: BotBoundaryPresets;
};

export const BOT_CONTROL_RULES_VERSION = 1;

export const HUMAN_TAKEOVER_OUTCOME_REASON = "BOT_CONTROL_HUMAN_TAKEOVER";

export const DEFAULT_BOT_BOUNDARIES: BotBoundaryPresets = {
  priceQuestions: true,
  customerRequestsAgent: true,
  unclearMessage: true,
  angryCustomer: true,
  afterMessageCount: true,
  afterMessageCountThreshold: 8,
  lowConfidence: true,
};

const ANGRY_KEYWORDS = [
  "כועס",
  "מעצבן",
  "נמאס",
  "חרא",
  "לעזאזל",
  "תבע",
  "רמאי",
  "גנוב",
  "זבל",
];

const AGENT_REQUEST_KEYWORDS = [
  "נציג",
  "בנאדם",
  "אדם",
  "בעלים",
  "מישהו אמיתי",
  "לדבר עם",
  "תחזרו אלי",
  "תתקשרו",
];

export function defaultBotControlHandoffRules(): BotControlHandoffRules {
  return {
    version: BOT_CONTROL_RULES_VERSION,
    workMode: "SMART_DRAFTS",
    boundaries: { ...DEFAULT_BOT_BOUNDARIES },
  };
}

export function parseBotControlHandoffRules(raw: unknown): BotControlHandoffRules {
  if (!raw || typeof raw !== "object") {
    return defaultBotControlHandoffRules();
  }
  const o = raw as Record<string, unknown>;
  const boundariesRaw = o.boundaries;
  let boundaries: BotBoundaryPresets = { ...DEFAULT_BOT_BOUNDARIES };
  if (boundariesRaw && typeof boundariesRaw === "object") {
    const b = boundariesRaw as Record<string, unknown>;
    boundaries = {
      priceQuestions:
        typeof b.priceQuestions === "boolean"
          ? b.priceQuestions
          : DEFAULT_BOT_BOUNDARIES.priceQuestions,
      customerRequestsAgent:
        typeof b.customerRequestsAgent === "boolean"
          ? b.customerRequestsAgent
          : DEFAULT_BOT_BOUNDARIES.customerRequestsAgent,
      unclearMessage:
        typeof b.unclearMessage === "boolean"
          ? b.unclearMessage
          : DEFAULT_BOT_BOUNDARIES.unclearMessage,
      angryCustomer:
        typeof b.angryCustomer === "boolean"
          ? b.angryCustomer
          : DEFAULT_BOT_BOUNDARIES.angryCustomer,
      afterMessageCount:
        typeof b.afterMessageCount === "boolean"
          ? b.afterMessageCount
          : DEFAULT_BOT_BOUNDARIES.afterMessageCount,
      afterMessageCountThreshold:
        typeof b.afterMessageCountThreshold === "number" &&
        b.afterMessageCountThreshold >= 3 &&
        b.afterMessageCountThreshold <= 30
          ? Math.floor(b.afterMessageCountThreshold)
          : DEFAULT_BOT_BOUNDARIES.afterMessageCountThreshold,
      lowConfidence:
        typeof b.lowConfidence === "boolean"
          ? b.lowConfidence
          : DEFAULT_BOT_BOUNDARIES.lowConfidence,
    };
  }

  const workMode =
    o.workMode === "MANUAL" ||
    o.workMode === "SMART_DRAFTS" ||
    o.workMode === "AUTO_OPENING_FUTURE"
      ? o.workMode
      : undefined;

  return {
    version:
      typeof o.version === "number" ? o.version : BOT_CONTROL_RULES_VERSION,
    workMode,
    boundaries,
  };
}

export function resolveBotWorkMode(params: {
  enabled: boolean;
  showDraftSuggestionsInInbox: boolean;
  handoffRules: unknown;
}): BotWorkMode {
  const rules = parseBotControlHandoffRules(params.handoffRules);
  if (rules.workMode) return rules.workMode;
  if (!params.enabled) return "MANUAL";
  if (params.showDraftSuggestionsInInbox) return "SMART_DRAFTS";
  return "MANUAL";
}

/** Map UI work mode to persisted flags + handoffRules.workMode. */
export function settingsPatchForWorkMode(
  mode: BotWorkMode,
  existingHandoffRules: unknown
): {
  enabled: boolean;
  showDraftSuggestionsInInbox: boolean;
  handoffRules: BotControlHandoffRules;
} {
  const rules = parseBotControlHandoffRules(existingHandoffRules);
  rules.workMode = mode;

  if (mode === "MANUAL") {
    return {
      enabled: false,
      showDraftSuggestionsInInbox: false,
      handoffRules: rules,
    };
  }

  if (mode === "SMART_DRAFTS") {
    return {
      enabled: true,
      showDraftSuggestionsInInbox: true,
      handoffRules: rules,
    };
  }

  // AUTO_OPENING_FUTURE — prepare only, same runtime as smart drafts today
  return {
    enabled: true,
    showDraftSuggestionsInInbox: true,
    handoffRules: rules,
  };
}

export function isHumanTakeoverConversation(
  outcomeReason: string | null | undefined
): boolean {
  return outcomeReason === HUMAN_TAKEOVER_OUTCOME_REASON;
}

export function shouldOfferStarterBotDrafts(params: {
  workMode: BotWorkMode;
  humanTakeover: boolean;
  enabled: boolean;
  showDraftSuggestionsInInbox: boolean;
}): boolean {
  if (params.humanTakeover) return false;
  if (params.workMode === "MANUAL") return false;
  if (params.workMode === "AUTO_OPENING_FUTURE") {
    // v1: still draft-only until auto-send executor exists
    return params.enabled && params.showDraftSuggestionsInInbox;
  }
  return params.enabled && params.showDraftSuggestionsInInbox;
}

/** AUTO reply suggestions follow the same work-mode gate as starter drafts. */
export function shouldOfferAutoReplySuggestions(params: {
  workMode: BotWorkMode;
  humanTakeover: boolean;
}): boolean {
  if (params.humanTakeover) return false;
  return params.workMode !== "MANUAL";
}

function normalizeForMatch(text: string): string {
  return text.toLowerCase().trim();
}

function includesAnyKeyword(text: string, keywords: readonly string[]): boolean {
  const n = normalizeForMatch(text);
  return keywords.some((k) => n.includes(k));
}

export type BoundaryHandoffEvaluation = {
  shouldHandoff: boolean;
  reason: string | null;
};

/**
 * Evaluate owner-defined boundary presets (v1 — used for policy + draft gating).
 */
export function evaluateBoundaryHandoff(params: {
  boundaries: BotBoundaryPresets;
  intent: string;
  stage: string;
  messageText: string;
  inboundMessageCount: number;
  policySensitive: boolean;
}): BoundaryHandoffEvaluation {
  const { boundaries, intent, messageText, inboundMessageCount, policySensitive } =
    params;
  const text = normalizeForMatch(messageText);

  if (boundaries.customerRequestsAgent && includesAnyKeyword(text, AGENT_REQUEST_KEYWORDS)) {
    return { shouldHandoff: true, reason: "boundary.customer_requests_agent" };
  }

  if (boundaries.angryCustomer && includesAnyKeyword(text, ANGRY_KEYWORDS)) {
    return { shouldHandoff: true, reason: "boundary.angry_customer" };
  }

  if (boundaries.priceQuestions && intent === "price") {
    return { shouldHandoff: true, reason: "boundary.price_questions" };
  }

  if (boundaries.unclearMessage && policySensitive) {
    return { shouldHandoff: true, reason: "boundary.unclear_message" };
  }

  if (boundaries.lowConfidence && intent === "unclear") {
    return { shouldHandoff: true, reason: "boundary.low_confidence" };
  }

  if (
    boundaries.afterMessageCount &&
    inboundMessageCount >= boundaries.afterMessageCountThreshold
  ) {
    return { shouldHandoff: true, reason: "boundary.after_message_count" };
  }

  return { shouldHandoff: false, reason: null };
}

export const BOT_WORK_MODE_OPTIONS: ReadonlyArray<{
  id: BotWorkMode;
  title: string;
  description: string;
  trustLine: string;
}> = [
  {
    id: "MANUAL",
    title: "ידני — אני עונה בעצמי",
    description:
      "האינבוקס מסדר שיחות. אין טיוטות בוט — רק אתה שולח ללקוח.",
    trustLine: "שליטה מלאה בידיים שלך",
  },
  {
    id: "SMART_DRAFTS",
    title: "טיוטות חכמות — ברירת מחדל",
    description:
      "הבוט מכין טקסטים באינבוקס. אתה בודק ולוחץ שלח — הלקוח לא מקבל כלום לבד.",
    trustLine: "אתה תמיד מאשר לפני שליחה",
  },
];

/** Modes shown in settings UI — excludes future-only work modes. */
export const BOT_WORK_MODE_OPTIONS_ACTIVE = BOT_WORK_MODE_OPTIONS.filter(
  (o) => o.id !== "AUTO_OPENING_FUTURE"
);

export const BOT_BOUNDARY_OPTIONS: ReadonlyArray<{
  key: keyof BotBoundaryPresets;
  label: string;
  hint: string;
  isThreshold?: boolean;
}> = [
  {
    key: "priceQuestions",
    label: "שאלות על מחיר",
    hint: "כשהלקוח שואל על מחיר או עלות",
  },
  {
    key: "customerRequestsAgent",
    label: "לקוח מבקש נציג",
    hint: "כשמבקשים לדבר עם אדם או בעל העסק",
  },
  {
    key: "unclearMessage",
    label: "הודעה לא ברורה",
    hint: "כשהמערכת לא בטוחה מה הלקוח רוצה",
  },
  {
    key: "angryCustomer",
    label: "לקוח כועס",
    hint: "מילים שמראות תסכול או כעס",
  },
  {
    key: "afterMessageCount",
    label: "אחרי כמה הודעות מהלקוח",
    hint: "כדי לא להמשיך לולאה ארוכה בלי אתה",
    isThreshold: true,
  },
  {
    key: "lowConfidence",
    label: "כשאין תשובה בטוחה",
    hint: "כשהכוונה לא ברורה למערכת",
  },
];
