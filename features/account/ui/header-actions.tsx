"use client";

/**
 * The round header actions of Profile and the Settings hub. They carry the
 * shell's own navigation icons (the same ones the bar / rail / sidebar draw),
 * so the header and the shell never show two different bells.
 */
import { useI18n } from "@/components/i18n/I18nProvider";
import { IconBell, IconSettings } from "@/components/navigation/nav-icons";
import { WarmRoundLink } from "@/components/ui/warm-surface/warm-surface";

import { useUnreadNotifications } from "../data/use-account-data";

export function SettingsAction() {
  const { t } = useI18n();
  return (
    <WarmRoundLink href="/settings" label={t("nav.settings")}>
      <IconSettings size={20} strokeWidth={1.8} />
    </WarmRoundLink>
  );
}

export function NotificationsAction() {
  const hasUnread = useUnreadNotifications();
  const { t } = useI18n();
  return (
    <WarmRoundLink
      href="/notifications"
      label={t("nav.notifications")}
      alert={hasUnread}
      alertLabel={t("nav.a11y.unreadNotifications")}
    >
      <IconBell size={20} strokeWidth={1.8} />
    </WarmRoundLink>
  );
}
