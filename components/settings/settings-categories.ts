import { IMPORT_EXPORT_SETTINGS_CATEGORY } from "./import-export/import-export-release";

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
  {
    key: "account-privacy",
    href: "/settings/account",
    title: "חשבון ופרטיות",
    description: "מחיקת חשבון והמידע שלך",
    icon: "🔒",
  },
  // Listed as of I-3, when Export became a real capability. The definition
  // lives in `import-export/import-export-release.ts` (which imports only the
  // TYPE from here, so there is no runtime cycle); listing it in THIS array is
  // the single reviewable act of releasing the feature, and the foundation
  // verifier fails the build if this row and the release flag ever disagree.
  IMPORT_EXPORT_SETTINGS_CATEGORY,
];
