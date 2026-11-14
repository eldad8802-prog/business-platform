import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { NotificationTypesScreen } from "@/components/settings/notifications/NotificationTypesScreen";
import { NotificationCopyProvider } from "@/components/settings/notifications/copy/notification-copy";
import { getNotificationCopy } from "@/components/settings/notifications/copy/notification-copy-server";
import styles from "../../settings-desk.module.css";

/** הגדרות ← התראות ← סוגי התראות. Gated like the notifications page (the API answers 404 while the feature is off). */
export default async function SettingsNotificationTypesPage() {
  const { copy, t } = await getNotificationCopy();
  return (
    <div className={styles.focused}>
      <SettingsSubPageHeader
        title={t("notifications.types.title")}
        subtitle={t("notifications.types.subtitle")}
        backHref="/settings/notifications"
      />
      <NotificationCopyProvider copy={copy}>
        <NotificationTypesScreen />
      </NotificationCopyProvider>
    </div>
  );
}
