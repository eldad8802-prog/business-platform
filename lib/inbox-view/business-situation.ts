import type { ConversationStage, ConversationStatus } from "@prisma/client";
import type { Translator } from "@/lib/i18n/translate";
import { INBOX_VIEW_HE_T } from "./inbox-view-i18n";
import type { ConversationOutcome } from "./conversation-outcome";
import type {
  InboxBotFlowStatus,
  NextBestAction,
  PrimarySignalKind,
  TemperatureBucket,
} from "./inbox-item.types";

export type InboxBusinessSituationKind =
  | "CUSTOMER_WAITING"
  | "DRAFT_READY"
  | "BOT_HANDOFF"
  | "BOT_COLLECTING"
  | "QUOTE_WAITING"
  | "FOLLOW_UP_DUE"
  | "WAITING_ON_CUSTOMER"
  | "HOT_OPPORTUNITY"
  | "NEW_LEAD"
  | "CLOSED"
  | "ACTIVE";

export type InboxBusinessSituation = {
  kind: InboxBusinessSituationKind;
  label: string;
  shortLabel: string;
  explanation: string;
  primaryActionLabel: string;
  waitingOn: "business" | "customer" | "system" | "none";
  reason: string;
};

export type DeriveBusinessSituationInput = {
  status: ConversationStatus;
  currentStage: ConversationStage | null;
  primarySignal: PrimarySignalKind;
  waitingMinutes: number | null;
  hasPendingSuggestion: boolean;
  botFlowStatus: InboxBotFlowStatus;
  temperatureBucket: TemperatureBucket;
  nextBestAction: NextBestAction;
  conversationOutcome: ConversationOutcome;
};

function waitingText(minutes: number | null, t: Translator): string {
  if (minutes === null || minutes <= 0) return "";
  if (minutes < 60) return ` ${t("insights.inbox.situation.waitMinutes", { n: minutes })}`;
  return ` ${t("insights.inbox.situation.waitHours", { n: Math.floor(minutes / 60) })}`;
}

