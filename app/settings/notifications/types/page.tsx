import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { NotificationTypesScreen } from "@/components/settings/notifications/NotificationTypesScreen";
import { getServerI18n } from "@/lib/i18n/server";
import styles from "../../settings-desk.module.css";

/** הגדרות ← התראות ← סוגי התראות. Gated like the notifications page (the API answers 404 while the feature is off). */
export default async function SettingsNotificationTypesPage() {
  const { t } = await getServerI18n();
  return (
    <div className={styles.focused}>
      <SettingsSubPageHeader
        title={t("notifications.types.title")}
        subtitle={t("notifications.types.subtitle")}
        backHref="/settings/notifications"
      />
      <NotificationTypesScreen />
    </div>
  );
}
