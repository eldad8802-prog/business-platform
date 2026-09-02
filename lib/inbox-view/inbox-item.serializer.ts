import type {
  Conversation,
  ConversationStage,
  Customer,
  Lead,
  Message,
  ReplySuggestion,
} from "@prisma/client";
import type {
  InboxBotFlowStatus,
  InboxConversationHealth,
  InboxItemViewModel,
  PrimarySignalKind,
  SignalSeverity,
} from "./inbox-item.types";
import { bucketTemperature } from "./temperature-bucket";
import { evaluatePrimarySignal } from "./primary-signal";
import { evaluateSuggestedAction } from "./suggested-action";
import { evaluateNextBestAction } from "./next-best-action";
import { deriveConversationOutcome } from "./conversation-outcome";
import { deriveBusinessSituation } from "./business-situation";
import { suggestBusinessActionsFromInboxSignals } from "./suggested-business-actions";
import { isHumanTakeoverConversation } from "@/lib/features/conversation/bot-control";

/**
 * Pure serializer: a Conversation row with its includes → Inbox view-model.
 *
 * No I/O, no Prisma calls. Caller is responsible for fetching the conversation
 * with the required relations (`messages: take 1 desc` with `direction` + optional
 * `analysis.intent`, `replySuggestions: take 1 with open status` including
 * `suggestionType`, `customer`, `lead`). Optional `starterBot` flags come from a
 * single batch query in the API route (terminal bot drafts only).
 *
 * The serializer is total — it produces a viewmodel for any conversation,
 * including those that have not yet been touched by the State Writer
 * (all analytics fields null). In that case, the viewmodel degrades to the
 * weakest signal (fresh_lead/neutral) rather than fabricating heat/risk.
 */

const SNIPPET_MAX_LENGTH = 80;

const SEVERITY_BASE: Record<SignalSeverity, number> = {
  critical: 80,
  high: 60,
  medium: 40,
  low: 20,
  info: 0,
};

const STAGE_LABEL_HE: Record<ConversationStage, string> = {
  NEW: "חדשה",
  QUALIFIED: "מתעניין",
  QUOTED: "הצעת מחיר",
  NEGOTIATION: "משא ומתן",
  WON: "נסגרה בהצלחה",
  LOST: "אבדה",
  INACTIVE: "לא פעילה",
};

function stageLabelFromEnum(stage: ConversationStage | null): string {
  if (!stage) return STAGE_LABEL_HE.NEW;
  return STAGE_LABEL_HE[stage] ?? "חדשה";
}