export function deriveBusinessSituation(
  input: DeriveBusinessSituationInput,
  t: Translator = INBOX_VIEW_HE_T
): InboxBusinessSituation {
  if (input.status !== "OPEN" || input.conversationOutcome.kind === "CLOSED") {
    return {
      kind: "CLOSED",
      label: t("insights.inbox.situation.closed.label"),
      shortLabel: t("insights.inbox.situation.closed.short"),
      explanation: t("insights.inbox.situation.closed.explanation"),
      primaryActionLabel: t("insights.inbox.situation.closed.action"),
      waitingOn: "none",
      reason: "business_situation.v1.closed",
    };
  }

  if (input.conversationOutcome.kind === "NEEDS_OWNER_ACTION") {
    return {
      kind: "CUSTOMER_WAITING",
      label: t("insights.inbox.situation.customerWaiting.label"),
      shortLabel: t("insights.inbox.situation.customerWaiting.short"),
      explanation: t("insights.inbox.situation.customerWaiting.explanation", { wait: waitingText(input.waitingMinutes, t) }),
      primaryActionLabel: input.hasPendingSuggestion
        ? t("insights.inbox.situation.customerWaiting.actionDraft")
        : t("insights.inbox.situation.customerWaiting.actionReply"),
      waitingOn: "business",
      reason: "business_situation.v1.customer_waiting_owner_action",
    };
  }

  if (input.conversationOutcome.kind === "HANDOFF_PENDING") {
    if (input.conversationOutcome.reason === "outcome.v1.human_takeover") {
      return {
        kind: "BOT_HANDOFF",
        label: t("insights.inbox.situation.humanTakeover.label"),
        shortLabel: t("insights.inbox.situation.humanTakeover.short"),
        explanation: t("insights.inbox.situation.humanTakeover.explanation"),
        primaryActionLabel: t("insights.inbox.situation.humanTakeover.action"),
        waitingOn: "business",
        reason: "business_situation.v1.human_takeover",
      };
    }
    return {
      kind: "BOT_HANDOFF",
      label: t("insights.inbox.situation.botHandoff.label"),
      shortLabel: t("insights.inbox.situation.botHandoff.short"),
      explanation: t("insights.inbox.situation.botHandoff.explanation"),
      primaryActionLabel: t("insights.inbox.situation.botHandoff.action"),
      waitingOn: "business",
      reason: "business_situation.v1.bot_handoff",
    };
  }

  if (input.conversationOutcome.kind === "DRAFT_READY_TO_SEND") {
    return {
      kind: "DRAFT_READY",
      label: t("insights.inbox.situation.draftReady.label"),
      shortLabel: t("insights.inbox.situation.draftReady.short"),
      explanation: t("insights.inbox.situation.draftReady.explanation"),
      primaryActionLabel: t("insights.inbox.situation.draftReady.action"),
      waitingOn: "business",
      reason: "business_situation.v1.draft_ready",
    };
  }

  if (input.conversationOutcome.kind === "BOT_COLLECTING") {
    return {
      kind: "BOT_COLLECTING",
      label: t("insights.inbox.situation.botCollecting.label"),
      shortLabel: t("insights.inbox.situation.botCollecting.short"),
      explanation: t("insights.inbox.situation.botCollecting.explanation"),
      primaryActionLabel: t("insights.inbox.situation.botCollecting.action"),
      waitingOn: "business",
      reason: "business_situation.v1.bot_collecting",
    };
  }

  if (input.conversationOutcome.kind === "QUOTE_IN_FLIGHT") {
    return {
      kind: "QUOTE_WAITING",
      label: t("insights.inbox.situation.quoteWaiting.label"),
      shortLabel: t("insights.inbox.situation.quoteWaiting.short"),
      explanation: t("insights.inbox.situation.quoteWaiting.explanation"),
      primaryActionLabel: t("insights.inbox.situation.quoteWaiting.action"),
      waitingOn: "customer",
      reason: "business_situation.v1.quote_waiting",
    };
  }

  if (input.conversationOutcome.kind === "FOLLOW_UP_OR_REENGAGE") {
    return {
      kind: "FOLLOW_UP_DUE",
      label: t("insights.inbox.situation.followUpDue.label"),
      shortLabel: t("insights.inbox.situation.followUpDue.short"),
      explanation: t("insights.inbox.situation.followUpDue.explanation"),
      primaryActionLabel: t("insights.inbox.situation.followUpDue.action"),
      waitingOn: "business",
      reason: "business_situation.v1.follow_up_due",
    };
  }

  if (input.conversationOutcome.kind === "WAITING_ON_CUSTOMER") {
    return {
      kind: "WAITING_ON_CUSTOMER",
      label: t("insights.inbox.situation.waitingOnCustomer.label"),
      shortLabel: t("insights.inbox.situation.waitingOnCustomer.short"),
      explanation: t("insights.inbox.situation.waitingOnCustomer.explanation"),
      primaryActionLabel: t("insights.inbox.situation.waitingOnCustomer.action"),
      waitingOn: "customer",
      reason: "business_situation.v1.waiting_on_customer",
    };
  }

  if (input.temperatureBucket === "hot" || input.primarySignal === "hot_negotiation") {
    return {
      kind: "HOT_OPPORTUNITY",
      label: t("insights.inbox.situation.hotOpportunity.label"),
      shortLabel: t("insights.inbox.situation.hotOpportunity.short"),
      explanation: t("insights.inbox.situation.hotOpportunity.explanation"),
      primaryActionLabel: t("insights.inbox.situation.hotOpportunity.action"),
      waitingOn: "business",
      reason: "business_situation.v1.hot_opportunity",
    };
  }

  if (input.currentStage === "NEW" || input.currentStage === null) {
    return {
      kind: "NEW_LEAD",
      label: t("insights.inbox.situation.newLead.label"),
      shortLabel: t("insights.inbox.situation.newLead.short"),
      explanation: t("insights.inbox.situation.newLead.explanation"),
      primaryActionLabel: t("insights.inbox.situation.newLead.action"),
      waitingOn: "business",
      reason: "business_situation.v1.new_lead",
    };
  }

  return {
    kind: "ACTIVE",
    label: t("insights.inbox.situation.active.label"),
    shortLabel: t("insights.inbox.situation.active.short"),
    explanation: t("insights.inbox.situation.active.explanation"),
    primaryActionLabel: input.nextBestAction.label || t("insights.inbox.situation.active.action"),
    waitingOn: "none",
    reason: "business_situation.v1.active",
  };
}
