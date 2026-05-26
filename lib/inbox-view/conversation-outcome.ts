import type { ConversationStage, ConversationStatus } from "@prisma/client";

/**
 * Internal-only conversation situation (v1). Derived deterministically in
 * `serializeInboxItem` — not shown in UI, not a work category, not NBA.
 */
export type ConversationOutcomeKind =
  | "CLOSED"
  | "HANDOFF_PENDING"
  | "NEEDS_OWNER_ACTION"
  | "DRAFT_READY_TO_SEND"
  | "BOT_COLLECTING"
  | "WAITING_ON_CUSTOMER"
  | "FOLLOW_UP_OR_REENGAGE"
  | "QUOTE_IN_FLIGHT"
  | "ACTIVE_ENGAGEMENT";

export type ConversationOutcome = {
  kind: ConversationOutcomeKind;
  /** Stable machine key for logs / analytics (not user-facing). */
  reason: string;
};

export type DeriveConversationOutcomeInput = {
  /** Bot Control v1 — owner explicitly took the conversation. */
  humanTakeover?: boolean;
  status: ConversationStatus;
  currentStage: ConversationStage | null;
  /** `evaluatePrimarySignal` kind */
  primarySignal: string;
  signalSeverity: string;
  botFlowStatus: string;
  /** `evaluateNextBestAction` kind */
  nextBestActionKind: string;
  hasPendingSuggestion: boolean;
  needsHumanAttention: boolean;
  /**
   * Same gate as inbox waiting clock: unanswered inbound from customer exists.
   * When true, the business owes a reply (ball with owner), not "waiting on customer".
   */
  customerWaitingForBusiness: boolean;
  /**
   * Business outbound is strictly after last customer inbound, or only business
   * outbound exists (no customer inbound yet).
   */
  businessReplyIsLatest: boolean;
};

/**
 * Priority ladder (first match wins). Intentionally orthogonal to NBA text/labels;
 * uses the same underlying signals only. Does not affect queue or categories.
 */
export function deriveConversationOutcome(
  input: DeriveConversationOutcomeInput
): ConversationOutcome {
  if (input.humanTakeover === true) {
    return { kind: "HANDOFF_PENDING", reason: "outcome.v1.human_takeover" };
  }

  if (input.status === "ARCHIVED") {
    return { kind: "CLOSED", reason: "outcome.v1.status_archived" };
  }
  if (input.status === "CLOSED") {
    return { kind: "CLOSED", reason: "outcome.v1.status_closed" };
  }
  if (input.status !== "OPEN") {
    return { kind: "CLOSED", reason: "outcome.v1.status_not_open" };
  }

  if (
    input.needsHumanAttention === true ||
    input.nextBestActionKind === "immediate_attention" ||
    input.signalSeverity === "critical"
  ) {
    return { kind: "NEEDS_OWNER_ACTION", reason: "outcome.v1.owner_action_required" };
  }

  if (input.botFlowStatus === "HANDOFF" || input.nextBestActionKind === "agent_handoff") {
    return { kind: "HANDOFF_PENDING", reason: "outcome.v1.bot_or_nba_handoff" };
  }

  if (input.hasPendingSuggestion === true || input.nextBestActionKind === "send_ready_draft") {
    return { kind: "DRAFT_READY_TO_SEND", reason: "outcome.v1.draft_ready" };
  }

  if (input.botFlowStatus === "IN_PROGRESS") {
    return { kind: "BOT_COLLECTING", reason: "outcome.v1.starter_bot_in_progress" };
  }

  if (
    input.primarySignal === "stalled_quote" ||
    (input.currentStage === "QUOTED" && !input.customerWaitingForBusiness)
  ) {
    return { kind: "QUOTE_IN_FLIGHT", reason: "outcome.v1.quote_phase_waiting_customer" };
  }

  if (
    input.primarySignal === "needs_followup" ||
    input.primarySignal === "cooling" ||
    input.nextBestActionKind === "follow_up_or_warm"
  ) {
    return { kind: "FOLLOW_UP_OR_REENGAGE", reason: "outcome.v1.followup_or_cooling_signal" };
  }

  if (
    !input.customerWaitingForBusiness &&
    input.businessReplyIsLatest &&
    input.primarySignal !== "hot_negotiation" &&
    input.primarySignal !== "fresh_lead"
  ) {
    return { kind: "WAITING_ON_CUSTOMER", reason: "outcome.v1.business_spoke_last_ball_customer" };
  }

  return { kind: "ACTIVE_ENGAGEMENT", reason: "outcome.v1.default_open_thread" };
}
