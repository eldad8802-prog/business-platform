import type { ConversationStatus } from "@prisma/client";
import type { Translator } from "@/lib/i18n/translate";
import type {
  PrimarySignalKind,
  SuggestedActionKind,
} from "./inbox-item.types";
import { INBOX_VIEW_HE_T } from "./inbox-view-i18n";

/**
 * Pure mapper from primary signal → suggested action.
 *
 * v1 produces a short Hebrew label only; the UI does NOT wire this to a
 * clickable CTA (per scope). It is purely advisory text.
 *
 * Keeps the signal layer and the action layer decoupled — the action
 * mapping can be tweaked without touching primary-signal logic.
 */

export type SuggestedActionInput = {
  primarySignal: PrimarySignalKind;
  hasPendingSuggestion: boolean;
  status: ConversationStatus;
};

export type SuggestedActionResult = {
  kind: SuggestedActionKind;
  label: string;
};

export function evaluateSuggestedAction(
  input: SuggestedActionInput,
  t: Translator = INBOX_VIEW_HE_T
): SuggestedActionResult {
  if (input.status !== "OPEN") {
    return { kind: "none", label: "" };
  }

  switch (input.primarySignal) {
    case "customer_waiting":
      return {
        kind: "reply_now",
        label: input.hasPendingSuggestion
          ? t("insights.inbox.suggested.replyNow")
          : t("insights.inbox.suggested.shouldReply"),
      };
    case "stalled_quote":
      return { kind: "review_quote", label: t("insights.inbox.suggested.reviewQuote") };
    case "needs_followup":
      return { kind: "send_followup", label: t("insights.inbox.suggested.sendReminder") };
    case "cooling":
      return { kind: "send_followup", label: t("insights.inbox.suggested.rewarm") };
    case "hot_negotiation":
      // Pure informational state — the "hot" signal pill itself communicates
      // enough. We don't recommend "wait", because that's not an action.
      return { kind: "none", label: "" };
    case "fresh_lead":
    case "neutral":
    default:
      return { kind: "none", label: "" };
  }
}
