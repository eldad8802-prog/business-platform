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
import { he } from "@/lib/i18n/messages/he";
import { createTranslator, type MessageKey, type Translator } from "@/lib/i18n/translate";

import {
  SETTINGS_CATEGORIES,
  SETTINGS_GROUP_ORDER,
  SETTINGS_GROUP_TITLE_KEYS,
  type SettingsGroupKey,
} from "./settings-categories";

export const SUPPORT_EMAIL = "support@promaxgroup.co.il";

/** The hub's workspace row shows the active interface language (`localeNativeName`, lib/i18n). */

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

type ExtraRow = Omit<HubRow, "title" | "subtitle"> & { titleKey: MessageKey; subtitleKey?: MessageKey; subtitle?: string };

/** Hub rows that are not Settings sub-routes, appended to their group. */
const EXTRA_ROWS: Partial<Record<HubGroupKey, ExtraRow[]>> = {
  account: [
    {
      key: "subscription",
      titleKey: "account.settings.hub.subscription.title",
      subtitleKey: "account.settings.hub.subscription.subtitle",
      icon: "👑",
      href: null,
      badge: "soon",
    },
  ],
  preferences: [
    {
      key: "document-prefs",
      titleKey: "account.settings.hub.documentPrefs.title",
      subtitleKey: "account.settings.hub.documentPrefs.subtitle",
      icon: "📄",
      href: "/business",
    },
  ],
  help: [
    {
      key: "support",
      titleKey: "account.settings.hub.support.title",
      subtitle: SUPPORT_EMAIL,
      icon: "💬",
      href: `mailto:${SUPPORT_EMAIL}`,
      external: true,
    },
  ],
};

/** Without a translator the hub is Hebrew (tests, and the pre-i18n output). Screens pass useI18n().t. */
export function buildSettingsHub(t: Translator = createTranslator(he)): HubGroup[] {
  const extra = (key: HubGroupKey): HubRow[] =>
    (EXTRA_ROWS[key] ?? []).map(({ titleKey, subtitleKey, subtitle, ...row }) => ({
      ...row,
      title: t(titleKey),
      subtitle: subtitleKey ? t(subtitleKey) : (subtitle ?? ""),
    }));
  const groups: HubGroup[] = SETTINGS_GROUP_ORDER.map((key) => ({
    key,
    title: t(SETTINGS_GROUP_TITLE_KEYS[key]),
    tone: GROUP_TONE[key],
    rows: [
      ...SETTINGS_CATEGORIES.filter((c) => c.group === key).map<HubRow>((c) => ({
        key: c.key,
        title: t(c.titleKey),
        subtitle: t(c.descriptionKey),
        icon: c.icon,
        href: c.href,
        value: ROW_VALUE[c.key],
      })),
      ...extra(key),
    ],
  }));

  groups.push({ key: "help", title: t("account.settings.groups.help"), tone: GROUP_TONE.help, rows: extra("help") });
  return groups;
}
