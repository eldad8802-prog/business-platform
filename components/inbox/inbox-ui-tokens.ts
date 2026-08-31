import type { InboxWorkCategoryId } from "@/lib/inbox-view/work-category";

export type InboxCategoryVisual = {
  id: InboxWorkCategoryId;
  label: string;
  subtitle: string;
  icon: string;
  iconBg: string;
  iconColor: string;
};

/** Fixed category order + copy aligned to product architecture mock. */
export const INBOX_CATEGORY_VISUALS: readonly InboxCategoryVisual[] = [
  {
    id: "needs_action",
    label: "דחוף - טיפול נדרש",
    subtitle: "לקוחות שמחכים לך עכשיו",
    icon: "⚡",
    iconBg: "var(--dz-danger-bg)",
    iconColor: "var(--dz-danger)",
  },
  {
    id: "hot_leads",
    label: "חם - הזדמנות",
    subtitle: "פניות עם סיכוי גבוה לעסקה",
    icon: "🔥",
    iconBg: "var(--dz-warning-bg)",
    iconColor: "var(--dz-warning)",
  },
  {
    id: "active",
    label: "ממתין לתשובת לקוח",
    subtitle: "שלחת — מחכים לתגובה",
    icon: "⏳",
    iconBg: "var(--dz-warning-bg)",
    iconColor: "var(--dz-warning)",
  },
  {
    id: "bot_in_progress",
    label: "טיוטות מוכנות",
    subtitle: "הבוט הכין — אתה שולח ללקוח",
    icon: "📝",
    iconBg: "var(--dz-success-bg)",
    iconColor: "var(--dz-success)",
  },
  {
    id: "follow_up",
    label: "חוזר לעדכן",
    subtitle: "שיחות שלא כדאי לשכוח",
    icon: "🔔",
    iconBg: "var(--dz-info-bg)",
    iconColor: "var(--dz-info)",
  },
  {
    id: "handoff",
    label: "מחכה לך",
    subtitle: "הבוט סיים — אתה ממשיך",
    icon: "→",
    iconBg: "var(--dz-surface-muted)",
    iconColor: "var(--dz-text-muted)",
  },
  {
    id: "drafts_ready",
    label: "ניסוח תגובות",
    subtitle: "טיוטות מוכנות לשליחה",
    icon: "✍️",
    iconBg: "var(--dz-brand-soft)",
    iconColor: "var(--dz-brand)",
  },
  {
    id: "closed",
    label: "נסגרו",
    subtitle: "היסטוריה ושיחות שטופלו",
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
