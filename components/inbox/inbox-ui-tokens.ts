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
    iconBg: "#fee2e2",
    iconColor: "#dc2626",
  },
  {
    id: "hot_leads",
    label: "חם - הזדמנות",
    subtitle: "פניות עם סיכוי גבוה לעסקה",
    icon: "🔥",
    iconBg: "#ffedd5",
    iconColor: "#ea580c",
  },
  {
    id: "active",
    label: "ממתין לתשובת לקוח",
    subtitle: "שלחת — מחכים לתגובה",
    icon: "⏳",
    iconBg: "#fef9c3",
    iconColor: "#ca8a04",
  },
  {
    id: "bot_in_progress",
    label: "טיוטות מוכנות",
    subtitle: "הבוט הכין — אתה שולח ללקוח",
    icon: "📝",
    iconBg: "#dcfce7",
    iconColor: "#16a34a",
  },
  {
    id: "follow_up",
    label: "חוזר לעדכן",
    subtitle: "שיחות שלא כדאי לשכוח",
    icon: "🔔",
    iconBg: "#dbeafe",
    iconColor: "#2563eb",
  },
  {
    id: "handoff",
    label: "מחכה לך",
    subtitle: "הבוט סיים — אתה ממשיך",
    icon: "→",
    iconBg: "#f1f5f9",
    iconColor: "#64748b",
  },
  {
    id: "drafts_ready",
    label: "ניסוח תגובות",
    subtitle: "טיוטות מוכנות לשליחה",
    icon: "✍️",
    iconBg: "#ede9fe",
    iconColor: "#7c3aed",
  },
  {
    id: "closed",
    label: "נסגרו",
    subtitle: "היסטוריה ושיחות שטופלו",
    icon: "✓",
    iconBg: "#ecfdf5",
    iconColor: "#16a34a",
  },
] as const;

export function inboxCategoryVisual(id: InboxWorkCategoryId): InboxCategoryVisual | undefined {
  return INBOX_CATEGORY_VISUALS.find((row) => row.id === id);
}

export const INBOX_SURFACE = {
  pageBg: "#f3f4f6",
  cardBg: "#ffffff",
  chatBg: "#e9edf3",
  border: "rgba(15, 23, 42, 0.08)",
  shadow: "0 1px 3px rgba(15, 23, 42, 0.06)",
  shadowActive: "0 4px 14px rgba(99, 102, 241, 0.12)",
  purple: "#6366f1",
  purpleSoft: "#eef2ff",
  greenBubble: "#dcf8c6",
  greenBubbleBorder: "rgba(34, 197, 94, 0.18)",
} as const;
