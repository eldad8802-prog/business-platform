import { LocaleSettingsForm } from "@/components/settings/locale/LocaleSettingsForm";
import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { isI18nEnabled } from "@/lib/i18n/config";
import { getServerI18n } from "@/lib/i18n/server";
import styles from "../settings-desk.module.css";

/** הגדרות ← שפה, אזור ומטבע. */
export default async function SettingsWorkspacePage() {
  const { t } = await getServerI18n();
  return (
    <div className={styles.focused}>
      <SettingsSubPageHeader title={t("settingsLocale.title")} />
      <LocaleSettingsForm languageSwitchEnabled={isI18nEnabled()} />
    </div>
  );
}
