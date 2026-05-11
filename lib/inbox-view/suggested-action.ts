import type { ConversationStatus } from "@prisma/client";
import type {
  PrimarySignalKind,
  SuggestedActionKind,
} from "./inbox-item.types";

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
  input: SuggestedActionInput
): SuggestedActionResult {
  if (input.status !== "OPEN") {
    return { kind: "none", label: "" };
  }

  switch (input.primarySignal) {
    case "customer_waiting":
      return {
        kind: "reply_now",
        label: input.hasPendingSuggestion ? "ענה עכשיו" : "כדאי להגיב",
      };
    case "stalled_quote":
      return { kind: "review_quote", label: "בדוק את ההצעה" };
    case "needs_followup":
      return { kind: "send_followup", label: "שלח תזכורת" };
    case "cooling":
      return { kind: "send_followup", label: "נסה לחמם מחדש" };
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
