import type { InboxItemViewModel } from "@/lib/inbox-view/inbox-item.types";

/** Sidebar slice: 8 OPEN buckets + `closed` (status), ordered by importance in UI. */
export type InboxWorkCategoryId =
  | "needs_action"
  | "drafts_ready"
  | "handoff"
  | "bot_in_progress"
  | "hot_leads"
  | "follow_up"
  | "completed"
  | "active"
  | "closed";

/** OPEN-only bucket from `assignInboxWorkCategory` (excludes `closed`). */
export type InboxWorkCategoryBucket = Exclude<InboxWorkCategoryId, "closed">;

/** When API has no `items`, sidebar uses two coarse entries instead of smart buckets. */
export const INBOX_SIDEBAR_LEGACY_OPEN = "legacy_open" as const;

const DEFAULT_TAB_FALLBACK_ORDER: readonly InboxWorkCategoryId[] = [
  "needs_action",
  "drafts_ready",
  "bot_in_progress",
  "hot_leads",
  "handoff",
  "follow_up",
  "active",
  "completed",
] as const;

/** First non-empty smart bucket, or "הכל" when every bucket is empty. */
export function pickDefaultInboxSelection(
  countsByCategory: Record<InboxWorkCategoryId, number>
): InboxSidebarSelection {
  for (const id of DEFAULT_TAB_FALLBACK_ORDER) {
    if ((countsByCategory[id] ?? 0) > 0) return id;
  }
  return INBOX_SIDEBAR_LEGACY_OPEN;
}

export function totalOpenInboxCount(
  countsByCategory: Record<InboxWorkCategoryId, number>
): number {
  return Object.entries(countsByCategory).reduce(
    (sum, [key, value]) => (key === "closed" ? sum : sum + value),
    0
  );
}

export function countForInboxSelection(
  selection: InboxSidebarSelection,
  countsByCategory: Record<InboxWorkCategoryId, number>
): number {
  if (selection === INBOX_SIDEBAR_LEGACY_OPEN) {
    return totalOpenInboxCount(countsByCategory);
  }
  return countsByCategory[selection] ?? 0;
}

/** Avoid landing on an empty bucket when other open conversations exist. */
export function resolveInboxCategoryPick(
  requested: InboxSidebarSelection,
  countsByCategory: Record<InboxWorkCategoryId, number>
): InboxSidebarSelection {
  if (countForInboxSelection(requested, countsByCategory) > 0) {
    return requested;
  }
  if (totalOpenInboxCount(countsByCategory) === 0) {
    return requested;
  }
  return pickDefaultInboxSelection(countsByCategory);
}

export function countOpenItemsByWorkCategory(
  items: readonly InboxItemViewModel[]
): Record<InboxWorkCategoryId, number> {
  const byId = {
    needs_action: 0,
    drafts_ready: 0,
    handoff: 0,
    bot_in_progress: 0,
    hot_leads: 0,
    follow_up: 0,
    completed: 0,
    active: 0,
    closed: 0,
  } satisfies Record<InboxWorkCategoryId, number>;

  for (const item of items) {
    if (item.status !== "OPEN") continue;
    const bucket = assignInboxWorkCategory(item);
    byId[bucket] += 1;
  }

  return byId;
}

export type InboxSidebarSelection = InboxWorkCategoryId | typeof INBOX_SIDEBAR_LEGACY_OPEN;

/** Sidebar display order (importance), excluding legacy key. */
export const INBOX_SIDEBAR_CATEGORY_OPTIONS: readonly {
  id: InboxWorkCategoryId;
  label: string;
}[] = [
  { id: "needs_action", label: "דורש פעולה" },
  { id: "drafts_ready", label: "טיוטות מוכנות" },
  { id: "handoff", label: "עבר לנציג" },
  { id: "bot_in_progress", label: "בוט בתהליך" },
  { id: "hot_leads", label: "לידים חמים" },
  { id: "follow_up", label: "מעקב" },
  { id: "completed", label: "הושלמו" },
  { id: "active", label: "פעילות / ללא דחיפות" },
  { id: "closed", label: "סגורות" },
] as const;

const FOLLOW_UP_SIGNALS: ReadonlySet<InboxItemViewModel["primarySignal"]> = new Set([
  "needs_followup",
  "cooling",
  "customer_waiting",
  "stalled_quote",
]);

const FOLLOW_UP_NBA: ReadonlySet<NonNullable<InboxItemViewModel["nextBestAction"]>["kind"]> =
  new Set(["respond_waiting_customer", "review_stalled_quote", "follow_up_or_warm"]);

const HOT_LEAD_NBA: ReadonlySet<NonNullable<InboxItemViewModel["nextBestAction"]>["kind"]> =
  new Set(["engage_hot_thread", "nurture_fresh_lead"]);

/**
 * Deterministic primary bucket for an OPEN inbox row (mutually exclusive).
 * Call only for `item.status === "OPEN"`; otherwise returns `"active"`.
 */
export function assignInboxWorkCategory(item: InboxItemViewModel): InboxWorkCategoryBucket {
  if (item.status !== "OPEN") {
    return "active";
  }

  const nba = item.nextBestAction?.kind;

  if (
    item.needsHumanAttention === true ||
    item.signalSeverity === "critical" ||
    nba === "immediate_attention"
  ) {
    return "needs_action";
  }

  if (item.botFlowStatus === "HANDOFF" || nba === "agent_handoff") {
    return "handoff";
  }

  if (item.hasPendingSuggestion === true || nba === "send_ready_draft") {
    return "drafts_ready";
  }

  if (item.botFlowStatus === "IN_PROGRESS") {
    return "bot_in_progress";
  }

  if (
    item.temperatureBucket === "hot" &&
    (item.primarySignal === "fresh_lead" ||
      item.primarySignal === "hot_negotiation" ||
      (nba !== undefined && HOT_LEAD_NBA.has(nba)))
  ) {
    return "hot_leads";
  }

  if (FOLLOW_UP_SIGNALS.has(item.primarySignal) || (nba !== undefined && FOLLOW_UP_NBA.has(nba))) {
    return "follow_up";
  }

  if (item.botFlowStatus === "COMPLETED") {
    return "completed";
  }

  return "active";
}

export function matchesInboxWorkCategory(
  item: InboxItemViewModel,
  category: InboxWorkCategoryId
): boolean {
  if (category === "closed") {
    return item.status === "CLOSED";
  }
  if (item.status !== "OPEN") {
    return false;
  }
  return assignInboxWorkCategory(item) === category;
}
