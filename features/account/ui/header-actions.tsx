"use client";

/**
 * The round header actions of Profile and the Settings hub. They carry the
 * app's own navigation icons (the same ones the bar / rail / sidebar draw), so
 * the header and the shell never show two different bells.
 */
import { NAV_DESTINATIONS } from "@/components/navigation/nav-destinations";
import { WarmRoundLink } from "@/components/ui/warm-surface/warm-surface";

import { useUnreadNotifications } from "../data/use-account-data";

function navIcon(key: "settings" | "notifications") {
  const destination = NAV_DESTINATIONS.find((d) => d.key === key);
  return destination ? destination.icon({ active: false }) : null;
}

export function SettingsAction() {
  return (
    <WarmRoundLink href="/settings" label="הגדרות">
      {navIcon("settings")}
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
      {navIcon("notifications")}
    </WarmRoundLink>
  );
}