function truncate(text: string | null, max: number): string {
  if (!text) return "";
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function computePriorityScore(input: {
  severity: SignalSeverity;
  waitingMinutes: number | null;
  closeProbability: number | null;
}): number {
  let score = SEVERITY_BASE[input.severity] ?? 0;

  if (input.waitingMinutes !== null && input.waitingMinutes > 0) {
    // Up to +15 points for waiting hours; saturates at 15h
    score += Math.min(15, input.waitingMinutes / 60);
  }

  if (input.closeProbability !== null && input.closeProbability > 0) {
    // Up to +5 points based on close probability — pulls hotter conversations
    // up the list when severity ties.
    score += input.closeProbability * 5;
  }

  return Math.min(100, Math.max(0, Math.round(score)));
}

function deriveBotFlowStatus(input: {
  pendingSuggestionType: string | undefined;
  hasTerminalHandoff: boolean;
  hasTerminalCompleted: boolean;
  hasHumanTakeover?: boolean;
}): InboxBotFlowStatus {
  if (input.hasHumanTakeover) return "HANDOFF";
  if (input.hasTerminalHandoff) return "HANDOFF";
  if (input.hasTerminalCompleted) return "COMPLETED";
  if (input.pendingSuggestionType === "STARTER_BOT_DRAFT") return "IN_PROGRESS";
  return "NONE";
}

function deriveBotProgressLabel(
  status: InboxBotFlowStatus,
  hasHumanTakeover?: boolean
): string | undefined {
  if (hasHumanTakeover) return "אתה מטפל";
  if (status === "IN_PROGRESS") return "טיוטה מוכנה לשליחה";
  if (status === "COMPLETED") return "סיום פתיחה — מחכה לך";
  if (status === "HANDOFF") return "מחכה לך";
  return undefined;
}

function deriveNeedsHumanAttention(input: {
  signalSeverity: SignalSeverity;
  primarySignal: PrimarySignalKind;
  waitingMinutes: number | null;
  hasPendingSuggestion: boolean;
  temperatureBucket: InboxItemViewModel["temperatureBucket"];
}): boolean {
  if (input.signalSeverity === "critical") return true;
  if (input.waitingMinutes !== null && input.waitingMinutes >= 120) return true;
  if (
    input.primarySignal === "customer_waiting" &&
    !input.hasPendingSuggestion &&
    input.waitingMinutes !== null &&
    input.waitingMinutes >= 25
  ) {
    return true;
  }
  if (
    (input.primarySignal === "stalled_quote" ||
      input.primarySignal === "hot_negotiation") &&
    input.waitingMinutes !== null &&
    input.waitingMinutes >= 45
  ) {
    return true;
  }
  if (
    input.temperatureBucket === "hot" &&
    !input.hasPendingSuggestion &&
    input.waitingMinutes !== null &&
    input.waitingMinutes >= 30
  ) {
    return true;
  }
  if (input.signalSeverity === "high" && input.waitingMinutes !== null && input.waitingMinutes >= 40) {
    return true;
  }
  return false;
}

function deriveConversationHealth(input: {
  signalSeverity: SignalSeverity;
  primarySignal: PrimarySignalKind;
  waitingMinutes: number | null;
  temperatureBucket: InboxItemViewModel["temperatureBucket"];
}): InboxConversationHealth {
  if (input.signalSeverity === "critical") return "at_risk";
  if (input.waitingMinutes !== null && input.waitingMinutes >= 180) return "at_risk";
  if (
    input.temperatureBucket === "hot" &&
    input.primarySignal === "customer_waiting"
  ) {
    return "at_risk";
  }
  if (
    input.signalSeverity === "high" ||
    input.temperatureBucket === "hot" ||
    (input.waitingMinutes !== null && input.waitingMinutes >= 60)
  ) {
    return "watch";
  }
  return "good";
}

/**
 * Which reply-suggestion statuses count as "still pending" for the view model.
 *
 * Lived as a private const inside the Inbox route until W3 needed the identical
 * filter to build the same view model for a lead. One definition, so the two
 * surfaces cannot drift into disagreeing about what a pending draft is.
 */
export const PENDING_SUGGESTION_STATUSES = ["GENERATED", "SHOWN", "SELECTED"] as const;

export type SerializeInboxItemInput = {
  conversation: Conversation & {
    customer: Customer | null;
    lead: Lead | null;
    messages: (Pick<
      Message,
      "contentText" | "senderType" | "createdAt" | "direction"
    > & {
      analysis: { intent: string } | null;
    })[];
    replySuggestions: Pick<
      ReplySuggestion,
      "id" | "status" | "createdAt" | "suggestionType"
    >[];
  };
  now?: Date;
  /** Terminal bot draft flags for this conversation (from batch query in route). */
  starterBot?: {
    hasTerminalHandoff: boolean;
    hasTerminalCompleted: boolean;
  };
  /**
   * Product Link Mode v1: when true, SBA may include `SHOW_PRODUCT_LINK`
   * (from `BusinessBotSettings`: enabled + valid http(s) URL).
   */
  productCatalogEnabled?: boolean;
};

export function serializeInboxItem(
  input: SerializeInboxItemInput
): InboxItemViewModel {
  const { conversation } = input;
  const now = input.now ?? new Date();
  const starterBot = input.starterBot ?? {
    hasTerminalHandoff: false,
    hasTerminalCompleted: false,
  };

  const customerNameRaw =
    conversation.customer?.name?.trim() ||
    conversation.lead?.customerName?.trim() ||
    "";
  const customerName = customerNameRaw.length > 0 ? customerNameRaw : null;

  const customerPhoneRaw =
    conversation.customer?.phone?.trim() ||
    conversation.lead?.phone?.trim() ||
    "";
  const customerPhone =
    customerPhoneRaw.length > 0 && customerName === null
      ? customerPhoneRaw
      : null;

  const lastMessageRaw = conversation.messages[0] ?? null;
  const lastMessage = lastMessageRaw
    ? {
        snippet: truncate(lastMessageRaw.contentText, SNIPPET_MAX_LENGTH),
        senderType: lastMessageRaw.senderType,
        at: lastMessageRaw.createdAt.toISOString(),
      }
    : null;

  const hasPendingSuggestion = conversation.replySuggestions.length > 0;
  const pendingSuggestionType =
    conversation.replySuggestions[0]?.suggestionType ?? undefined;

  let waitingMinutes: number | null = null;
  if (
    conversation.unansweredInboundCount >= 1 &&
    conversation.customerLastInboundAt
  ) {
    const ms = now.getTime() - conversation.customerLastInboundAt.getTime();
    waitingMinutes = Math.max(0, Math.floor(ms / 60000));
  }

  const temperatureBucket = bucketTemperature(conversation.temperatureScore);

  const stageLabel = stageLabelFromEnum(conversation.currentStage);

  const signal = evaluatePrimarySignal({
    status: conversation.status,
    currentStage: conversation.currentStage,
    unansweredInboundCount: conversation.unansweredInboundCount,
    customerLastInboundAt: conversation.customerLastInboundAt,
    businessLastOutboundAt: conversation.businessLastOutboundAt,
    lastMessageAt: conversation.lastMessageAt,
    temperatureScore: conversation.temperatureScore,
    hasPendingSuggestion,
    now,
  });

  const action = evaluateSuggestedAction({
    primarySignal: signal.kind,
    hasPendingSuggestion,
    status: conversation.status,
  });

  const priorityScore = computePriorityScore({
    severity: signal.severity,
    waitingMinutes,
    closeProbability: conversation.closeProbabilitySnapshot,
  });

  const lastActivityAt = (
    conversation.lastMessageAt ?? conversation.updatedAt
  ).toISOString();

  const hasHumanTakeover = isHumanTakeoverConversation(conversation.outcomeReason);

  const botFlowStatus = deriveBotFlowStatus({
    pendingSuggestionType: pendingSuggestionType,
    hasTerminalHandoff: starterBot.hasTerminalHandoff,
    hasTerminalCompleted: starterBot.hasTerminalCompleted,
    hasHumanTakeover,
  });
  const botProgressLabel = deriveBotProgressLabel(botFlowStatus, hasHumanTakeover);

  let lastCustomerIntent: string | null = null;
  const lastRow = conversation.messages[0];
  if (
    lastRow &&
    lastRow.direction === "INBOUND" &&
    lastRow.senderType === "CUSTOMER" &&
    lastRow.analysis
  ) {
    lastCustomerIntent = lastRow.analysis.intent ?? null;
  }

  const needsHumanAttention = deriveNeedsHumanAttention({
    signalSeverity: signal.severity,
    primarySignal: signal.kind,
    waitingMinutes,
    hasPendingSuggestion,
    temperatureBucket,
  });

  const conversationHealth = deriveConversationHealth({
    signalSeverity: signal.severity,
    primarySignal: signal.kind,
    waitingMinutes,
    temperatureBucket,
  });

  const nextBestAction = evaluateNextBestAction({
    status: conversation.status,
    primarySignal: signal.kind,
    signalSeverity: signal.severity,
    suggestedAction: action.kind,
    suggestedActionLabel: action.label,
    needsHumanAttention,
    botFlowStatus,
    hasPendingSuggestion,
    waitingMinutes,
    temperatureBucket,
    replySuggestions: conversation.replySuggestions,
  });

  const customerWaitingForBusiness =
    conversation.unansweredInboundCount >= 1 && conversation.customerLastInboundAt != null;

  const businessReplyIsLatest =
    conversation.businessLastOutboundAt != null &&
    (!conversation.customerLastInboundAt ||
      conversation.businessLastOutboundAt.getTime() >
        conversation.customerLastInboundAt.getTime());

  const conversationOutcome = deriveConversationOutcome({
    humanTakeover: hasHumanTakeover,
    status: conversation.status,
    currentStage: conversation.currentStage,
    primarySignal: signal.kind,
    signalSeverity: signal.severity,
    botFlowStatus,
    nextBestActionKind: nextBestAction.kind,
    hasPendingSuggestion,
    needsHumanAttention,
    customerWaitingForBusiness,
    businessReplyIsLatest,
  });

  const businessSituation = deriveBusinessSituation({
    status: conversation.status,
    currentStage: conversation.currentStage,
    primarySignal: signal.kind,
    waitingMinutes,
    hasPendingSuggestion,
    botFlowStatus,
    temperatureBucket,
    nextBestAction,
    conversationOutcome,
  });

  const suggestedBusinessActions = suggestBusinessActionsFromInboxSignals({
    status: conversation.status,
    currentStage: conversation.currentStage,
    primarySignal: signal.kind,
    signalSeverity: signal.severity,
    botFlowStatus,
    nextBestAction,
    conversationOutcome,
    businessSituationKind: businessSituation.kind,
    hasPendingSuggestion,
    temperatureBucket,
    needsHumanAttention,
    productCatalogEnabled: input.productCatalogEnabled === true,
  });

  return {
    conversationId: conversation.id,
    customerName,
    customerPhone,
    channel: conversation.channel,
    status: conversation.status,
    currentStage: conversation.currentStage,
    stageLabel,
    primarySignal: signal.kind,
    signalLabel: signal.label,
    signalSeverity: signal.severity,
    temperatureBucket,
    waitingMinutes,
    lastActivityAt,
    hasPendingSuggestion,
    lastMessage,
    suggestedAction: action.kind,
    suggestedActionLabel: action.label,
    priorityScore,
    botFlowStatus,
    botProgressLabel,
    humanTakeoverActive: hasHumanTakeover,
    lastCustomerIntent,
    needsHumanAttention,
    conversationHealth,
    nextBestAction,
    conversationOutcome,
    businessSituation,
    suggestedBusinessActions,
  };
}
