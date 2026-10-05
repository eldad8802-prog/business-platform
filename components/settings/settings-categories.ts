import { IMPORT_EXPORT_SETTINGS_CATEGORY } from "./import-export/import-export-release";

/**
 * The Settings areas, grouped the way the owner looks for them. The hub
 * (settings-hub.ts) and the desktop rail both read these groups, so a row and
 * its rail entry can never disagree about where it lives.
 */
export type SettingsGroupKey = "account" | "preferences" | "security" | "connections";

export type SettingsCategory = {
  key: string;
  href: string;
  title: string;
  description: string;
  /** The existing colourful Dubiz icon for this area. Keep it — owner decision. */
  icon: string;
  group: SettingsGroupKey;
};

// Only active categories appear here. A category is listed only when it
// shows real information, allows a real action, or links to an owner screen
// that solves a real need. Not-yet-ready capabilities are not shown at all.
//
// Wording states only what the screen behind the row really does: security is
// devices and sign-in (there is no password change or 2FA for owners), privacy
// is export and deletion (there is no retention control).
export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    key: "business",
    href: "/settings/business",
    title: "פרטי העסק",
    description: "שם, תחום ופרטי התקשרות",
    icon: "🏢",
    group: "account",
  },
  {
    key: "team",
    href: "/settings/team",
    title: "החשבון שלי",
    description: "הפרטים שלך, העסק המחובר והתנתקות",
    icon: "👤",
    group: "account",
  },
  // Listed as of I-3, when Export became a real capability. The definition
  // lives in `import-export/import-export-release.ts` (which imports only the
  // TYPE from here, so there is no runtime cycle); listing it in THIS array is
  // the single reviewable act of releasing the feature, and the foundation
  // verifier fails the build if this row and the release flag ever disagree.
  IMPORT_EXPORT_SETTINGS_CATEGORY,
  {
    key: "workspace",
    href: "/settings/workspace",
    title: "שפה ואזור",
    description: "שפה, מטבע ואזור זמן",
    icon: "🌍",
    group: "preferences",
  },
  // Listed now that it shows real information and allows a real action: the
  // devices signed in to this account, and ending any one of them.
  {
    key: "security",
    href: "/settings/security",
    title: "אבטחת חשבון",
    description: "המכשירים המחוברים והכניסה לחשבון",
    icon: "🛡️",
    group: "security",
  },
  {
    key: "account-privacy",
    href: "/settings/account",
    title: "פרטיות",
    description: "ייצוא המידע ומחיקת החשבון",
    icon: "🔒",
    group: "security",
  },
  {
    key: "connections",
    href: "/settings/connections",
    title: "חיבורים",
    description: "WhatsApp, Gmail, סליקה, רשות המסים ולידים",
    icon: "🔌",
    group: "connections",
  },
];

export const SETTINGS_GROUP_TITLES: Record<SettingsGroupKey, string> = {
  account: "החשבון והעסק",
  preferences: "העדפות ואפליקציה",
  security: "אבטחה ופרטיות",
  connections: "חיבורים ואינטגרציות",
};

export const SETTINGS_GROUP_ORDER: SettingsGroupKey[] = ["account", "preferences", "security", "connections"];
