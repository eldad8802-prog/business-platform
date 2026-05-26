import type { InboxItemViewModel } from "@/lib/inbox-view/inbox-item.types";

/**
 * Minimal conversation fields needed for inbox queue ordering (recency).
 * Caller rows may be a superset (e.g. page `Conversation` type).
 */
export type InboxQueueConversationSlice = {
  id: number;
  startedAt: string;
  lastMessageAt?: string | null;
  updatedAt?: string;
};

const CLOSED_QUEUE_TIER = 50;
const MISSING_ITEM_TIER = 99;

function parseInboxIsoMs(value: string | null | undefined): number | null {
  if (value == null || String(value).trim() === "") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/** Newest = larger ms. Same chain as inbox page: lastMessage.at → lastMessageAt → updatedAt → lastActivityAt → startedAt. */
export function inboxQueueRecencyMs(
  conversation: InboxQueueConversationSlice,
  item: InboxItemViewModel | undefined
): number {
  const m0 = item?.lastMessage?.at != null ? parseInboxIsoMs(item.lastMessage.at) : null;
  if (m0 != null) return m0;

  const m1 = parseInboxIsoMs(conversation.lastMessageAt ?? null);
  if (m1 != null) return m1;

  const m2 = parseInboxIsoMs(conversation.updatedAt);
  if (m2 != null) return m2;

  const m3 = item != null ? parseInboxIsoMs(item.lastActivityAt) : null;
  if (m3 != null) return m3;

  return parseInboxIsoMs(conversation.startedAt) ?? 0;
}

/**
 * Operational queue tier (1 = highest). Deterministic else-if chain per product v1.
 * CLOSED rows share one tier so ordering within "סגורות" is recency-only.
 */
export function getInboxQueueTier(item: InboxItemViewModel): number {
  if (item.status === "CLOSED") {
    return CLOSED_QUEUE_TIER;
  }

  if (
    item.needsHumanAttention === true ||
    item.signalSeverity === "critical" ||
    item.nextBestAction?.kind === "immediate_attention"
  ) {
    return 1;
  }

  if (item.nextBestAction?.severity === "high") {
    return 2;
  }

  if (item.signalSeverity === "high") {
    return 3;
  }

  if (
    item.hasPendingSuggestion === true ||
    item.nextBestAction?.kind === "send_ready_draft"
  ) {
    return 4;
  }

  if (item.temperatureBucket === "hot") {
    return 5;
  }

  if (item.waitingMinutes !== null && item.waitingMinutes >= 60) {
    return 6;
  }

  return 7;
}

/**
 * Sort key: lower tier first, then newer first, then lower conversationId (stable).
 */
export function compareInboxQueueRows(
  convA: InboxQueueConversationSlice,
  itemA: InboxItemViewModel | undefined,
  convB: InboxQueueConversationSlice,
  itemB: InboxItemViewModel | undefined
): number {
  const tierA = itemA !== undefined ? getInboxQueueTier(itemA) : MISSING_ITEM_TIER;
  const tierB = itemB !== undefined ? getInboxQueueTier(itemB) : MISSING_ITEM_TIER;
  if (tierA !== tierB) {
    return tierA - tierB;
  }

  const recA = inboxQueueRecencyMs(convA, itemA);
  const recB = inboxQueueRecencyMs(convB, itemB);
  if (recB !== recA) {
    return recB - recA;
  }

  return convA.id - convB.id;
}

export function sortInboxRowsRecencyOnly<T extends InboxQueueConversationSlice>(
  list: readonly T[],
  items: InboxItemViewModel[] | undefined
): T[] {
  const byConvId = new Map<number, InboxItemViewModel>();
  if (items) {
    for (const it of items) {
      byConvId.set(it.conversationId, it);
    }
  }
  return [...list].sort((a, b) => {
    const tb = inboxQueueRecencyMs(b, byConvId.get(b.id));
    const ta = inboxQueueRecencyMs(a, byConvId.get(a.id));
    if (tb !== ta) return tb - ta;
    return a.id - b.id;
  });
}

/**
 * When `recencyOnly` or no items: newest-first + id tie-break.
 * Otherwise: queue tiers then recency within tier.
 */
export function sortInboxConversationRows<T extends InboxQueueConversationSlice>(
  conversations: readonly T[],
  items: InboxItemViewModel[] | undefined,
  options?: { recencyOnly?: boolean }
): T[] {
  if (items === undefined || items.length === 0 || options?.recencyOnly === true) {
    return sortInboxRowsRecencyOnly(conversations, items);
  }

  const byId = new Map(items.map((i) => [i.conversationId, i]));
  return [...conversations].sort((a, b) =>
    compareInboxQueueRows(a, byId.get(a.id), b, byId.get(b.id))
  );
}
