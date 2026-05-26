import type {
  ConversationChannel,
  ConversationStage,
  ConversationStatus,
  MessageSenderType,
} from "@prisma/client";
import type { InboxBusinessSituation } from "./business-situation";
import type { ConversationOutcome } from "./conversation-outcome";

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

/** Deterministic “next best action” (v1) — JSON only, no DB field. */
export type NextBestActionKind =
  | "immediate_attention"
  | "agent_handoff"
  | "send_ready_draft"
  | "respond_waiting_customer"
  | "review_stalled_quote"
  | "engage_hot_thread"
  | "follow_up_or_warm"
  | "nurture_fresh_lead"
  | "monitor_active"
  | "none";

export type NextBestActionSource =
  | "conversation_status"
  | "needs_human_attention_rule"
  | "signal_severity_critical"
  | "bot_flow_handoff"
  | "draft_ready_generated"
  | "draft_ready_starter_bot"
  | "customer_waiting_clock"
  | "stalled_quote_signal"
  | "hot_negotiation_signal"
  | "temperature_hot_bucket"
  | "needs_followup_signal"
  | "cooling_signal"
  | "fresh_lead_signal"
  | "neutral_fallback";

export type NextBestAction = {
  kind: NextBestActionKind;
  label: string;
  severity: SignalSeverity;
  /** Stable key for logs / support (not shown to users by default). */
  reason: string;
  source: NextBestActionSource;
  legacySuggestedAction?: SuggestedActionKind;
};

/** v1 suggested business actions — ids match `ConversationActionId` in conversation-action-registry. */
export type SuggestedBusinessActionItem = {
  id: string;
  reason: string;
  score: number;
};

export type InboxItemLastMessage = {
  snippet: string;
  senderType: MessageSenderType;
  at: string;
};

/** Starter Bot lifecycle hint for list rows (derived, no LLM). */
export type InboxBotFlowStatus = "IN_PROGRESS" | "COMPLETED" | "HANDOFF" | "NONE";

/** Coarse health bucket from existing conversation + signal fields. */
export type InboxConversationHealth = "good" | "watch" | "at_risk";

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

  /** Optional v1 intelligence — always populated by serializer when inputs allow. */
  botFlowStatus?: InboxBotFlowStatus;
  botProgressLabel?: string;
  /** Bot Control v1 — owner pressed "אני מטפל מכאן". */
  humanTakeoverActive?: boolean;
  lastCustomerIntent?: string | null;
  needsHumanAttention?: boolean;
  conversationHealth?: InboxConversationHealth;

  /** v1 NBA — optional for older API clients; always set by current serializer. */
  nextBestAction?: NextBestAction;

  /** v1 internal situation — not for UI; set by serializer when present. */
  conversationOutcome?: ConversationOutcome;

  /** Business-facing situation summary derived from stage, signals, bot and waiting state. */
  businessSituation?: InboxBusinessSituation;

  /** v1 business-action hints — UI may surface as suggestions; derived only, no execution. */
  suggestedBusinessActions?: readonly SuggestedBusinessActionItem[];
};
