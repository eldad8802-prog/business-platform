"use client";

/**
 * The round header actions of Profile and the Settings hub. They carry the
 * shell's own navigation icons (the same ones the bar / rail / sidebar draw),
 * so the header and the shell never show two different bells.
 */
import { IconBell, IconSettings } from "@/components/navigation/nav-icons";
import { WarmRoundLink } from "@/components/ui/warm-surface/warm-surface";

import { useUnreadNotifications } from "../data/use-account-data";

export function SettingsAction() {
  return (
    <WarmRoundLink href="/settings" label="הגדרות">
      <IconSettings size={20} strokeWidth={1.8} />
    </WarmRoundLink>
  );
}

export function NotificationsAction() {
  const hasUnread = useUnreadNotifications();
  return (
    <WarmRoundLink
      href="/notifications"
      label="התראות"
      alert={hasUnread}
      alertLabel="יש התראות שלא נקראו"
    >
      <IconBell size={20} strokeWidth={1.8} />
    </WarmRoundLink>
  );
}
