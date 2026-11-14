import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { NotificationPrivacyScreen } from "@/components/settings/notifications/NotificationPrivacyScreen";
import { NotificationCopyProvider } from "@/components/settings/notifications/copy/notification-copy";
import { getNotificationCopy } from "@/components/settings/notifications/copy/notification-copy-server";
import styles from "../../settings-desk.module.css";

/** הגדרות ← התראות ← פרטיות ושחזור הגדרות. Gated like the notifications page (the API answers 404 while off). */
export default async function SettingsNotificationPrivacyPage() {
  const { copy, t } = await getNotificationCopy();
  return (
    <div className={styles.focused}>
      <SettingsSubPageHeader
        title={t("notifications.privacy.title")}
        subtitle={t("notifications.privacy.subtitle")}
        backHref="/settings/notifications"
      />
      <NotificationCopyProvider copy={copy}>
        <NotificationPrivacyScreen />
      </NotificationCopyProvider>
    </div>
  );
}
