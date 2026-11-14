import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { NotificationsMainScreen } from "@/components/settings/notifications/NotificationsMainScreen";
import { NotificationCopyProvider } from "@/components/settings/notifications/copy/notification-copy";
import { getNotificationCopy } from "@/components/settings/notifications/copy/notification-copy-server";
import styles from "../settings-desk.module.css";

/**
 * הגדרות ← התראות (approved design, Gate B 2026-11-13).
 *
 * The notifications engine is a per-business feature (`notifications_engine`), so the gate is the API: its
 * session routes answer 404 while the feature is off, and the screen then shows a calm "not available yet". The
 * Settings row itself is listed only once the business's capabilities say the feature is on
 * (components/settings/settings-categories.ts featureKey).
 */
export default async function SettingsNotificationsPage() {
  const { copy, t } = await getNotificationCopy();
  return (
    <div className={styles.focused}>
      <SettingsSubPageHeader title={t("notifications.page.title")} subtitle={t("notifications.page.subtitle")} />
      <NotificationCopyProvider copy={copy}>
        <NotificationsMainScreen />
      </NotificationCopyProvider>
    </div>
  );
}
