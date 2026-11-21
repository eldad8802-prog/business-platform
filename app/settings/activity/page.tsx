import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { getServerI18n } from "@/lib/i18n/server";

import { ActivitySettingsScreen } from "./activity-settings-screen";
import styles from "../settings-desk.module.css";

/**
 * הגדרות ← תחומי הפעילות (phase 2, owner-approved design): add or remove activity packs and change the main one.
 * The Settings row is listed only once the business's capabilities say `activity_packs` is ON
 * (components/settings/settings-categories.ts featureKey); the API answers 404 otherwise and the screen says so.
 */
export default async function SettingsActivityPage() {
  const { t } = await getServerI18n();
  return (
    <div className={styles.focused}>
      <SettingsSubPageHeader title={t("account.settings.activityPacks.settingsTitle")} subtitle={t("account.settings.activityPacks.settingsSubtitle")} />
      <ActivitySettingsScreen />
    </div>
  );
}
