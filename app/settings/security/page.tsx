import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { DevicesScreen } from "@/components/settings/security/devices-screen";
import { GoogleConnection } from "@/components/settings/security/google-connection";
import { isGoogleLoginEnabled } from "@/lib/auth/google-oauth";
import { getServerI18n } from "@/lib/i18n/server";
import styles from "../settings-desk.module.css";

export const dynamic = "force-dynamic";

export default async function SettingsSecurityPage() {
  const { t } = await getServerI18n();
  return (
    <div className={styles.focused}>
      <SettingsSubPageHeader title={t("account.settings.categories.security.title")} />
      {/* "Continue with Google": the account's own link and its disconnect — only while the feature is on. */}
      {isGoogleLoginEnabled() ? (
        <div className="mb-6">
          <GoogleConnection />
        </div>
      ) : null}
      {/* A short list whose one action ends a session: kept at a reading
          measure on desktop so each "ניתוק" stays next to its device. */}
      <DevicesScreen />
    </div>
  );
}
