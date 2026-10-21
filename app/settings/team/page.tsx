import { SettingsSection } from "@/components/settings/SettingsSection";
import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { AccountSummaryCard } from "@/components/settings/AccountSummaryCard";
import { LogoutButton } from "@/components/settings/LogoutButton";
import { getServerI18n } from "@/lib/i18n/server";
import styles from "../settings-desk.module.css";

export default async function SettingsAccountPage() {
  const { t } = await getServerI18n();
  return (
    <div className={styles.focused}>
      <SettingsSubPageHeader title={t("account.settings.categories.team.title")} />
      <div className="mb-4">
        <AccountSummaryCard />
      </div>
      <SettingsSection title={t("account.settings.logout.label")}>
        <p className="text-sm leading-6 text-[var(--dz-text-muted)]">{t("account.settings.logout.description")}</p>
        <div className="mt-3">
          <LogoutButton />
        </div>
      </SettingsSection>
    </div>
  );
}
