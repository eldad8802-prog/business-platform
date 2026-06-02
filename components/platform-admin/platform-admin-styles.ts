import { TOKEN } from "@/lib/design/tokens";

export const PA = {
  pageBg: TOKEN.surface.page,
  cardBg: TOKEN.surface.card,
  border: TOKEN.border.DEFAULT,
  ink: TOKEN.ink.primary,
  inkSecondary: TOKEN.ink.secondary,
  inkMuted: TOKEN.ink.muted,
  inkMeta: TOKEN.ink.meta,
  urgent: TOKEN.semantic.urgent,
  attention: TOKEN.semantic.attention,
  success: TOKEN.semantic.success,
  info: TOKEN.semantic.info,
  maxWidth: 1120,
  radius: 10,
  gap: 16,
} as const;

export function severityColors(severity: string) {
  switch (severity) {
    case "critical":
      return PA.urgent;
    case "high":
      return PA.attention;
    case "medium":
      return PA.info;
    default:
      return {
        ink: PA.inkMuted,
        bg: TOKEN.surface.inset,
        bgSoft: TOKEN.surface.inset,
        border: PA.border,
        accent: PA.inkMuted,
      };
  }
}

export function categoryLabel(category: string): string {
  switch (category) {
    case "billing":
      return "חשבוניות";
    case "documents":
      return "מסמכים";
    case "content":
      return "תוכן";
    case "integrations":
      return "אינטגרציות";
    case "platform":
      return "מערכת";
    case "inbox":
      return "תיבה";
    case "onboarding":
      return "הטמעה";
    case "usage":
      return "שימוש";
    default:
      return category;
  }
}
