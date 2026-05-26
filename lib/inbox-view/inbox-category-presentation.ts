import type { InboxItemViewModel } from "@/lib/inbox-view/inbox-item.types";
import {
  assignInboxWorkCategory,
  INBOX_SIDEBAR_CATEGORY_OPTIONS,
  type InboxWorkCategoryId,
} from "@/lib/inbox-view/work-category";

export type CategoryUrgencyLevel = 0 | 1 | 2 | 3;

export type InboxCategoryVisualTone = "calm" | "notice" | "elevated" | "urgent";

export type InboxCategoryPresentationRow = {
  id: InboxWorkCategoryId;
  label: string;
  count: number;
  urgencyLevel: CategoryUrgencyLevel;
  baseIndex: number;
  /** Stable string for debugging / tests */
  sortKey: string;
  visualTone: InboxCategoryVisualTone;
};

function toneFromUrgency(level: CategoryUrgencyLevel): InboxCategoryVisualTone {
  if (level >= 3) return "urgent";
  if (level === 2) return "elevated";
  if (level === 1) return "notice";
  return "calm";
}

/** Per open conversation: first matching tier wins (3 = most urgent). */
export function conversationUrgencyLevel(item: InboxItemViewModel): CategoryUrgencyLevel {
  if (item.status !== "OPEN") {
    return 0;
  }

  if (
    item.needsHumanAttention === true ||
    item.signalSeverity === "critical" ||
    item.nextBestAction?.kind === "immediate_attention"
  ) {
    return 3;
  }

  if (item.nextBestAction?.severity === "high" || item.signalSeverity === "high") {
    return 2;
  }

  if (
    (item.waitingMinutes !== null && item.waitingMinutes >= 60) ||
    item.temperatureBucket === "hot"
  ) {
    return 1;
  }

  return 0;
}

function maxUrgencyInOpenCategory(
  categoryId: InboxWorkCategoryId,
  items: readonly InboxItemViewModel[]
): CategoryUrgencyLevel {
  let max: CategoryUrgencyLevel = 0;
  for (const item of items) {
    if (item.status !== "OPEN") continue;
    if (assignInboxWorkCategory(item) !== categoryId) continue;
    const u = conversationUrgencyLevel(item);
    if (u > max) max = u;
  }
  return max;
}

function comparePresentationRows(
  a: InboxCategoryPresentationRow,
  b: InboxCategoryPresentationRow
): number {
  const emptyA = a.count === 0 ? 1 : 0;
  const emptyB = b.count === 0 ? 1 : 0;
  if (emptyA !== emptyB) {
    return emptyA - emptyB;
  }
  if (emptyA === 0) {
    if (b.urgencyLevel !== a.urgencyLevel) {
      return b.urgencyLevel - a.urgencyLevel;
    }
    return a.baseIndex - b.baseIndex;
  }
  return a.baseIndex - b.baseIndex;
}

/**
 * Build ordered category rows for the smart inbox categories screen.
 * `closed` always has urgency 0. Empty categories sink to the bottom (by base order).
 */
export function buildSmartInboxCategoryRows(
  items: readonly InboxItemViewModel[],
  countsById: Record<InboxWorkCategoryId, number>
): InboxCategoryPresentationRow[] {
  const rows: InboxCategoryPresentationRow[] = INBOX_SIDEBAR_CATEGORY_OPTIONS.map((opt, baseIndex) => {
    const count = countsById[opt.id] ?? 0;
    const urgencyLevel: CategoryUrgencyLevel =
      opt.id === "closed" ? 0 : maxUrgencyInOpenCategory(opt.id, items);
    const empty = count === 0 ? 1 : 0;
    const sortKey = `${empty}:${-urgencyLevel}:${baseIndex}`;
    return {
      id: opt.id,
      label: opt.label,
      count,
      urgencyLevel,
      baseIndex,
      sortKey,
      visualTone: toneFromUrgency(urgencyLevel),
    };
  });

  rows.sort(comparePresentationRows);
  return rows;
}
