import React from "react";
import Link from "next/link";
import BackButton from "@/components/ui/back-button";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey, Translator } from "@/lib/i18n/translate";
import type { InboxItemViewModel } from "@/lib/inbox-view/inbox-item.types";
import { resolveConversationDisplayTitle } from "@/lib/inbox-view/conversation-display-title";
import {
  INBOX_SIDEBAR_LEGACY_OPEN,
  type InboxSidebarSelection,
  type InboxWorkCategoryId,
} from "@/lib/inbox-view/work-category";
import type { InboxCategoryPresentationRow } from "@/lib/inbox-view/inbox-category-presentation";
import {
  INBOX_CATEGORY_VISUALS,
  INBOX_SURFACE,
  inboxCategoryVisual,
} from "@/components/inbox/inbox-ui-tokens";

type Conversation = {
  id: number;
  channel: string;
  status: string;
  currentStage: string;
  startedAt: string;
};

const QUIET_SIGNALS: ReadonlySet<InboxItemViewModel["primarySignal"]> = new Set([
  "neutral",
  "fresh_lead",
]);

function formatWaiting(waitingMinutes: number | null, t: Translator): string | null {
  if (waitingMinutes === null || waitingMinutes <= 0) return null;
  if (waitingMinutes < 60) return t("inbox.list.waitingMinutes", { count: waitingMinutes });
  return t("inbox.list.waitingHours", { count: Math.floor(waitingMinutes / 60) });
}

function formatListTime(
  iso: string | undefined | null,
  t: Translator,
  formatTime: (date: Date) => string
): string {
  if (!iso) return t("inbox.list.today");
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return t("inbox.list.today");
  return formatTime(date);
}

/** Work-category name (mirrors lib/inbox-view INBOX_SIDEBAR_CATEGORY_OPTIONS, translated). */
function workCategoryLabel(id: InboxWorkCategoryId, t: Translator): string {
  return t(`inbox.workCategories.${id}` as MessageKey);
}

function conversationsCount(count: number, t: Translator): string {
  return count === 1
    ? t("inbox.list.conversationsCountOne", { count })
    : t("inbox.list.conversationsCount", { count });
}

