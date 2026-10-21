import type { Translator } from "@/lib/i18n/translate";

import type {
  AttentionPendingSuggestionRaw,
  AttentionWaitingRaw,
} from "../loaders";
import { STATUS_HE_T } from "../i18n";
import type { BusinessStatusItemBuild } from "../types";

function customerLabel(name: string | null, t: Translator): string {
  return name && name.trim() !== "" ? name : t("insights.status.attention.customerFallback");
}

export function translateAttentionWaiting(
  rows: AttentionWaitingRaw[],
  t: Translator = STATUS_HE_T
): BusinessStatusItemBuild[] {
  return rows.map((r) => {
    const whom = customerLabel(r.customerName, t);
    const summaryParts = [
      r.snippet ? t("insights.status.attention.lastMessage", { snippet: r.snippet }) : null,
      r.hasPendingSuggestion ? t("insights.status.attention.hasPendingSuggestion") : null,
    ].filter(Boolean);

    return {
      itemId: `inbox:waiting:${r.conversationId}`,
      domain: "inbox",
      semanticCategory: "ACTION_REQUIRED",
      title: t("insights.status.attention.waitingTitle", { whom }),
      summary: summaryParts.length > 0 ? summaryParts.join(" ") : null,
      severity: "HIGH",
      entityRef: { type: "conversation", id: r.conversationId },
      state: "open",
      createdAt: r.conversationCreatedAt.toISOString(),
      primaryAction: {
        kind: "navigate",
        label: t("insights.status.attention.openInbox"),
        href: "/inbox",
      },
      sourceEngine: "attention-queue",
      blocking: false,
      priorityReferenceDate: r.relevantAt,
    };
  });
}

export function translateAttentionPendingSuggestions(
  rows: AttentionPendingSuggestionRaw[],
  t: Translator = STATUS_HE_T
): BusinessStatusItemBuild[] {
  return rows.map((r) => {
    const whom = customerLabel(r.customerName, t);
    return {
      itemId: `inbox:pending-suggestion:${r.conversationId}`,
      domain: "inbox",
      semanticCategory: "ACTION_REQUIRED",
      title: t("insights.status.attention.pendingSuggestionTitle", { whom }),
      summary: r.suggestionSnippet
        ? t("insights.status.attention.suggestedText", { snippet: r.suggestionSnippet })
        : null,
      severity: "MEDIUM",
      entityRef: { type: "conversation", id: r.conversationId },
      state: "open",
      createdAt: r.conversationCreatedAt.toISOString(),
      primaryAction: {
        kind: "navigate",
        label: t("insights.status.attention.openInbox"),
        href: "/inbox",
      },
      sourceEngine: "attention-queue",
      blocking: false,
      priorityReferenceDate: r.relevantAt,
    };
  });
}
