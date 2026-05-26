export type SettingsCategory = {
  key: string;
  href: string;
  title: string;
  description: string;
  icon: string;
};

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    key: "workspace",
    href: "/settings/workspace",
    title: "סביבת עבודה",
    description: "שפה, אזור זמן ומטבע — יוגדרו בהמשך",
    icon: "🧭",
  },
  {
    key: "team",
    href: "/settings/team",
    title: "צוות והרשאות",
    description: "משתמשים והרשאות — יוגדרו בהמשך",
    icon: "👥",
  },
  {
    key: "connections",
    href: "/settings/connections",
    title: "חיבורים",
    description: "אינטגרציות וחשבונות מקושרים — יוגדרו בהמשך",
    icon: "🔌",
  },
  {
    key: "security",
    href: "/settings/security",
    title: "אבטחה",
    description: "הגנת חשבון ומדיניות — יוגדרו בהמשך",
    icon: "🔐",
  },
  {
    key: "billing",
    href: "/settings/billing",
    title: "מנוי וחיוב",
    description: "תוכנית ותשלומים — יוגדרו בהמשך",
    icon: "💳",
  },
  {
    key: "ai",
    href: "/settings/ai",
    title: "הרשאות AI",
    description: "הרשאות מערכתיות לשימוש ב־AI — יוגדרו בהמשך",
    icon: "🤖",
  },
];
