import type { InboxWorkCategoryId } from "@/lib/inbox-view/work-category";
import type { MessageKey } from "@/lib/i18n/translate";

export type InboxCategoryVisual = {
  id: InboxWorkCategoryId;
  /** Dictionary keys — the list translates them (`inbox.categoryVisuals.*`). */
  labelKey: MessageKey;
  subtitleKey: MessageKey;
  icon: string;
  iconBg: string;
  iconColor: string;
};

/** Fixed category order + copy aligned to product architecture mock. */
export const INBOX_CATEGORY_VISUALS: readonly InboxCategoryVisual[] = [
  {
    id: "needs_action",
    labelKey: "inbox.categoryVisuals.needs_action.label",
    subtitleKey: "inbox.categoryVisuals.needs_action.subtitle",
    icon: "⚡",
    iconBg: "var(--dz-danger-bg)",
    iconColor: "var(--dz-danger)",
  },
  {
    id: "hot_leads",
    labelKey: "inbox.categoryVisuals.hot_leads.label",
    subtitleKey: "inbox.categoryVisuals.hot_leads.subtitle",
    icon: "🔥",
    iconBg: "var(--dz-warning-bg)",
    iconColor: "var(--dz-warning)",
  },
  {
    id: "active",
    labelKey: "inbox.categoryVisuals.active.label",
    subtitleKey: "inbox.categoryVisuals.active.subtitle",
    icon: "⏳",
    iconBg: "var(--dz-warning-bg)",
    iconColor: "var(--dz-warning)",
  },
  {
    id: "bot_in_progress",
    labelKey: "inbox.categoryVisuals.bot_in_progress.label",
    subtitleKey: "inbox.categoryVisuals.bot_in_progress.subtitle",
    icon: "📝",
    iconBg: "var(--dz-success-bg)",
    iconColor: "var(--dz-success)",
  },
  {
    id: "follow_up",
    labelKey: "inbox.categoryVisuals.follow_up.label",
    subtitleKey: "inbox.categoryVisuals.follow_up.subtitle",
    icon: "🔔",
    iconBg: "var(--dz-info-bg)",
    iconColor: "var(--dz-info)",
  },
  {
    id: "handoff",
    labelKey: "inbox.categoryVisuals.handoff.label",
    subtitleKey: "inbox.categoryVisuals.handoff.subtitle",
    icon: "→",
    iconBg: "var(--dz-surface-muted)",
    iconColor: "var(--dz-text-muted)",
  },
  {
    id: "drafts_ready",
    labelKey: "inbox.categoryVisuals.drafts_ready.label",
    subtitleKey: "inbox.categoryVisuals.drafts_ready.subtitle",
    icon: "✍️",
    iconBg: "var(--dz-brand-soft)",
    iconColor: "var(--dz-brand)",
  },
  {
    id: "closed",
    labelKey: "inbox.categoryVisuals.closed.label",
    subtitleKey: "inbox.categoryVisuals.closed.subtitle",
    icon: "✓",
    iconBg: "var(--dz-success-bg-soft)",
    iconColor: "var(--dz-success)",
  },
] as const;

export function inboxCategoryVisual(id: InboxWorkCategoryId): InboxCategoryVisual | undefined {
  return INBOX_CATEGORY_VISUALS.find((row) => row.id === id);
}

export const INBOX_SURFACE = {
  pageBg: "var(--dz-surface-muted)",
  cardBg: "var(--dz-surface)",
  chatBg: "var(--dz-surface-muted)",
  border: "rgba(52, 60, 50, 0.08)",
  shadow: "0 1px 3px rgba(52, 60, 50, 0.06)",
  shadowActive: "0 4px 14px rgba(36, 105, 102, 0.12)",
  purple: "var(--dz-brand)",
  purpleSoft: "var(--dz-brand-soft)",
  greenBubble: "#dcf8c6",
  greenBubbleBorder: "rgba(30, 106, 74, 0.18)",
} as const;
