import { SettingsSection } from "@/components/settings/SettingsSection";
import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import styles from "../settings-desk.module.css";
import { getServerI18n } from "@/lib/i18n/server";
import { PaymentConnectionCard } from "@/components/settings/PaymentConnectionCard";
import { IntegrationStatusCards } from "@/components/settings/IntegrationStatusCards";
import { AuthorityConnectionCard } from "@/components/settings/AuthorityConnectionCard";
import { LeadSourcesPanel } from "@/components/settings/LeadSourcesPanel";
import { StoresAndCallsPanel } from "@/components/settings/StoresAndCallsPanel";

export default async function SettingsConnectionsPage() {
  const { t } = await getServerI18n();
  return (
    <>
      <SettingsSubPageHeader title={t("account.settings.categories.connections.title")} />
      <div className={styles.cardGrid}>
        <PaymentConnectionCard />
        <AuthorityConnectionCard />
        <IntegrationStatusCards />
        <LeadSourcesPanel />
        <StoresAndCallsPanel />
      </div>
      <SettingsSection>
        <p className="text-sm leading-6 text-[var(--dz-text-muted)]">
          {t("account.settings.connections.page.footnote")}
        </p>
      </SettingsSection>
    </>
  );
}
