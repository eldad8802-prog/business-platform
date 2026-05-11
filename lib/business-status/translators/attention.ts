import type {
  AttentionPendingSuggestionRaw,
  AttentionWaitingRaw,
} from "../loaders";
import type { BusinessStatusItemBuild } from "../types";

function customerLabel(name: string | null): string {
  return name && name.trim() !== "" ? name : "לקוח";
}

export function translateAttentionWaiting(
  rows: AttentionWaitingRaw[]
): BusinessStatusItemBuild[] {
  return rows.map((r) => {
    const whom = customerLabel(r.customerName);
    const summaryParts = [
      r.snippet ? `הודעה אחרונה: ${r.snippet}` : null,
      r.hasPendingSuggestion ? "יש הצעת תשובה פתוחה." : null,
    ].filter(Boolean);

    return {
      itemId: `inbox:waiting:${r.conversationId}`,
      domain: "inbox",
      semanticCategory: "ACTION_REQUIRED",
      title: `${whom} ממתין למענה`,
      summary: summaryParts.length > 0 ? summaryParts.join(" ") : null,
      severity: "HIGH",
      entityRef: { type: "conversation", id: r.conversationId },
      state: "open",
      createdAt: r.conversationCreatedAt.toISOString(),
      primaryAction: {
        kind: "navigate",
        label: "פתח את התיבה",
        href: "/inbox",
      },
      sourceEngine: "attention-queue",
      blocking: false,
      priorityReferenceDate: r.relevantAt,
    };
  });
}

export function translateAttentionPendingSuggestions(
  rows: AttentionPendingSuggestionRaw[]
): BusinessStatusItemBuild[] {
  return rows.map((r) => {
    const whom = customerLabel(r.customerName);
    return {
      itemId: `inbox:pending-suggestion:${r.conversationId}`,
      domain: "inbox",
      semanticCategory: "ACTION_REQUIRED",
      title: `הצעת תשובה ממתינה — ${whom}`,
      summary: r.suggestionSnippet
        ? `טקסט מוצע: ${r.suggestionSnippet}`
        : null,
      severity: "MEDIUM",
      entityRef: { type: "conversation", id: r.conversationId },
      state: "open",
      createdAt: r.conversationCreatedAt.toISOString(),
      primaryAction: {
        kind: "navigate",
        label: "פתח את התיבה",
        href: "/inbox",
      },
      sourceEngine: "attention-queue",
      blocking: false,
      priorityReferenceDate: r.relevantAt,
    };
  });
}
