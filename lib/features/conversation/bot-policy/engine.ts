import {
  evaluateBoundaryHandoff,
  parseBotControlHandoffRules,
} from "@/lib/features/conversation/bot-control";
import type {
  BotPolicyAnalysisSnapshot,
  BotPolicyConversationSnapshot,
  BotPolicyEngineInput,
  BotPolicyEngineResult,
  BotPolicyMessageSnapshot,
  BotPolicySettingsSnapshot,
} from "./types";

function isCustomerInbound(message: BotPolicyMessageSnapshot): boolean {
  return (
    message.direction === "INBOUND" && message.senderType === "CUSTOMER"
  );
}

function isConversationActive(
  conversation: BotPolicyConversationSnapshot
): boolean {
  const s = conversation.status?.toUpperCase();
  if (s === "CLOSED" || s === "ARCHIVED") {
    return false;
  }
  return true;
}

function isSensitiveOrUnclearAnalysis(
  analysis: BotPolicyAnalysisSnapshot,
  message: BotPolicyMessageSnapshot
): boolean {
  const intent = (analysis.intent || "").toLowerCase().trim();
  const stage = (analysis.stage || "").toLowerCase().trim();
  const text = (message.contentText || "").trim();

  if (!text) {
    return true;
  }

  if (!intent) {
    return true;
  }

  if (!stage) {
    return true;
  }

  if (stage !== "early" && stage !== "middle" && stage !== "closing") {
    return true;
  }

  // Including intent "unclear" with valid stage + non-empty text (e.g. "שלום") — OK for Starter Bot.
  return false;
}

function suggestionsOnly(
  reason: string,
  modeLabel: string
): BotPolicyEngineResult {
  return {
    decision: "ALLOW_SUGGESTIONS_ONLY",
    reason,
    canAutoReply: false,
    requiresHandoff: false,
    mode: modeLabel,
    nextAction: "CONTINUE_STANDARD_SUGGESTIONS",
  };
}

function handoff(
  reason: string,
  modeLabel: string
): BotPolicyEngineResult {
  return {
    decision: "HANDOFF_REQUIRED",
    reason,
    canAutoReply: false,
    requiresHandoff: true,
    mode: modeLabel,
    nextAction: "REQUIRE_BUSINESS_ATTENTION",
  };
}

function eligible(modeLabel: string): BotPolicyEngineResult {
  return {
    decision: "STARTER_BOT_ELIGIBLE",
    reason: "STARTER_BOT_GATES_PASSED",
    canAutoReply: true,
    requiresHandoff: false,
    mode: modeLabel,
    nextAction: "STARTER_AUTOREPLY_ALLOWED",
  };
}

function effectiveMode(settings: BotPolicySettingsSnapshot): string {
  if (!settings) return "NONE";
  return settings.mode || "UNKNOWN";
}

/**
 * Pure Starter Bot policy — no side effects.
 * Order: settings → channel/mode → message role → conversation → analysis sensitivity.
 */
export function runBotPolicyEngine(
  input: BotPolicyEngineInput
): BotPolicyEngineResult {
  const { message, analysis, conversation, settings } = input;
  const modeLabel = effectiveMode(settings);

  if (input.humanTakeover) {
    return handoff("HUMAN_TAKEOVER_ACTIVE", modeLabel);
  }

  if (!settings) {
    return suggestionsOnly("NO_BOT_SETTINGS", "NONE");
  }

  const controlRules = parseBotControlHandoffRules(input.handoffRules);

  if (!settings.enabled) {
    return suggestionsOnly("BOT_DISABLED", modeLabel);
  }

  if (controlRules.workMode === "MANUAL") {
    return suggestionsOnly("WORK_MODE_MANUAL", modeLabel);
  }

  if (settings.mode !== "STARTER") {
    return handoff(
      "UNSUPPORTED_BOT_MODE_ONLY_STARTER_SUPPORTED",
      modeLabel
    );
  }

  if (settings.channel !== "WHATSAPP") {
    return suggestionsOnly("UNSUPPORTED_CHANNEL", modeLabel);
  }

  if (!isCustomerInbound(message)) {
    return suggestionsOnly("NON_CUSTOMER_INBOUND_MESSAGE", modeLabel);
  }

  if (!isConversationActive(conversation)) {
    return suggestionsOnly("CONVERSATION_NOT_ACTIVE", modeLabel);
  }

  const policySensitive = isSensitiveOrUnclearAnalysis(analysis, message);
  const boundaries = controlRules.boundaries ?? {
    priceQuestions: true,
    customerRequestsAgent: true,
    unclearMessage: true,
    angryCustomer: true,
    afterMessageCount: true,
    afterMessageCountThreshold: 8,
    lowConfidence: true,
  };

  const boundaryHit = evaluateBoundaryHandoff({
    boundaries,
    intent: analysis.intent,
    stage: analysis.stage,
    messageText: message.contentText ?? "",
    inboundMessageCount: input.inboundMessageCount ?? 0,
    policySensitive,
  });

  if (boundaryHit.shouldHandoff && boundaryHit.reason) {
    return handoff(boundaryHit.reason, modeLabel);
  }

  if (policySensitive && boundaries.unclearMessage) {
    return handoff("UNCLEAR_OR_SENSITIVE_CONTEXT", modeLabel);
  }

  return eligible(modeLabel);
}

export { isSensitiveOrUnclearAnalysis };
