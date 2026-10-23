import { he } from "@/lib/i18n/messages/he";
import { createTranslator, type MessageKey } from "@/lib/i18n/translate";

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
  /** The Hebrew title / description (tests and server copy quote them); screens render the keys. */
  title: string;
  description: string;
  titleKey: MessageKey;
  descriptionKey: MessageKey;
  /** The existing colourful Dubiz icon for this area. Keep it — owner decision. */
  icon: string;
  group: SettingsGroupKey;
};

/** Hebrew text comes from the dictionary, so a category's `title` and its `titleKey` can never disagree. */
const heT = createTranslator(he);
function category(c: Omit<SettingsCategory, "title" | "description">): SettingsCategory {
  return { ...c, title: heT(c.titleKey), description: heT(c.descriptionKey) };
}

// Only active categories appear here. A category is listed only when it
// shows real information, allows a real action, or links to an owner screen
// that solves a real need. Not-yet-ready capabilities are not shown at all.
//
// Wording states only what the screen behind the row really does: security is
// devices and sign-in (there is no password change or 2FA for owners), privacy
// is export and deletion (there is no retention control).
export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  category({
    key: "business",
    href: "/settings/business",
    titleKey: "account.settings.categories.business.title",
    descriptionKey: "account.settings.categories.business.description",
    icon: "🏢",
    group: "account",
  }),
  category({
    key: "team",
    href: "/settings/team",
    titleKey: "account.settings.categories.team.title",
    descriptionKey: "account.settings.categories.team.description",
    icon: "👤",
    group: "account",
  }),
  // Listed as of I-3, when Export became a real capability. The definition
  // lives in `import-export/import-export-release.ts` (which imports only the
  // TYPE from here, so there is no runtime cycle); listing it in THIS array is
  // the single reviewable act of releasing the feature, and the foundation
  // verifier fails the build if this row and the release flag ever disagree.
  IMPORT_EXPORT_SETTINGS_CATEGORY,
  category({
    key: "workspace",
    href: "/settings/workspace",
    titleKey: "settingsLocale.categoryTitle",
    // Not settingsLocale.categoryDescription: that text differs ("שפת המערכת"), and this row's Hebrew must not change.
    descriptionKey: "account.settings.categories.workspace.description",
    icon: "🌍",
    group: "preferences",
  }),
  // Listed now that it shows real information and allows a real action: the
  // devices signed in to this account, and ending any one of them.
  category({
    key: "security",
    href: "/settings/security",
    titleKey: "account.settings.categories.security.title",
    descriptionKey: "account.settings.categories.security.description",
    icon: "🛡️",
    group: "security",
  }),
  category({
    key: "account-privacy",
    href: "/settings/account",
    titleKey: "account.settings.categories.accountPrivacy.title",
    descriptionKey: "account.settings.categories.accountPrivacy.description",
    icon: "🔒",
    group: "security",
  }),
  category({
    key: "connections",
    href: "/settings/connections",
    titleKey: "account.settings.categories.connections.title",
    descriptionKey: "account.settings.categories.connections.description",
    icon: "🔌",
    group: "connections",
  }),
];

export const SETTINGS_GROUP_TITLE_KEYS: Record<SettingsGroupKey, MessageKey> = {
  account: "account.settings.groups.account",
  preferences: "account.settings.groups.preferences",
  security: "account.settings.groups.security",
  connections: "account.settings.groups.connections",
};

/** Hebrew group titles (from the dictionary). */
export const SETTINGS_GROUP_TITLES: Record<SettingsGroupKey, string> = {
  account: heT(SETTINGS_GROUP_TITLE_KEYS.account),
  preferences: heT(SETTINGS_GROUP_TITLE_KEYS.preferences),
  security: heT(SETTINGS_GROUP_TITLE_KEYS.security),
  connections: heT(SETTINGS_GROUP_TITLE_KEYS.connections),
};

export const SETTINGS_GROUP_ORDER: SettingsGroupKey[] = ["account", "preferences", "security", "connections"];
