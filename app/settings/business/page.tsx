import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { BusinessSummaryCard } from "@/components/settings/BusinessSummaryCard";
import { getServerI18n } from "@/lib/i18n/server";
import styles from "../settings-desk.module.css";

export default async function SettingsBusinessPage() {
  const { t } = await getServerI18n();
  return (
    <div className={styles.focused}>
      <SettingsSubPageHeader title={t("account.settings.categories.business.title")} />
      <BusinessSummaryCard />
    </div>
  );
}
