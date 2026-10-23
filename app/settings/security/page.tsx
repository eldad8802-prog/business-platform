import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { DevicesScreen } from "@/components/settings/security/devices-screen";
import { getServerI18n } from "@/lib/i18n/server";
import styles from "../settings-desk.module.css";

export default async function SettingsSecurityPage() {
  const { t } = await getServerI18n();
  return (
    <div className={styles.focused}>
      <SettingsSubPageHeader title={t("account.settings.categories.security.title")} />
      {/* A short list whose one action ends a session: kept at a reading
          measure on desktop so each "ניתוק" stays next to its device. */}
      <DevicesScreen />
    </div>
  );
}
