export type SettingsCategory = {
  key: string;
  href: string;
  title: string;
  description: string;
  icon: string;
};

// Only active categories appear here. A category is listed only when it
// shows real information, allows a real action, or links to an owner screen
// that solves a real need. Not-yet-ready capabilities are not shown at all.
export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    key: "team",
    href: "/settings/team",
    title: "החשבון שלי",
    description: "הפרטים שלך, העסק המחובר, והתנתקות",
    icon: "👤",
  },
  {
    key: "business",
    href: "/settings/business",
    title: "העסק שלי",
    description: "שם, תחום וכתובת העסק",
    icon: "🏢",
  },
  {
    key: "connections",
    href: "/settings/connections",
    title: "חיבורים",
    description: "מה מחובר — סליקה, וואטסאפ ו-Gmail",
    icon: "🔌",
  },
  {
    key: "workspace",
    href: "/settings/workspace",
    title: "שפה ואזור",
    description: "שפה, מטבע ואזור זמן",
    icon: "🌍",
  },
];
