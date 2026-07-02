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
    description: "שפה, כיווניות, מטבע ואזור זמן",
    icon: "🧭",
  },
  {
    key: "team",
    href: "/settings/team",
    title: "צוות והרשאות",
    description: "פרטי המשתמש והעסק המחוברים",
    icon: "👥",
  },
  {
    key: "connections",
    href: "/settings/connections",
    title: "חיבורים",
    description: "מצב חיבורי סליקה, וואטסאפ ו-Gmail",
    icon: "🔌",
  },
  {
    key: "security",
    href: "/settings/security",
    title: "אבטחה",
    description: "התנתקות והגנת חשבון",
    icon: "🔐",
  },
  {
    key: "billing",
    href: "/settings/billing",
    title: "מנוי וחיוב",
    description: "מנוי Dubiz וחיוב המערכת — בקרוב",
    icon: "💳",
  },
  {
    key: "ai",
    href: "/settings/ai",
    title: "הרשאות AI",
    description: "הרשאות AI גלובליות ברמת המערכת — בקרוב",
    icon: "🤖",
  },
];