function resolveTitle(item: InboxItemViewModel, t: Translator): string {
  return resolveConversationDisplayTitle(item, t);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

type CategoryNavRow = {
  id: InboxSidebarSelection;
  label: string;
  subtitle: string;
  icon: string;
  iconBg: string;
  iconColor: string;
  count: number;
};

function categoryNavRowFromVisual(
  visual: (typeof INBOX_CATEGORY_VISUALS)[number],
  count: number,
  t: Translator
): CategoryNavRow {
  return {
    id: visual.id,
    label: t(visual.labelKey),
    subtitle: t(visual.subtitleKey),
    icon: visual.icon,
    iconBg: visual.iconBg,
    iconColor: visual.iconColor,
    count,
  };
}

function categoryNavRowForBucket(
  id: InboxWorkCategoryId,
  count: number,
  t: Translator
): CategoryNavRow {
  const visual = inboxCategoryVisual(id);
  if (visual) return categoryNavRowFromVisual(visual, count, t);
  return {
    id,
    label: workCategoryLabel(id, t),
    subtitle: count > 0 ? conversationsCount(count, t) : t("inbox.list.categoryEmpty"),
    icon: "•",
    iconBg: "var(--dz-surface-muted)",
    iconColor: "var(--dz-text-muted)",
    count,
  };
}

function urgencyToColors(level: 0 | 1 | 2 | 3): {
  bg: string;
  border: string;
  text: string;
  avatarBg: string;
  avatarText: string;
} {
  if (level >= 3)
    return {
      bg: "rgba(247, 234, 230, 0.8)",
      border: "rgba(155, 70, 52, 0.22)",
      text: "var(--dz-danger)",
      avatarBg: "rgba(247, 234, 230, 0.9)",
      avatarText: "var(--dz-danger)",
    };
  if (level === 2)
    return {
      bg: "rgba(246, 239, 226, 0.8)",
      border: "rgba(129, 90, 50, 0.22)",
      text: "var(--dz-warning)",
      avatarBg: "rgba(246, 239, 226, 0.9)",
      avatarText: "var(--dz-warning)",
    };
  if (level === 1)
    return {
      bg: "rgba(231, 240, 246, 0.8)",
      border: "rgba(43, 90, 133, 0.18)",
      text: "var(--dz-info)",
      avatarBg: "rgba(231, 240, 246, 0.9)",
      avatarText: "var(--dz-info)",
    };
  return {
    bg: "var(--dz-surface)",
    border: "rgba(52, 60, 50, 0.07)",
    text: "var(--dz-text-secondary)",
    avatarBg: "rgba(239, 241, 235, 0.9)",
    avatarText: "var(--dz-text-secondary)",
  };
}

function emptyMessage(selected: InboxSidebarSelection, t: Translator): string {
  if (selected === INBOX_SIDEBAR_LEGACY_OPEN) return t("inbox.list.empty.allOpen");
  const byId: Record<InboxWorkCategoryId, MessageKey> = {
    needs_action: "inbox.list.empty.needs_action",
    drafts_ready: "inbox.list.empty.drafts_ready",
    handoff: "inbox.list.empty.handoff",
    bot_in_progress: "inbox.list.empty.bot_in_progress",
    hot_leads: "inbox.list.empty.hot_leads",
    follow_up: "inbox.list.empty.follow_up",
    completed: "inbox.list.empty.completed",
    active: "inbox.list.empty.active",
    closed: "inbox.list.empty.closed",
  };
  const key = byId[selected as InboxWorkCategoryId];
  return key ? t(key) : t("inbox.list.empty.fallback");
}

function countForCategory(
  sidebarCounts:
    | { kind: "smart"; byId: Record<InboxWorkCategoryId, number> }
    | { kind: "legacy"; open: number; closed: number },
  category: InboxSidebarSelection
): number {
  if (sidebarCounts.kind === "legacy") {
    return category === "closed" ? sidebarCounts.closed : sidebarCounts.open;
  }

  if (category === INBOX_SIDEBAR_LEGACY_OPEN) {
    return Object.entries(sidebarCounts.byId).reduce(
      (sum, [key, value]) => (key === "closed" ? sum : sum + value),
      0
    );
  }

  return sidebarCounts.byId[category as InboxWorkCategoryId] ?? 0;
}

function statusBadgeForItem(item: InboxItemViewModel, t: Translator): {
  label: string;
  bg: string;
  color: string;
  border: string;
} {
  if (item.businessSituation) {
    const byKind: Record<string, { bg: string; color: string; border: string }> = {
      CUSTOMER_WAITING: {
        bg: "var(--dz-danger-bg)",
        color: "var(--dz-danger)",
        border: "rgba(155, 70, 52, 0.18)",
      },
      DRAFT_READY: {
        bg: "var(--dz-brand-soft)",
        color: "var(--dz-brand)",
        border: "rgba(36, 105, 102, 0.18)",
      },
      BOT_HANDOFF: {
        bg: "var(--dz-warning-bg-soft)",
        color: "var(--dz-warning)",
        border: "rgba(129, 90, 50, 0.18)",
      },
      BOT_COLLECTING: {
        bg: "var(--dz-success-bg-soft)",
        color: "var(--dz-success)",
        border: "rgba(30, 106, 74, 0.18)",
      },
      QUOTE_WAITING: {
        bg: "var(--dz-warning-bg)",
        color: "var(--dz-warning)",
        border: "rgba(129, 90, 50, 0.16)",
      },
      FOLLOW_UP_DUE: {
        bg: "var(--dz-brand-soft)",
        color: "var(--dz-brand)",
        border: "rgba(36, 105, 102, 0.16)",
      },
      WAITING_ON_CUSTOMER: {
        bg: "var(--dz-info-bg-soft)",
        color: "var(--dz-info)",
        border: "rgba(43, 90, 133, 0.16)",
      },
      HOT_OPPORTUNITY: {
        bg: "var(--dz-warning-bg-soft)",
        color: "var(--dz-warning)",
        border: "rgba(129, 90, 50, 0.18)",
      },
      NEW_LEAD: {
        bg: "var(--dz-info-bg-soft)",
        color: "var(--dz-info)",
        border: "rgba(43, 90, 133, 0.16)",
      },
      ACTIVE: {
        bg: "var(--dz-info-bg-soft)",
        color: "var(--dz-info)",
        border: "rgba(43, 90, 133, 0.16)",
      },
      CLOSED: {
        bg: "var(--dz-surface-muted)",
        color: "var(--dz-text-muted)",
        border: "rgba(102, 111, 101, 0.16)",
      },
    };
    const colors = byKind[item.businessSituation.kind] ?? byKind.ACTIVE;
    return {
      label: item.businessSituation.shortLabel,
      ...colors,
    };
  }

  if (item.needsHumanAttention || item.nextBestAction?.kind === "immediate_attention") {
    return {
      label: t("inbox.list.badge.waitingForYou"),
      bg: "var(--dz-danger-bg)",
      color: "var(--dz-danger)",
      border: "rgba(155, 70, 52, 0.18)",
    };
  }

  if (item.hasPendingSuggestion || item.nextBestAction?.kind === "send_ready_draft") {
    return {
      label: t("inbox.list.badge.draftReady"),
      bg: "var(--dz-brand-soft)",
      color: "var(--dz-brand)",
      border: "rgba(36, 105, 102, 0.18)",
    };
  }

  if (item.botFlowStatus === "IN_PROGRESS") {
    return {
      label: t("inbox.list.badge.draftReady"),
      bg: "var(--dz-success-bg-soft)",
      color: "var(--dz-success)",
      border: "rgba(30, 106, 74, 0.18)",
    };
  }

  if (item.temperatureBucket === "hot") {
    return {
      label: t("inbox.list.badge.goodChance"),
      bg: "var(--dz-warning-bg-soft)",
      color: "var(--dz-warning)",
      border: "rgba(129, 90, 50, 0.18)",
    };
  }

  return {
    label: t("inbox.list.badge.tracking"),
    bg: "var(--dz-info-bg-soft)",
    color: "var(--dz-info)",
    border: "rgba(43, 90, 133, 0.16)",
  };
}

export type InboxListPhase = "categories" | "conversation_list";

export function ConversationList(props: {
  listPhase: InboxListPhase;
  isMobile: boolean;
  layoutMode?: "flow" | "desktop";
  selectedWorkCategory: InboxSidebarSelection;
  onChangeWorkCategory: (category: InboxSidebarSelection) => void;
  onBackFromList?: () => void;
  smartCategoryRows?: InboxCategoryPresentationRow[];
  sidebarCounts:
    | { kind: "smart"; byId: Record<InboxWorkCategoryId, number> }
    | { kind: "legacy"; open: number; closed: number };
  onCreateConversation: () => void;
  conversations: Conversation[];
  items?: InboxItemViewModel[];
  dailyContext?: { urgentCount: number; newSinceYesterday: number } | null;
  activeConversationId: number | null;
  onSelectConversation: (id: number) => void;
  searchQuery?: string;
  onSearchQueryChange?: (value: string) => void;
  getStageLabel: (stage: string | null | undefined) => string;
  styles: {
    softButtonStyle: React.CSSProperties;
    accentButtonStyle: React.CSSProperties;
    warmButtonStyle: React.CSSProperties;
  };
}) {
  const {
    listPhase,
    layoutMode = "flow",
    selectedWorkCategory,
    onChangeWorkCategory,
    onBackFromList,
    smartCategoryRows,
    sidebarCounts,
    onCreateConversation,
    conversations,
    items,
    dailyContext,
    activeConversationId,
    onSelectConversation,
    searchQuery = "",
    onSearchQueryChange,
  } = props;

  const { t, formatDate } = useI18n();
  const isDesktopLayout = layoutMode === "desktop";

  const shell: React.CSSProperties = {
    width: "100%",
    maxWidth: isDesktopLayout ? "none" : 720,
    marginInline: "auto",
    minWidth: 0,
    background: INBOX_SURFACE.pageBg,
    flexShrink: 0,
    boxSizing: "border-box",
  };

  /* ── Categories screen (סדר יום) ── */
  if (listPhase === "categories") {
    let categoryRows: CategoryNavRow[] = [];

    if (sidebarCounts.kind === "smart") {
      const byId = sidebarCounts.byId;
      const openAllCount = Object.entries(byId).reduce(
        (sum, [key, value]) => (key === "closed" ? sum : sum + value),
        0
      );

      const allOpenRow: CategoryNavRow = {
        id: INBOX_SIDEBAR_LEGACY_OPEN,
        label: t("inbox.list.allConversations"),
        subtitle: t("inbox.list.allOpenConversations"),
        icon: "💬",
        iconBg: "var(--dz-brand-soft)",
        iconColor: "var(--dz-brand)",
        count: openAllCount,
      };

      const orderedBucketIds: InboxWorkCategoryId[] = smartCategoryRows
        ? smartCategoryRows
            .map((row) => row.id)
            .filter((id) => id !== "closed")
        : INBOX_CATEGORY_VISUALS.map((visual) => visual.id);

      const seen = new Set<InboxWorkCategoryId>();
      const bucketRows: CategoryNavRow[] = [];
      for (const id of orderedBucketIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        bucketRows.push(categoryNavRowForBucket(id, byId[id] ?? 0, t));
      }

      for (const visual of INBOX_CATEGORY_VISUALS) {
        if (seen.has(visual.id) || visual.id === "closed") continue;
        seen.add(visual.id);
        bucketRows.push(categoryNavRowForBucket(visual.id, byId[visual.id] ?? 0, t));
      }

      if (!seen.has("completed") && (byId.completed ?? 0) > 0) {
        bucketRows.push(categoryNavRowForBucket("completed", byId.completed ?? 0, t));
      }

      const closedRow = categoryNavRowForBucket("closed", byId.closed ?? 0, t);
      categoryRows = [allOpenRow, ...bucketRows, closedRow];
    } else {
      categoryRows = [
        {
          id: INBOX_SIDEBAR_LEGACY_OPEN,
          label: t("inbox.list.open"),
          subtitle: t("inbox.list.allOpenConversations"),
          icon: "💬",
          iconBg: "var(--dz-surface-muted)",
          iconColor: "var(--dz-text-muted)",
          count: sidebarCounts.open,
        },
        {
          id: "closed",
          label: t("inbox.list.closed"),
          subtitle: t("inbox.list.history"),
          icon: "✓",
          iconBg: "var(--dz-success-bg-soft)",
          iconColor: "var(--dz-success)",
          count: sidebarCounts.closed,
        },
      ];
    }

    const openWaitingCount =
      sidebarCounts.kind === "smart"
        ? Object.entries(sidebarCounts.byId).reduce(
            (sum, [key, value]) => (key === "closed" ? sum : sum + value),
            0
          )
        : sidebarCounts.open;

    const subtitleLine =
      openWaitingCount === 0
        ? t("inbox.list.waitingNone")
        : openWaitingCount === 1
          ? t("inbox.list.waitingOne")
          : t("inbox.list.waitingMany", { count: openWaitingCount });

    return (
      <div
        style={{
          ...shell,
          background: INBOX_SURFACE.pageBg,
          minHeight: isDesktopLayout ? "auto" : "100vh",
        }}
      >
        <div
          style={{
            background: INBOX_SURFACE.cardBg,
            borderBottom: `1px solid ${INBOX_SURFACE.border}`,
            borderRadius: isDesktopLayout ? 22 : 0,
            padding: isDesktopLayout ? "20px 18px 16px" : "24px 20px 18px",
          }}
        >
          <h1
            style={{
              fontSize: 24,
              fontWeight: 900,
              color: "var(--dz-text-primary)",
              margin: "0 0 6px",
              lineHeight: 1.2,
            }}
          >
            {t("inbox.list.agendaTitle")}
          </h1>
          <div style={{ fontSize: 14, color: "var(--dz-text-muted)", fontWeight: 600, lineHeight: 1.45 }}>
            {subtitleLine}
          </div>
        </div>

        <div
          style={{
            padding: isDesktopLayout ? "12px 0 0" : "14px 16px 0",
            maxWidth: isDesktopLayout ? "none" : 640,
            margin: "0 auto",
            boxSizing: "border-box",
          }}
        >
          <nav
            aria-label={t("inbox.list.categoriesNav")}
            style={{ display: "flex", flexDirection: "column", gap: 8 }}
          >
            {categoryRows.map((row) => {
              const dimmed = row.count === 0;

              return (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => onChangeWorkCategory(row.id)}
                  aria-label={
                    row.count === 1
                      ? t("inbox.list.categoryRowLabelOne", { label: row.label, count: row.count })
                      : t("inbox.list.categoryRowLabel", { label: row.label, count: row.count })
                  }
                  style={{
                    background: INBOX_SURFACE.cardBg,
                    border: `1px solid ${INBOX_SURFACE.border}`,
                    borderRadius: 16,
                    padding: "14px 16px",
                    boxShadow: INBOX_SURFACE.shadow,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    opacity: dimmed ? 0.55 : 1,
                    WebkitTapHighlightColor: "transparent",
                    userSelect: "none",
                    width: "100%",
                    textAlign: "start",
                  }}
                >
                  <div
                    aria-hidden
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 12,
                      background: row.iconBg,
                      color: row.iconColor,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 20,
                      flexShrink: 0,
                    }}
                  >
                    {row.icon}
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 800, color: "var(--dz-text-primary)" }}>
                      {row.label}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 500,
                        color: "var(--dz-text-muted)",
                        marginTop: 2,
                      }}
                    >
                      {row.subtitle}
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                    <span
                      style={{
                        fontSize: 14,
                        fontWeight: 800,
                        color: dimmed ? "var(--dz-text-disabled)" : "var(--dz-text-muted)",
                      }}
                    >
                      {row.count}
                    </span>
                    <span style={{ color: "var(--dz-text-disabled)", fontSize: 18, fontWeight: 700 }}>{t("inbox.list.chevronForward")}</span>
                  </div>
                </button>
              );
            })}
          </nav>

          {!isDesktopLayout && (
            <div style={{ marginTop: 20, textAlign: "center", paddingBottom: 28 }}>
              <Link
                href="/business/bot"
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--dz-text-muted)",
                  textDecoration: "none",
                }}
              >
                {t("inbox.list.botSettings")}
              </Link>
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ── Conversation list screen ── */
  const selectedVisual =
    sidebarCounts.kind === "smart" && selectedWorkCategory !== INBOX_SIDEBAR_LEGACY_OPEN
      ? inboxCategoryVisual(selectedWorkCategory as InboxWorkCategoryId)
      : undefined;

  const selectedLabel = selectedVisual
    ? t(selectedVisual.labelKey)
    : selectedWorkCategory === INBOX_SIDEBAR_LEGACY_OPEN
      ? t("inbox.list.allConversations")
      : t("inbox.list.closed");

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const filteredConversations =
    normalizedSearch.length === 0
      ? conversations
      : conversations.filter((conversation) => {
          const item = items?.find((i) => i.conversationId === conversation.id);
          const title = item ? resolveTitle(item, t) : t("inbox.list.newCustomer");
          const snippet = item?.lastMessage?.snippet?.trim() ?? "";
          const haystack = `${title} ${snippet}`.toLowerCase();
          return haystack.includes(normalizedSearch);
        });

  return (
    <div style={{ ...shell, minHeight: isDesktopLayout ? "auto" : "100vh", position: "relative" }}>
      {!isDesktopLayout && (
        <div
          style={{
            background: "var(--dz-surface)",
            borderBottom: "1px solid rgba(52, 60, 50, 0.07)",
            padding: "12px 16px 12px",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <BackButton onClick={() => onBackFromList?.()} label={t("inbox.list.backToCategories")} />
          <div>
            <div
              style={{ fontSize: 17, fontWeight: 900, color: "var(--dz-text-primary)", lineHeight: 1.2 }}
            >
              {selectedLabel}
            </div>
            <div style={{ fontSize: 12, color: "var(--dz-text-muted)", fontWeight: 600, marginTop: 2 }}>
              {filteredConversations.length > 0
                ? conversationsCount(filteredConversations.length, t)
                : t("inbox.list.nothingHere")}
            </div>
          </div>
        </div>
      )}

      {/* List */}
      <div
        style={{
          padding: isDesktopLayout ? "12px 12px 16px" : "10px 14px 40px",
          maxWidth: isDesktopLayout ? "none" : 640,
          margin: "0 auto",
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          gap: isDesktopLayout ? 8 : 9,
        }}
      >
        {filteredConversations.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: isDesktopLayout ? "34px 14px" : "48px 16px",
              color: "var(--dz-text-muted)",
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            {emptyMessage(selectedWorkCategory, t)}
          </div>
        ) : (
          filteredConversations.map((conversation) => {
            const item = items?.find((i) => i.conversationId === conversation.id);
            const isActive = activeConversationId === conversation.id;

            if (!item) {
              return (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => onSelectConversation(conversation.id)}
                  style={{
                    background: isActive ? "var(--dz-brand-soft)" : "var(--dz-surface)",
                    border: isActive
                      ? "1px solid rgba(36, 105, 102, 0.35)"
                      : "1px solid rgba(52, 60, 50, 0.07)",
                    borderRadius: 16,
                    padding: isDesktopLayout ? "13px 14px" : "14px 16px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    textAlign: "start",
                    width: "100%",
                    boxShadow: "0 2px 8px rgba(52, 60, 50, 0.04)",
                    WebkitTapHighlightColor: "transparent",
                  }}
                >
                  <div
                    aria-hidden
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 13,
                      background: "rgba(239, 241, 235, 0.9)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 18,
                      flexShrink: 0,
                    }}
                  >
                    💬
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 800, color: "var(--dz-text-primary)", fontSize: 15 }}>
                      {t("inbox.list.newCustomer")}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--dz-text-muted)", marginTop: 2 }}>
                      {conversation.channel}
                    </div>
                  </div>
                </button>
              );
            }

            const title = resolveTitle(item, t);
            const snippet = item.lastMessage?.snippet?.trim() ?? "";
            const waitingLine = formatWaiting(item.waitingMinutes, t);
            const statusBadge = statusBadgeForItem(item, t);

            const urgencyLevel: 0 | 1 | 2 | 3 =
              item.needsHumanAttention ||
              item.signalSeverity === "critical" ||
              item.nextBestAction?.kind === "immediate_attention"
                ? 3
                : item.nextBestAction?.severity === "high" ||
                    item.signalSeverity === "high"
                  ? 2
                  : item.waitingMinutes !== null && item.waitingMinutes >= 60
                    ? 1
                    : 0;

            const avatarColors = urgencyToColors(urgencyLevel);

            return (
              <button
                key={conversation.id}
                type="button"
                onClick={() => onSelectConversation(conversation.id)}
                style={{
                  background: isActive ? INBOX_SURFACE.purpleSoft : INBOX_SURFACE.cardBg,
                  border: isActive
                    ? `1.5px solid rgba(36, 105, 102, 0.35)`
                    : `1px solid ${INBOX_SURFACE.border}`,
                  borderRadius: 16,
                  padding: isDesktopLayout ? "12px 14px" : "12px 14px",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  textAlign: "start",
                  width: "100%",
                  boxShadow: isActive ? INBOX_SURFACE.shadowActive : INBOX_SURFACE.shadow,
                  WebkitTapHighlightColor: "transparent",
                  userSelect: "none",
                }}
              >
                <div
                  aria-hidden
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 999,
                    background: isActive ? "var(--dz-brand-soft-strong)" : avatarColors.avatarBg,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 14,
                    fontWeight: 900,
                    color: isActive ? "var(--dz-brand)" : avatarColors.avatarText,
                    flexShrink: 0,
                  }}
                >
                  {initials(title)}
                </div>

                {/* Content */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* Name + waiting */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      marginBottom: 3,
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 800,
                        color: "var(--dz-text-primary)",
                        fontSize: 15,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        flex: 1,
                      }}
                    >
                      {title}
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 650,
                        color: "var(--dz-text-muted)",
                        flexShrink: 0,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {waitingLine ??
                        formatListTime(item.lastMessage?.at, t, (date) => formatDate(date, "time"))}
                    </span>
                  </div>

                  {/* Snippet */}
                  {snippet ? (
                    <div
                      style={{
                        fontSize: 13,
                        color: "var(--dz-text-muted)",
                        fontWeight: 500,
                        marginBottom: 8,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {snippet}
                    </div>
                  ) : (
                    <div style={{ marginBottom: 8 }} />
                  )}

                  {/* Status — single signal */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Pill
                      label={statusBadge.label}
                      bg={statusBadge.bg}
                      border={statusBadge.border}
                      color={statusBadge.color}
                    />
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>

      {!isDesktopLayout && (
        <button
          type="button"
          onClick={onCreateConversation}
          aria-label={t("inbox.list.createConversation")}
          style={{
            position: "fixed",
            insetInlineEnd: 16,
            bottom: 24,
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            borderRadius: 999,
            border: "none",
            background: INBOX_SURFACE.purple,
            color: "var(--dz-text-on-brand)",
            fontSize: 14,
            fontWeight: 800,
            padding: "14px 20px",
            cursor: "pointer",
            boxShadow: "0 8px 24px rgba(36, 105, 102, 0.35)",
            zIndex: 20,
          }}
        >
          <span style={{ fontSize: 20, lineHeight: 1 }}>+</span>
          <span>{t("inbox.list.createConversation")}</span>
        </button>
      )}
    </div>
  );
}

function Pill({
  label,
  bg,
  border,
  color,
}: {
  label: string;
  bg: string;
  border: string;
  color: string;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        borderRadius: 999,
        background: bg,
        border: `1px solid ${border}`,
        color,
        fontSize: 11,
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}
