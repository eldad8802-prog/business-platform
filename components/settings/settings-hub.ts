/**
 * The Settings hub's information architecture: five groups of rows, in the
 * order of the approved reference.
 *
 * Rows for Settings areas come from SETTINGS_CATEGORIES (same title, icon and
 * route as the desktop rail). A few hub rows lead outside the Settings tree;
 * they are listed here, each with the reason it is real:
 *
 *   document-prefs  /business holds the document template, signature, payment
 *                   and footer lines. (Not "digital signature": the signature
 *                   is an image stamped on documents.)
 *   subscription    owner decision — the area is kept for the coming plans, as a
 *                   static "בקרוב" row with no destination. It must never link
 *                   anywhere until a real subscription exists.
 *   support         the real support channel: the support mailbox.
 *
 * Not here, because Dubiz has no such capability: business management /
 * switching, team & permissions, notification preferences, connected-app
 * grants, a help center, password change / 2FA, data-retention controls.
 */
import type { WarmTone } from "@/components/ui/warm-surface/warm-surface";

import {
  SETTINGS_CATEGORIES,
  SETTINGS_GROUP_ORDER,
  SETTINGS_GROUP_TITLES,
  type SettingsGroupKey,
} from "./settings-categories";

export const SUPPORT_EMAIL = "support@promaxgroup.co.il";

/** The workspace screen states this as read-only fact: Dubiz runs in Hebrew. */
export const WORKSPACE_LANGUAGE_LABEL = "עברית";

/** Live values a row can show, resolved by the hub screen from real data. */
export type HubRowValue = "workspace-language" | "active-connections";

export type HubRow = {
  key: string;
  title: string;
  subtitle: string;
  icon: string;
  /** null = a static row (only the reserved subscription area). */
  href: string | null;
  external?: boolean;
  value?: HubRowValue;
  /** A status pill in place of a value. */
  badge?: "soon";
};

export type HubGroupKey = SettingsGroupKey | "help";

export type HubGroup = {
  key: HubGroupKey;
  title: string;
  tone: WarmTone;
  rows: HubRow[];
};

const GROUP_TONE: Record<HubGroupKey, WarmTone> = {
  account: "teal",
  preferences: "violet",
  security: "amber",
  connections: "blue",
  help: "stone",
};

const ROW_VALUE: Partial<Record<string, HubRowValue>> = {
  workspace: "workspace-language",
  connections: "active-connections",
};

/** Hub rows that are not Settings sub-routes, appended to their group. */
const EXTRA_ROWS: Partial<Record<HubGroupKey, HubRow[]>> = {
  account: [
    {
      key: "subscription",
      title: "תוכנית המנוי",
      subtitle: "תוכניות המנוי של Dubiz",
      icon: "👑",
      href: null,
      badge: "soon",
    },
  ],
  preferences: [
    {
      key: "document-prefs",
      title: "העדפות מסמכים",
      subtitle: "תבנית, חתימה ופרטים במסמכים",
      icon: "📄",
      href: "/business",
    },
  ],
  help: [
    {
      key: "support",
      title: "פנייה לתמיכה",
      subtitle: SUPPORT_EMAIL,
      icon: "💬",
      href: `mailto:${SUPPORT_EMAIL}`,
      external: true,
    },
  ],
};

export function buildSettingsHub(): HubGroup[] {
  const groups: HubGroup[] = SETTINGS_GROUP_ORDER.map((key) => ({
    key,
    title: SETTINGS_GROUP_TITLES[key],
    tone: GROUP_TONE[key],
    rows: [
      ...SETTINGS_CATEGORIES.filter((c) => c.group === key).map<HubRow>((c) => ({
        key: c.key,
        title: c.title,
        subtitle: c.description,
        icon: c.icon,
        href: c.href,
        value: ROW_VALUE[c.key],
      })),
      ...(EXTRA_ROWS[key] ?? []),
    ],
  }));

  groups.push({ key: "help", title: "עזרה ותמיכה", tone: GROUP_TONE.help, rows: EXTRA_ROWS.help ?? [] });
  return groups;
}
