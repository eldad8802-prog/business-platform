import type {
  ConversationChannel,
  ConversationStage,
  ConversationStatus,
  MessageSenderType,
} from "@prisma/client";

export type TemperatureBucket = "cold" | "warm" | "hot";

export type SignalSeverity = "critical" | "high" | "medium" | "low" | "info";

export type PrimarySignalKind =
  | "customer_waiting"
  | "stalled_quote"
  | "hot_negotiation"
  | "needs_followup"
  | "cooling"
  | "fresh_lead"
  | "neutral";

export type SuggestedActionKind =
  | "reply_now"
  | "send_followup"
  | "review_quote"
  | "wait_for_customer"
  | "none";

export type InboxItemLastMessage = {
  snippet: string;
  senderType: MessageSenderType;
  at: string;
};

export type InboxItemViewModel = {
  conversationId: number;
  /** Real name from Customer/Lead. null when no real identity is known. */
  customerName: string | null;
  /** Phone fallback identity when there is no name. null otherwise. */
  customerPhone: string | null;
  channel: ConversationChannel;
  status: ConversationStatus;

  currentStage: ConversationStage | null;
  stageLabel: string;

  primarySignal: PrimarySignalKind;
  signalLabel: string;
  signalSeverity: SignalSeverity;

  temperatureBucket: TemperatureBucket;

  waitingMinutes: number | null;
  lastActivityAt: string;

  hasPendingSuggestion: boolean;
  lastMessage: InboxItemLastMessage | null;

  suggestedAction: SuggestedActionKind;
  suggestedActionLabel: string;

  priorityScore: number;
};
