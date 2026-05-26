import type { ConversationStage, ConversationStatus } from "@prisma/client";
import type { ConversationOutcome } from "@/lib/inbox-view/conversation-outcome";
import type {
  InboxBusinessSituationKind,
} from "@/lib/inbox-view/business-situation";
import type {
  InboxBotFlowStatus,
  NextBestAction,
  PrimarySignalKind,
  SignalSeverity,
  SuggestedBusinessActionItem,
  TemperatureBucket,
} from "@/lib/inbox-view/inbox-item.types";
import {
  getConversationActionDefinition,
  type ConversationActionId,
} from "@/lib/conversation-actions/conversation-action-registry";

const MAX_SUGGESTIONS = 3;
const MIN_SCORE = 35;

export type SuggestBusinessActionsFromInboxSignalsInput = {
  status: ConversationStatus;
  currentStage: ConversationStage | null;
  primarySignal: PrimarySignalKind;
  signalSeverity: SignalSeverity;
  botFlowStatus: InboxBotFlowStatus;
  nextBestAction: NextBestAction;
  conversationOutcome: ConversationOutcome;
  businessSituationKind?: InboxBusinessSituationKind;
  hasPendingSuggestion: boolean;
  temperatureBucket: TemperatureBucket;
  needsHumanAttention: boolean;
  /**
   * Product Link Mode v1: `productLinkEnabled && validUrl` from BusinessBotSettings.
   * If omitted/false, `SHOW_PRODUCT_LINK` is never suggested.
   */
  productCatalogEnabled?: boolean;
};

function severityWeight(sev: SignalSeverity): number {
  switch (sev) {
    case "critical":
      return 40;
    case "high":
      return 30;
    case "medium":
      return 20;
    case "low":
      return 10;
    case "info":
    default:
      return 0;
  }
}

function pushCandidate(
  out: SuggestedBusinessActionItem[],
  id: ConversationActionId,
  reason: string,
  score: number
): void {
  if (getConversationActionDefinition(id) === undefined) return;
  if (out.some((x) => x.id === id)) return;
  out.push({ id, reason, score });
}

/**
 * Pure, side-effect-free suggestions (max 3). IDs exist in `CONVERSATION_ACTION_REGISTRY`.
 * Does not read message text; does not call domain services.
 *
 * v1 product rules: starter-bot handoff is terminal (only `HANDOFF_TO_OWNER`);
 * crisis states yield no other business-action hints unless handoff (handled above).
 */
export function suggestBusinessActionsFromInboxSignals(
  input: SuggestBusinessActionsFromInboxSignalsInput
): SuggestedBusinessActionItem[] {
  if (input.status !== "OPEN") {
    return [];
  }

  const nba = input.nextBestAction.kind;
  const hotBucket = input.temperatureBucket === "hot";

  // Terminal v1: handoff alone — no follow-up / quote / product stacking.
  if (input.botFlowStatus === "HANDOFF") {
    if (getConversationActionDefinition("HANDOFF_TO_OWNER") === undefined) {
      return [];
    }
    const score = 56 + severityWeight(input.signalSeverity);
    if (score < MIN_SCORE) {
      return [];
    }
    return [{ id: "HANDOFF_TO_OWNER", reason: "sba.v1.starter_bot_handoff", score }];
  }

  const crisis =
    input.needsHumanAttention === true ||
    input.signalSeverity === "critical" ||
    nba === "immediate_attention";

  if (crisis) {
    return [];
  }

  const candidates: SuggestedBusinessActionItem[] = [];

  if (input.businessSituationKind === "NEW_LEAD") {
    pushCandidate(
      candidates,
      "CREATE_LEAD",
      "sba.v2.business_situation_new_lead",
      44 + (hotBucket ? 8 : 0)
    );
  }

  if (input.businessSituationKind === "CUSTOMER_WAITING") {
    pushCandidate(
      candidates,
      "CHECK_PRODUCT_AVAILABILITY",
      "sba.v2.customer_waiting_possible_product_question",
      36 + severityWeight(input.signalSeverity)
    );
  }

  // Follow-up: not when NBA already is the follow-up recommendation (avoid noisy duplicate).
  const followUpOutcome = input.conversationOutcome.kind === "FOLLOW_UP_OR_REENGAGE";
  const followUpPrimary =
    input.primarySignal === "needs_followup" || input.primarySignal === "cooling";
  if (
    nba !== "follow_up_or_warm" &&
    (followUpOutcome || followUpPrimary || (hotBucket && input.primarySignal === "needs_followup"))
  ) {
    pushCandidate(
      candidates,
      "CREATE_FOLLOW_UP",
      "sba.v1.followup_outcome_or_signal",
      42 + (followUpOutcome ? 12 : 0) + (hotBucket ? 6 : 0)
    );
  }

  // Quote milestone: stage or stalled / quote-in-flight style signals (no free-text).
  const quoteStage = input.currentStage === "QUOTED";
  const quoteSignal =
    input.primarySignal === "stalled_quote" ||
    input.conversationOutcome.kind === "QUOTE_IN_FLIGHT";
  if ((quoteStage || quoteSignal) && nba !== "review_stalled_quote") {
    pushCandidate(
      candidates,
      "MARK_QUOTE_SENT",
      "sba.v1.quote_stage_or_quote_outcome",
      40 + (quoteSignal ? 10 : 0)
    );
  }

  if (
    input.businessSituationKind === "QUOTE_WAITING" ||
    input.businessSituationKind === "HOT_OPPORTUNITY"
  ) {
    pushCandidate(
      candidates,
      "CREATE_INVOICE_DRAFT",
      "sba.v2.quote_or_hot_opportunity_may_need_billing",
      37 + (input.businessSituationKind === "HOT_OPPORTUNITY" ? 8 : 0)
    );
  }

  const productLinkAllowed =
    input.productCatalogEnabled === true &&
    input.needsHumanAttention !== true &&
    input.signalSeverity !== "critical" &&
    input.nextBestAction.kind !== "immediate_attention";

  // Product link: capability on + warm context (ranking unchanged beyond this gate).
  if (
    productLinkAllowed &&
    (hotBucket ||
      input.primarySignal === "fresh_lead" ||
      input.primarySignal === "hot_negotiation") &&
    nba !== "send_ready_draft" &&
    !input.hasPendingSuggestion
  ) {
    pushCandidate(
      candidates,
      "SHOW_PRODUCT_LINK",
      "sba.v1.catalog_enabled_warm_thread",
      38 + (input.primarySignal === "hot_negotiation" ? 8 : 0)
    );
  }

  const ranked = [...candidates].sort((a, b) => b.score - a.score);
  const filtered = ranked.filter((c) => c.score >= MIN_SCORE);
  return filtered.slice(0, MAX_SUGGESTIONS);
}
