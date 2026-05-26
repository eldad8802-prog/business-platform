import React from "react";
import Link from "next/link";
import type { InboxItemViewModel } from "@/lib/inbox-view/inbox-item.types";
import { resolveConversationDisplayTitle } from "@/lib/inbox-view/conversation-display-title";
import {
  INBOX_SIDEBAR_CATEGORY_OPTIONS,
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

function formatWaiting(waitingMinutes: number | null): string | null {
  if (waitingMinutes === null || waitingMinutes <= 0) return null;
  if (waitingMinutes < 60) return `${waitingMinutes} דק׳`;
  return `${Math.floor(waitingMinutes / 60)} שע׳`;
}

function formatListTime(iso: string | undefined | null): string {
  if (!iso) return "היום";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "היום";
  return date.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
}

function resolveTitle(item: InboxItemViewModel): string {
  return resolveConversationDisplayTitle(item);
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
  count: number
): CategoryNavRow {
  return {
    id: visual.id,
    label: visual.label,
    subtitle: visual.subtitle,
    icon: visual.icon,
    iconBg: visual.iconBg,
    iconColor: visual.iconColor,
    count,
  };
}

function categoryNavRowForBucket(
  id: InboxWorkCategoryId,
  count: number
): CategoryNavRow {
  const visual = inboxCategoryVisual(id);
  if (visual) return categoryNavRowFromVisual(visual, count);
  const opt = INBOX_SIDEBAR_CATEGORY_OPTIONS.find((o) => o.id === id);
  return {
    id,
    label: opt?.label ?? id,
    subtitle: count > 0 ? `${count} שיחות` : "אין שיחות בקטגוריה",
    icon: "•",
    iconBg: "#f1f5f9",
    iconColor: "#64748b",
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
      bg: "rgba(255, 241, 242, 0.8)",
      border: "rgba(220, 38, 38, 0.22)",
      text: "#991b1b",
      avatarBg: "rgba(254, 226, 226, 0.9)",
      avatarText: "#dc2626",
    };
  if (level === 2)
    return {
      bg: "rgba(255, 251, 235, 0.8)",
      border: "rgba(217, 119, 6, 0.22)",
      text: "#92400e",
      avatarBg: "rgba(254, 243, 199, 0.9)",
      avatarText: "#d97706",
    };
  if (level === 1)
    return {
      bg: "rgba(239, 246, 255, 0.8)",
      border: "rgba(37, 99, 235, 0.18)",
      text: "#1e40af",
      avatarBg: "rgba(219, 234, 254, 0.9)",
      avatarText: "#2563eb",
    };
  return {
    bg: "#ffffff",
    border: "rgba(15, 23, 42, 0.07)",
    text: "#374151",
    avatarBg: "rgba(241, 245, 249, 0.9)",
    avatarText: "#475569",
  };
}

const CATEGORY_ICON: Record<InboxWorkCategoryId, string> = {
  needs_action: "⚡",
  drafts_ready: "✍️",
  handoff: "🤝",
  bot_in_progress: "🤖",
  hot_leads: "🔥",
  follow_up: "🔔",
  completed: "✓",
  active: "💬",
  closed: "🔒",
};

const CATEGORY_HELPER: Record<InboxWorkCategoryId, string> = {
  needs_action: "לקוחות שמחכים ממך לתשובה או החלטה",
  drafts_ready: "אפשר לסיים מהר בלי להתחיל מאפס",
  handoff: "סדרת הטיוטות הסתיימה — אתה ממשיך",
  bot_in_progress: "טיוטות מוכנות — אתה שולח ללקוח",
  hot_leads: "פניות עם סיכוי גבוה להפוך לעסקה",
  follow_up: "שיחות שלא כדאי לתת להן להיעלם",
  completed: "טופלו. נשאר רק להיות רגוע שהכול מתועד",
  active: "פתוחות, אבל אין משהו דחוף לעשות עכשיו",
  closed: "שיחות שטופלו ונשמרות להיסטוריה",
};

const CATEGORY_DISPLAY_LABEL: Partial<Record<InboxWorkCategoryId, string>> = {
  needs_action: "דחוף · דורש טיפול",
  drafts_ready: "טיוטות מוכנות",
  handoff: "עבר לנציג",
  bot_in_progress: "בטיפול",
  hot_leads: "חם · לידים",
  follow_up: "מעקב",
  completed: "טופל",
  active: "ממתין ללקוח",
  closed: "סגור",
};

function emptyMessage(selected: InboxSidebarSelection): string {
  if (selected === INBOX_SIDEBAR_LEGACY_OPEN) return "אין שיחות פתוחות כרגע";
  const byId: Record<InboxWorkCategoryId, string> = {
    needs_action: "אין כרגע לקוחות שמחכים לך. אפשר לנשום.",
    drafts_ready: "אין כרגע טיוטות מוכנות לשליחה.",
    handoff: "אין שיחות שמחכות לך אחרי סיום הטיוטות.",
    bot_in_progress: "אין שיחות עם טיוטות פתיחה ממתינות.",
    hot_leads: "אין כרגע לידים חמים שדורשים תשומת לב.",
    follow_up: "אין כרגע מעקבים פתוחים.",
    completed: "אין שיחות שטופלו בקטגוריה הזו.",
    active: "הכול בשליטה בקטגוריה הזו.",
    closed: "אין שיחות סגורות להצגה.",
  };
  return byId[selected as InboxWorkCategoryId] ?? "אין שיחות בקטגוריה זו כרגע";
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

function statusBadgeForItem(item: InboxItemViewModel): {
  label: string;
  bg: string;
  color: string;
  border: string;
} {
  if (item.businessSituation) {
    const byKind: Record<string, { bg: string; color: string; border: string }> = {
      CUSTOMER_WAITING: {
        bg: "#fee2e2",
        color: "#dc2626",
        border: "rgba(220, 38, 38, 0.18)",
      },
      DRAFT_READY: {
        bg: "#eef2ff",
        color: "#4f46e5",
        border: "rgba(79, 70, 229, 0.18)",
      },
      BOT_HANDOFF: {
        bg: "#fff7ed",
        color: "#ea580c",
        border: "rgba(234, 88, 12, 0.18)",
      },
      BOT_COLLECTING: {
        bg: "#ecfdf5",
        color: "#16a34a",
        border: "rgba(22, 163, 74, 0.18)",
      },
      QUOTE_WAITING: {
        bg: "#fef3c7",
        color: "#b45309",
        border: "rgba(180, 83, 9, 0.16)",
      },
      FOLLOW_UP_DUE: {
        bg: "#f5f3ff",
        color: "#6d28d9",
        border: "rgba(109, 40, 217, 0.16)",
      },
      WAITING_ON_CUSTOMER: {
        bg: "#eff6ff",
        color: "#2563eb",
        border: "rgba(37, 99, 235, 0.16)",
      },
      HOT_OPPORTUNITY: {
        bg: "#fff7ed",
        color: "#ea580c",
        border: "rgba(234, 88, 12, 0.18)",
      },
      NEW_LEAD: {
        bg: "#ecfeff",
        color: "#0891b2",
        border: "rgba(8, 145, 178, 0.16)",
      },
      ACTIVE: {
        bg: "#eff6ff",
        color: "#2563eb",
        border: "rgba(37, 99, 235, 0.16)",
      },
      CLOSED: {
        bg: "#f1f5f9",
        color: "#64748b",
        border: "rgba(100, 116, 139, 0.16)",
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
      label: "מחכה לך",
      bg: "#fee2e2",
      color: "#dc2626",
      border: "rgba(220, 38, 38, 0.18)",
    };
  }

  if (item.hasPendingSuggestion || item.nextBestAction?.kind === "send_ready_draft") {
    return {
      label: "טיוטה מוכנה",
      bg: "#eef2ff",
      color: "#4f46e5",
      border: "rgba(79, 70, 229, 0.18)",
    };
  }

  if (item.botFlowStatus === "IN_PROGRESS") {
    return {
      label: "טיוטה מוכנה",
      bg: "#ecfdf5",
      color: "#16a34a",
      border: "rgba(22, 163, 74, 0.18)",
    };
  }

  if (item.temperatureBucket === "hot") {
    return {
      label: "סיכוי טוב",
      bg: "#fff7ed",
      color: "#ea580c",
      border: "rgba(234, 88, 12, 0.18)",
    };
  }

  return {
    label: "במעקב",
    bg: "#eff6ff",
    color: "#2563eb",
    border: "rgba(37, 99, 235, 0.16)",
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

  const isDesktopLayout = layoutMode === "desktop";

  const shell: React.CSSProperties = {
    width: "100%",
    maxWidth: isDesktopLayout ? "none" : 720,
    marginLeft: "auto",
    marginRight: "auto",
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
        label: "כל השיחות",
        subtitle: "כל השיחות הפתוחות",
        icon: "💬",
        iconBg: "#eef2ff",
        iconColor: "#4f46e5",
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
        bucketRows.push(categoryNavRowForBucket(id, byId[id] ?? 0));
      }

      for (const visual of INBOX_CATEGORY_VISUALS) {
        if (seen.has(visual.id) || visual.id === "closed") continue;
        seen.add(visual.id);
        bucketRows.push(categoryNavRowForBucket(visual.id, byId[visual.id] ?? 0));
      }

      if (!seen.has("completed") && (byId.completed ?? 0) > 0) {
        bucketRows.push(categoryNavRowForBucket("completed", byId.completed ?? 0));
      }

      const closedRow = categoryNavRowForBucket("closed", byId.closed ?? 0);
      categoryRows = [allOpenRow, ...bucketRows, closedRow];
    } else {
      categoryRows = [
        {
          id: INBOX_SIDEBAR_LEGACY_OPEN,
          label: "פתוחות",
          subtitle: "כל השיחות הפתוחות",
          icon: "💬",
          iconBg: "#f1f5f9",
          iconColor: "#64748b",
          count: sidebarCounts.open,
        },
        {
          id: "closed",
          label: "נסגרו",
          subtitle: "היסטוריה",
          icon: "✓",
          iconBg: "#ecfdf5",
          iconColor: "#16a34a",
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
        ? "אין כרגע שיחות שממתינות לך"
        : openWaitingCount === 1
          ? "יש לך שיחה אחת שממתינה לך"
          : `יש לך ${openWaitingCount} שיחות שממתינות לך`;

    return (
      <div
        dir="rtl"
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
              color: "#111827",
              margin: "0 0 6px",
              lineHeight: 1.2,
            }}
          >
            סדר היום שלך
          </h1>
          <div style={{ fontSize: 14, color: "#64748b", fontWeight: 600, lineHeight: 1.45 }}>
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
            aria-label="קטגוריות עבודה"
            style={{ display: "flex", flexDirection: "column", gap: 8 }}
          >
            {categoryRows.map((row) => {
              const dimmed = row.count === 0;

              return (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => onChangeWorkCategory(row.id)}
                  aria-label={`${row.label}, ${row.count} שיחות`}
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
                    textAlign: "right",
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
                    <div style={{ fontSize: 15, fontWeight: 800, color: "#111827" }}>
                      {row.label}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 500,
                        color: "#94a3b8",
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
                        color: dimmed ? "#cbd5e1" : "#64748b",
                      }}
                    >
                      {row.count}
                    </span>
                    <span style={{ color: "#cbd5e1", fontSize: 18, fontWeight: 700 }}>‹</span>
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
                  color: "#6b7280",
                  textDecoration: "none",
                }}
              >
                הגדרות הבוט
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

  const selectedLabel =
    selectedVisual?.label ??
    (selectedWorkCategory === INBOX_SIDEBAR_LEGACY_OPEN ? "כל השיחות" : "נסגרו");

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const filteredConversations =
    normalizedSearch.length === 0
      ? conversations
      : conversations.filter((conversation) => {
          const item = items?.find((i) => i.conversationId === conversation.id);
          const title = item ? resolveTitle(item) : "לקוח חדש";
          const snippet = item?.lastMessage?.snippet?.trim() ?? "";
          const haystack = `${title} ${snippet}`.toLowerCase();
          return haystack.includes(normalizedSearch);
        });

  return (
    <div dir="rtl" style={{ ...shell, minHeight: isDesktopLayout ? "auto" : "100vh", position: "relative" }}>
      {!isDesktopLayout && (
        <div
          style={{
            background: "#ffffff",
            borderBottom: "1px solid rgba(15, 23, 42, 0.07)",
            padding: "12px 16px 12px",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <button
            type="button"
            onClick={() => onBackFromList?.()}
            style={{
              background: "rgba(15, 23, 42, 0.05)",
              border: "none",
              borderRadius: 12,
              padding: "8px 14px",
              fontSize: 13,
              fontWeight: 700,
              color: "#374151",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            →
          </button>
          <div>
            <div
              style={{ fontSize: 17, fontWeight: 900, color: "#111827", lineHeight: 1.2 }}
            >
              {selectedLabel}
            </div>
            <div style={{ fontSize: 12, color: "#9ca3af", fontWeight: 600, marginTop: 2 }}>
              {filteredConversations.length > 0
                ? `${filteredConversations.length} שיחות`
                : "אין כאן משהו לטפל בו"}
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
              color: "#9ca3af",
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            {emptyMessage(selectedWorkCategory)}
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
                    background: isActive ? "#eef2ff" : "#ffffff",
                    border: isActive
                      ? "1px solid rgba(99, 102, 241, 0.35)"
                      : "1px solid rgba(15, 23, 42, 0.07)",
                    borderRadius: 16,
                    padding: isDesktopLayout ? "13px 14px" : "14px 16px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    textAlign: "right",
                    width: "100%",
                    boxShadow: "0 2px 8px rgba(15, 23, 42, 0.04)",
                    WebkitTapHighlightColor: "transparent",
                  }}
                >
                  <div
                    aria-hidden
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 13,
                      background: "rgba(241, 245, 249, 0.9)",
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
                    <div style={{ fontWeight: 800, color: "#111827", fontSize: 15 }}>
                      לקוח חדש
                    </div>
                    <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 2 }}>
                      {conversation.channel}
                    </div>
                  </div>
                </button>
              );
            }

            const title = resolveTitle(item);
            const snippet = item.lastMessage?.snippet?.trim() ?? "";
            const waitingLine = formatWaiting(item.waitingMinutes);
            const statusBadge = statusBadgeForItem(item);

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
                    ? `1.5px solid rgba(99, 102, 241, 0.35)`
                    : `1px solid ${INBOX_SURFACE.border}`,
                  borderRadius: 16,
                  padding: isDesktopLayout ? "12px 14px" : "12px 14px",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  textAlign: "right",
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
                    background: isActive ? "#ddd6fe" : avatarColors.avatarBg,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 14,
                    fontWeight: 900,
                    color: isActive ? "#5b21b6" : avatarColors.avatarText,
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
                        color: "#111827",
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
                        color: "#94a3b8",
                        flexShrink: 0,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {waitingLine ?? formatListTime(item.lastMessage?.at)}
                    </span>
                  </div>

                  {/* Snippet */}
                  {snippet ? (
                    <div
                      style={{
                        fontSize: 13,
                        color: "#6b7280",
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
          aria-label="צור שיחה חדשה"
          style={{
            position: "fixed",
            left: 16,
            bottom: 24,
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            borderRadius: 999,
            border: "none",
            background: INBOX_SURFACE.purple,
            color: "#ffffff",
            fontSize: 14,
            fontWeight: 800,
            padding: "14px 20px",
            cursor: "pointer",
            boxShadow: "0 8px 24px rgba(99, 102, 241, 0.35)",
            zIndex: 20,
          }}
        >
          <span style={{ fontSize: 20, lineHeight: 1 }}>+</span>
          <span>צור שיחה חדשה</span>
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
