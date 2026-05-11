import type {
  Conversation,
  ConversationStage,
  Customer,
  Lead,
  Message,
  ReplySuggestion,
} from "@prisma/client";
import type {
  InboxItemViewModel,
  SignalSeverity,
} from "./inbox-item.types";
import { bucketTemperature } from "./temperature-bucket";
import { evaluatePrimarySignal } from "./primary-signal";
import { evaluateSuggestedAction } from "./suggested-action";

/**
 * Pure serializer: a Conversation row with its includes → Inbox view-model.
 *
 * No I/O, no Prisma calls. Caller is responsible for fetching the conversation
 * with the required relations (`messages: take 1 desc`, `replySuggestions:
 * take 1 with open status`, `customer`, `lead`).
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

export type SerializeInboxItemInput = {
  conversation: Conversation & {
    customer: Customer | null;
    lead: Lead | null;
    messages: Pick<
      Message,
      "contentText" | "senderType" | "createdAt"
    >[];
    replySuggestions: Pick<
      ReplySuggestion,
      "id" | "status" | "createdAt"
    >[];
  };
  now?: Date;
};

export function serializeInboxItem(
  input: SerializeInboxItemInput
): InboxItemViewModel {
  const { conversation } = input;
  const now = input.now ?? new Date();

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
  };
}
