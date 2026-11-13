import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { NotificationPrivacyScreen } from "@/components/settings/notifications/NotificationPrivacyScreen";
import { getServerI18n } from "@/lib/i18n/server";
import styles from "../../settings-desk.module.css";

/** הגדרות ← התראות ← פרטיות ושחזור הגדרות. Gated like the notifications page (the API answers 404 while off). */
export default async function SettingsNotificationPrivacyPage() {
  const { t } = await getServerI18n();
  return (
    <div className={styles.focused}>
      <SettingsSubPageHeader
        title={t("notifications.privacy.title")}
        subtitle={t("notifications.privacy.subtitle")}
        backHref="/settings/notifications"
      />
      <NotificationPrivacyScreen />
    </div>
  );
}
